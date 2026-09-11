#!/bin/sh
# Container-based test harness for deploy/entrypoint.sh's state machine.
#
# Three review rounds each found a defect in a branch that only runs after
# something else already failed: an unreadable state copy, a corrupt copy, a
# skipped restore, a lock that cannot be taken. None of that is reachable by
# `dash -n` or shellcheck (the `shell` CI job), so this script boots the real
# image under real failure conditions and asserts on the state machine's
# observable effects only: files on the state volume, rows in Grafana's
# SQLite database, and lines in the container log. It never asserts on
# lakehouse connectivity -- QUIXLAKE_URL/QUIXLAKE_TOKEN below are dummy values
# and the datasource health check is expected to fail; that is fine.
#
# Usage: entrypoint-test.sh [image-tag]   (default: quixlakehouse-grafana:test)
#
# POSIX sh, portable to the Linux CI runner. On Windows/Git Bash, invoke with
# MSYS_NO_PATHCONV=1 so the MSYS layer does not rewrite container-absolute
# paths (e.g. "myvolume:/state") passed to docker.exe. State lives entirely in
# named docker volumes, never host bind mounts, so no host path ever reaches
# a docker command and no cygpath conversion is needed anywhere in this file.
# Git Bash on Windows rewrites container-absolute paths like /var/lib/grafana into
# host paths (C:/Apps/Git/var/...), which makes every docker exec in this suite fail
# with errors that look like product defects. Harmless and ignored on Linux, where CI
# runs it.
MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

set -eu

IMAGE="${1:-quixlakehouse-grafana:test}"
PREFIX="qlhtest$$"

LIVE_DB=/var/lib/grafana/grafana.db
STATE_MOUNT=/state
STATE_DB="${STATE_MOUNT}/grafana/grafana.db"
DATASOURCE_UID=quixlakehouse

CONTAINERS=""
VOLUMES=""
TOTAL_PASS=0
TOTAL_FAIL=0

# ---------------------------------------------------------------------------
# Cleanup: every container and volume this run created, on any exit path.
# ---------------------------------------------------------------------------
cleanup() {
  for c in $CONTAINERS; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  for v in $VOLUMES; do
    docker volume rm -f "$v" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

# new_volume SHORTNAME -- leaves the full volume name in $REPLY.
#
# Deliberately NOT invoked as `x=$(new_volume ...)`: command substitution
# forks a subshell, and the append to $VOLUMES below would then be lost the
# instant that subshell exits, leaving the exit trap's safety net with
# nothing to remove. Every leftover volume from an early version of this
# script traced back to exactly that. Call it as a plain statement and read
# $REPLY immediately after.
new_volume() {
  REPLY="${PREFIX}-vol-$1"
  VOLUMES="$VOLUMES $REPLY"
}

# start CNAME [VOLUME] -- EXTRA_DOCKER_ARGS...
# Starts a detached container named "${PREFIX}-${CNAME}" and leaves its full
# name in $REPLY (see new_volume for why this is not a command substitution).
# If VOLUME is non-empty it is mounted at /state and
# Quix__Deployment__State__Path is set to it. Anything after "--" is passed
# straight to `docker run` before the image name (additional -e flags,
# mainly).
start() {
  short="$1"
  vol="$2"
  shift 2
  if [ "${1:-}" = "--" ]; then shift; fi
  cname="${PREFIX}-${short}"
  if [ -n "$vol" ]; then
    docker run -d --name "$cname" \
      -v "${vol}:${STATE_MOUNT}" \
      -e "Quix__Deployment__State__Path=${STATE_MOUNT}" \
      -e QUIXLAKE_URL=http://example.invalid \
      -e QUIXLAKE_TOKEN=dummy-token \
      "$@" \
      "$IMAGE" >/dev/null
  else
    docker run -d --name "$cname" \
      -e QUIXLAKE_URL=http://example.invalid \
      -e QUIXLAKE_TOKEN=dummy-token \
      "$@" \
      "$IMAGE" >/dev/null
  fi
  CONTAINERS="$CONTAINERS $cname"
  REPLY="$cname"
}

# stop CNAME -- stops (does not remove) a container, preserving its
# container-local disk (and therefore LIVE_DB) for a later `docker start` on
# the same name. Used by the "restart in place" scenario.
stop() {
  docker stop -t 5 "$1" >/dev/null 2>&1 || true
}

# destroy CNAME -- removes a container outright. Its named volume (if any)
# survives, since the volume is never removed by this call.
destroy() {
  docker rm -f "$1" >/dev/null 2>&1 || true
}

# run_helper VOLUME SHELL_CMD -- runs SHELL_CMD in a throwaway container of
# the same image with VOLUME mounted at /state, entrypoint overridden to a
# plain shell. Used to inspect or mutate the state volume directly (truncate
# a copy, delete a row, count quarantine files) without needing a live
# Grafana container using that volume.
run_helper() {
  docker run --rm -v "${1}:${STATE_MOUNT}" --entrypoint sh "$IMAGE" -c "$2"
}

# sql CNAME DBPATH QUERY -- runs a single statement against DBPATH inside
# CNAME via sqlite3, with the same busy timeout the entrypoint itself uses.
sql() {
  docker exec "$1" sqlite3 -cmd '.timeout 8000' "$2" "$3" 2>/dev/null
}

wait_healthy() {
  # Polls Grafana's own health endpoint from inside the container, up to 60s.
  cname="$1"
  i=0
  while [ "$i" -lt 30 ]; do
    if docker exec "$cname" wget -q -O /dev/null http://127.0.0.1:3000/api/health 2>/dev/null; then
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  return 1
}

wait_datasource() {
  # Polls until the datasource row exists in LIVE_DB, up to ~20s: provisioning
  # can commit a moment after the health endpoint starts answering.
  cname="$1"
  i=0
  while [ "$i" -lt 10 ]; do
    if [ "$(sql "$cname" "$LIVE_DB" "SELECT 1 FROM data_source WHERE uid='${DATASOURCE_UID}' LIMIT 1;")" = "1" ]; then
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  return 1
}

# ---------------------------------------------------------------------------
# Assertions. Each records the first failure reason into SCEN_REASON and
# flips SCEN_OK to 0; scenarios print exactly one PASS/FAIL line at the end.
# ---------------------------------------------------------------------------
SCEN_OK=1
SCEN_REASON=""

scen_fail() {
  if [ "$SCEN_OK" = "1" ]; then
    SCEN_REASON="$1"
  fi
  SCEN_OK=0
}

assert_file() {
  # assert_file CNAME PATH DESC
  if ! docker exec "$1" test -f "$2" 2>/dev/null; then
    scen_fail "$3 (missing $2)"
    return 1
  fi
  return 0
}

assert_no_file() {
  # assert_no_file CNAME PATH DESC
  if docker exec "$1" test -e "$2" 2>/dev/null; then
    scen_fail "$3 (unexpectedly present: $2)"
    return 1
  fi
  return 0
}

assert_log() {
  # assert_log CNAME PATTERN DESC -- fixed-string match against combined
  # stdout/stderr container logs.
  if ! docker logs "$1" 2>&1 | grep -F -q "$2"; then
    scen_fail "$3 (log missing: '$2')"
    return 1
  fi
  return 0
}

report() {
  name="$1"
  if [ "$SCEN_OK" = "1" ]; then
    TOTAL_PASS=$((TOTAL_PASS + 1))
    printf 'PASS: %s -- ok\n' "$name"
  else
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    printf 'FAIL: %s -- %s\n' "$name" "$SCEN_REASON"
  fi
}

# ===========================================================================
# Scenario 1: no state path -- healthy, warns persistence is off, does not
# exit. Guards against the warning-not-fatal contract regressing to fatal.
# ===========================================================================
scenario_1() {
  SCEN_OK=1
  SCEN_REASON=""
  start s1 ""
  c="$REPLY"

  if ! wait_healthy "$c"; then
    scen_fail "never became healthy"
  else
    assert_log "$c" "persistence is OFF" "expected persistence-off warning"
    if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" != "true" ]; then
      scen_fail "container exited instead of staying up"
    fi
  fi

  destroy "$c"
  report "1 no state path"
}

# ===========================================================================
# Scenario 2: cold boot -- healthy, seeds the datasource, and a snapshot
# lands on the state volume within one backup interval.
# ===========================================================================
scenario_2() {
  SCEN_OK=1
  SCEN_REASON=""
  new_volume s2
  vol="$REPLY"
  start s2 "$vol"
  c="$REPLY"

  if ! wait_healthy "$c"; then
    scen_fail "never became healthy"
  else
    assert_log "$c" "the datasource is seeded from the" "expected cold-boot seed message"
    if ! wait_datasource "$c"; then
      scen_fail "datasource row never appeared"
    fi
    sleep 13
    assert_file "$c" "$STATE_DB" "expected snapshot on state volume"
    ic=$(sql "$c" "$STATE_DB" "PRAGMA integrity_check;")
    if [ "$ic" != "ok" ]; then
      scen_fail "state copy failed integrity_check: $ic"
    fi
  fi

  destroy "$c"
  report "2 cold boot"
}

# ===========================================================================
# Scenario 3: warm restore keeps a UI edit -- a second container on the same
# volume restores the database instead of re-seeding it, so an edit made
# through "the UI" (here, a direct SQL UPDATE standing in for it) survives.
# ===========================================================================
scenario_3() {
  SCEN_OK=1
  SCEN_REASON=""
  new_volume s3
  vol="$REPLY"
  start s3a "$vol"
  c1="$REPLY"

  if ! wait_healthy "$c1" || ! wait_datasource "$c1"; then
    scen_fail "first boot never became healthy/seeded"
    destroy "$c1"
    report "3 warm restore keeps UI edit"
    return
  fi

  docker exec "$c1" sqlite3 -cmd '.timeout 8000' "$LIVE_DB" \
    "UPDATE data_source SET url='http://edited.invalid' WHERE uid='${DATASOURCE_UID}';" >/dev/null
  sleep 13
  destroy "$c1"

  start s3b "$vol"
  c2="$REPLY"
  if ! wait_healthy "$c2"; then
    scen_fail "second boot never became healthy"
  else
    assert_log "$c2" "restored Grafana database from" "expected restore message"
    assert_log "$c2" "NOT rendering the provisioning template" "expected seed-skip message"
    url=$(sql "$c2" "$LIVE_DB" "SELECT url FROM data_source WHERE uid='${DATASOURCE_UID}';")
    if [ "$url" != "http://edited.invalid" ]; then
      scen_fail "UI edit lost: url is '$url'"
    fi
  fi

  destroy "$c2"
  report "3 warm restore keeps UI edit"
}

# ===========================================================================
# Scenario 4: a restored database with no datasource row (deleted in the UI,
# or a copy taken before the row was ever committed) is re-seeded, and the
# row exists again afterwards. Reuses scenario 3's volume, per the brief.
# ===========================================================================
scenario_4() {
  SCEN_OK=1
  SCEN_REASON=""
  new_volume s3
  vol="$REPLY"
  start s4a "$vol"
  c1="$REPLY"

  if ! wait_healthy "$c1" || ! wait_datasource "$c1"; then
    scen_fail "seed boot never became healthy/seeded"
    destroy "$c1"
    report "4 restored db with no datasource row"
    return
  fi
  sleep 13
  destroy "$c1"

  run_helper "$vol" "sqlite3 -cmd '.timeout 8000' '${STATE_DB}' \"DELETE FROM data_source WHERE uid='${DATASOURCE_UID}';\"" >/dev/null

  start s4b "$vol"
  c2="$REPLY"
  if ! wait_healthy "$c2"; then
    scen_fail "second boot never became healthy"
  else
    assert_log "$c2" "the restored database has NO datasource uid=${DATASOURCE_UID}" "expected no-datasource message"
    if ! wait_datasource "$c2"; then
      scen_fail "datasource row was not re-seeded"
    fi
  fi

  destroy "$c2"
  report "4 restored db with no datasource row"
}

# ===========================================================================
# Scenario 5: a corrupt state copy is quarantined, never restored, and a
# fresh snapshot replaces it.
# ===========================================================================
scenario_5() {
  SCEN_OK=1
  SCEN_REASON=""
  new_volume s5
  vol="$REPLY"
  start s5a "$vol"
  c1="$REPLY"

  if ! wait_healthy "$c1"; then
    scen_fail "first boot never became healthy"
    destroy "$c1"
    report "5 corrupt copy quarantined"
    return
  fi
  sleep 13
  destroy "$c1"

  run_helper "$vol" "sz=\$(stat -c %s '${STATE_DB}'); truncate -s \$((sz / 3)) '${STATE_DB}'" >/dev/null

  start s5b "$vol"
  c2="$REPLY"
  if ! wait_healthy "$c2"; then
    scen_fail "second boot never became healthy"
  else
    assert_log "$c2" "FAILED PRAGMA integrity_check and was NOT" "expected corrupt-copy warning"
    n=$(docker exec "$c2" sh -c "ls ${STATE_DB}.corrupt-* 2>/dev/null | wc -l" | tr -d ' ')
    if [ "${n:-0}" -lt 1 ]; then
      scen_fail "no grafana.db.corrupt-* quarantine file found"
    fi
    sleep 13
    assert_file "$c2" "$STATE_DB" "expected a fresh snapshot to replace the corrupt copy"
    ic=$(sql "$c2" "$STATE_DB" "PRAGMA integrity_check;")
    if [ "$ic" != "ok" ]; then
      scen_fail "fresh snapshot failed integrity_check: $ic"
    fi
  fi

  destroy "$c2"
  report "5 corrupt copy quarantined"
}

# ===========================================================================
# Scenario 6: the round-3 regression. A rescued local database
# (grafana.db.previous) must survive the NEXT clean boot, not just the boot
# that created it -- the bug was the success path overwriting or discarding
# it on a later restore.
# ===========================================================================
scenario_6() {
  SCEN_OK=1
  SCEN_REASON=""
  new_volume s6
  vol="$REPLY"
  start s6 "$vol"
  c="$REPLY"

  if ! wait_healthy "$c" || ! wait_datasource "$c"; then
    scen_fail "boot never became healthy/seeded"
    destroy "$c"
    report "6 rescue survives next clean boot"
    return
  fi

  docker exec "$c" sqlite3 -cmd '.timeout 8000' "$LIVE_DB" \
    "CREATE TABLE sentinel(x); DELETE FROM sentinel; INSERT INTO sentinel VALUES('MARKER');" >/dev/null
  sleep 13
  stop "$c"

  run_helper "$vol" "sz=\$(stat -c %s '${STATE_DB}'); truncate -s \$((sz / 3)) '${STATE_DB}'" >/dev/null

  docker start "$c" >/dev/null

  if ! wait_healthy "$c"; then
    scen_fail "restart-in-place never became healthy"
    destroy "$c"
    report "6 rescue survives next clean boot"
    return
  fi

  val=$(sql "$c" "${LIVE_DB}.previous" "SELECT x FROM sentinel;")
  if [ "$val" != "MARKER" ]; then
    scen_fail "grafana.db.previous missing sentinel after rescue boot: got '$val'"
  fi

  # A tick needs to land so the state copy becomes a sound snapshot of the
  # (sentinel-free) db this boot created, before the next clean restart takes
  # the success path -- the exact path scenario 6 exists to prove is safe.
  sleep 13
  docker restart -t 5 "$c" >/dev/null

  if ! wait_healthy "$c"; then
    scen_fail "second restart never became healthy"
  else
    val=$(sql "$c" "${LIVE_DB}.previous" "SELECT x FROM sentinel;")
    if [ "$val" != "MARKER" ]; then
      scen_fail "grafana.db.previous lost the sentinel after a second clean boot: got '$val'"
    fi
  fi

  destroy "$c"
  report "6 rescue survives next clean boot"
}

# ===========================================================================
# Scenario 7: QUIXLAKE_SKIP_RESTORE does not accumulate quarantine files
# across repeated boots with the flag left set -- the round-2 finding.
# ===========================================================================
scenario_7() {
  SCEN_OK=1
  SCEN_REASON=""
  new_volume s7
  vol="$REPLY"
  start s7seed "$vol"
  c0="$REPLY"

  if ! wait_healthy "$c0"; then
    scen_fail "seed boot never became healthy"
    destroy "$c0"
    report "7 skip-restore does not accumulate"
    return
  fi
  sleep 13
  destroy "$c0"

  first_name=""
  b=1
  while [ "$b" -le 3 ]; do
    start "s7b${b}" "$vol" -- -e QUIXLAKE_SKIP_RESTORE=true
    cb="$REPLY"
    if ! wait_healthy "$cb"; then
      scen_fail "skip-restore boot $b never became healthy"
      destroy "$cb"
      break
    fi
    name=$(docker exec "$cb" sh -c "ls ${STATE_DB}.skipped-* 2>/dev/null" | head -n 1)
    if [ "$b" = "1" ]; then
      first_name="$name"
    fi
    destroy "$cb"
    b=$((b + 1))
  done

  if [ "$SCEN_OK" = "1" ]; then
    n=$(run_helper "$vol" "ls ${STATE_DB}.skipped-* 2>/dev/null | wc -l" | tr -d ' ')
    if [ "${n:-0}" != "1" ]; then
      scen_fail "expected exactly one grafana.db.skipped-* file, found ${n:-0}"
    elif [ -z "$first_name" ]; then
      scen_fail "no skipped file recorded on the first boot"
    else
      last_name=$(run_helper "$vol" "ls ${STATE_DB}.skipped-* 2>/dev/null" | head -n 1)
      if [ "$last_name" != "$first_name" ]; then
        scen_fail "skipped file was renamed across boots: '$first_name' -> '$last_name'"
      fi
    fi
    if run_helper "$vol" "test -e ${STATE_DB}"; then
      scen_fail "grafana.db was written back to the volume while skip-restore was set"
    fi
  fi

  report "7 skip-restore does not accumulate"
}

# ===========================================================================
# Scenario 8: QUIXLAKE_FORCE_PROVISION re-seeds from the environment even
# when a restored database already has an (edited) datasource row.
# ===========================================================================
scenario_8() {
  SCEN_OK=1
  SCEN_REASON=""
  new_volume s8
  vol="$REPLY"
  start s8a "$vol"
  c1="$REPLY"

  if ! wait_healthy "$c1" || ! wait_datasource "$c1"; then
    scen_fail "first boot never became healthy/seeded"
    destroy "$c1"
    report "8 force provision re-seeds"
    return
  fi
  docker exec "$c1" sqlite3 -cmd '.timeout 8000' "$LIVE_DB" \
    "UPDATE data_source SET url='http://edited.invalid' WHERE uid='${DATASOURCE_UID}';" >/dev/null
  sleep 13
  destroy "$c1"

  start s8b "$vol" -- -e QUIXLAKE_FORCE_PROVISION=true
  c2="$REPLY"
  if ! wait_healthy "$c2"; then
    scen_fail "second boot never became healthy"
  else
    assert_log "$c2" "QUIXLAKE_FORCE_PROVISION is set: re-seeding datasource" "expected force-provision message"
    if ! wait_datasource "$c2"; then
      scen_fail "datasource row missing after force provision"
    fi
    url=$(sql "$c2" "$LIVE_DB" "SELECT url FROM data_source WHERE uid='${DATASOURCE_UID}';")
    if [ "$url" != "http://example.invalid" ]; then
      scen_fail "url not reset to environment value: got '$url'"
    fi
  fi

  destroy "$c2"
  report "8 force provision re-seeds"
}

# ===========================================================================
# Scenario 9: no zombies. Guards the GNU-timeout-vs-busybox regression: a
# non-reaping PID 1 (Grafana) accumulating orphaned watchdog children.
# ===========================================================================
scenario_9() {
  SCEN_OK=1
  SCEN_REASON=""
  new_volume s9
  vol="$REPLY"
  start s9 "$vol"
  c="$REPLY"

  if ! wait_healthy "$c"; then
    scen_fail "never became healthy"
  else
    sleep 45
    zcount=$(docker exec "$c" sh -c "ps -o stat | grep -c 'Z'" || true)
    if [ "${zcount:-0}" != "0" ]; then
      scen_fail "found ${zcount} zombie process(es) after 45s"
    fi
    comm=$(docker exec "$c" cat /proc/1/comm 2>/dev/null || true)
    if [ "$comm" != "grafana" ]; then
      scen_fail "PID 1 is not grafana: got '$comm'"
    fi
  fi

  destroy "$c"
  report "9 no zombies"
}

# ===========================================================================
# Scenario 10: missing GF_SECURITY_SECRET_KEY warns about the publicly known
# default key when persistence is on, and still boots healthy.
# ===========================================================================
scenario_10() {
  SCEN_OK=1
  SCEN_REASON=""
  new_volume s10
  vol="$REPLY"
  start s10 "$vol"
  c="$REPLY"

  if ! wait_healthy "$c"; then
    scen_fail "never became healthy"
  else
    assert_log "$c" "PUBLICLY KNOWN default key" "expected missing-secret-key warning"
  fi

  destroy "$c"
  report "10 missing secret key warns"
}

scenario_1
scenario_2
scenario_3
scenario_4
scenario_5
scenario_6
scenario_7
scenario_8
scenario_9
scenario_10

printf '\n%s passed, %s failed (of %s)\n' "$TOTAL_PASS" "$TOTAL_FAIL" "$((TOTAL_PASS + TOTAL_FAIL))"

if [ "$TOTAL_FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
