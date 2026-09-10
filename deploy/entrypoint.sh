#!/bin/sh
# Boot shim for the Quix-deployed Grafana. Before handing off it:
#
#   1. resolves the Quix-injected lakehouse credentials, and aborts if they are absent;
#   2. restores Grafana's SQLite database from the Quix state volume, if a copy is
#      there and that copy passes PRAGMA integrity_check, before Grafana opens it;
#   3. seeds the datasource provisioning file from the environment, but only when
#      there was nothing to restore, so a URL or token edited in the UI is not
#      overwritten on the next boot;
#   4. starts a background loop that snapshots the database out to the state volume
#      every 10 seconds, then execs Grafana as uid 472 so it becomes PID 1.
#
# Snapshots go through sqlite3's online backup API and never through cp -- a cp of a
# live database tears, whatever it is guarded with. See copy_db_to_state.
#
# Why a COPY and never the live database: the Quix state volume is CIFS-backed and
# cannot grant the exclusive POSIX locks SQLite needs. A Grafana whose GF_PATHS_DATA
# points at the mount loops forever on its first migration with SQLITE_BUSY -- proven
# three times on the real deployment. Ordinary reads, writes, cp and mkdir on that
# volume all work, so a copy of the database file living there is fine; the database
# being opened there is not. GF_PATHS_DATA is therefore deliberately left at the image
# default, on container-local disk, and only the copy travels.
#
# Grafana is a stock image with no code of ours in it, so this shim is also the only
# place the Quix-injected credentials can be turned into a configured datasource.
# Grafana does expand $VAR in provisioning files, but the Quix variable names contain
# double underscores and we would rather not depend on how its expander tokenises
# those -- so we render explicitly here.
#
# Uses sed, not envsubst: the Grafana image does not ship gettext.
set -eu

PLUGIN_ID="${PLUGIN_ID:-quix-quixlakehouse-datasource}"
TEMPLATE_DIR=/etc/grafana/provisioning-template
TARGET_DIR="${GF_PATHS_PROVISIONING:-/var/lib/grafana/provisioning}"

# The live database, at Grafana's own default location on container-local disk.
GF_DATA_DIR="${GF_PATHS_DATA:-/var/lib/grafana}"
LIVE_DB="${GF_DATA_DIR}/grafana.db"
# Where each snapshot is written and verified before anything on the state volume is
# touched. On container-local disk, because a database cannot be opened on the volume.
BACKUP_STAGE="${LIVE_DB}.backup.tmp"

# There is no shutdown copy (see the hand-off at the bottom), so this interval IS the
# loss window. 10s is cheap for a ~1.5 MB file on a CIFS mount.
BACKUP_INTERVAL=10
# Every copy is bounded: a wedged CIFS mount must not be able to hang the boot.
COPY_TIMEOUT=120

# The image deliberately has no USER line (see deploy/Dockerfile), so this normally
# runs as root and hands ownership to 472 as it goes. Someone running the image with
# --user skips those chowns: their files are already theirs, and chown would only fail.
if [ "$(id -u)" = "0" ]; then IS_ROOT=1; else IS_ROOT=0; fi

db_size() {
  stat -c %s "$1" 2>/dev/null || echo unknown
}

# True only for a database SQLite calls sound. PRAGMA integrity_check prints exactly
# `ok` on a good file and one line per problem otherwise; sqlite3 exits non-zero with
# nothing on stdout if it cannot open the file at all, which fails the same comparison.
# The size test is not redundant: a zero-byte file is a *valid* empty database to
# SQLite and would otherwise pass.
db_is_ok() {
  [ -n "${SQLITE_BIN:-}" ] || return 1
  [ -s "$1" ] || return 1
  [ "$(timeout "$COPY_TIMEOUT" "$SQLITE_BIN" "$1" 'PRAGMA integrity_check;' 2>/dev/null \
     | head -n 1)" = "ok" ]
}

# ---------------------------------------------------------------------------
# Resolve credentials. Quix-injected names win; the QUIXLAKE_* fallbacks exist so
# the identical image runs locally (stage 1/2 in deploy/README.md).
#
# Deliberately NOT Quix__Sdk__Token: the Query Engine runs cluster-global in
# quixdev-global and rejects cross-environment SDK tokens -- the exact failure that
# derailed billing auth. Quix__Lakehouse__Query__AuthToken is the credential minted
# for this purpose.
# ---------------------------------------------------------------------------
QUIXLAKE_URL="${Quix__Lakehouse__Query__Url:-${QUIXLAKE_URL:-}}"
QUIXLAKE_TOKEN="${Quix__Lakehouse__Query__AuthToken:-${QUIXLAKE_TOKEN:-}}"

# Fail loudly and specifically. The failure mode this prevents is a Grafana that
# boots fine but whose datasource cannot connect, with nothing in the logs pointing
# at the cause -- on Quix dev, the usual reason is a missing blobStorage bind.
if [ -z "$QUIXLAKE_URL" ] || [ -z "$QUIXLAKE_TOKEN" ]; then
  echo "FATAL: lakehouse credentials missing." >&2
  echo "  Quix__Lakehouse__Query__Url       = ${QUIXLAKE_URL:-<empty>}" >&2
  echo "  Quix__Lakehouse__Query__AuthToken = ${QUIXLAKE_TOKEN:+<set>}${QUIXLAKE_TOKEN:-<empty>}" >&2
  echo "" >&2
  echo "On Quix dev these inject ONLY when the deployment has blobStorage.bind: true" >&2
  echo "(the bind is the injection vehicle for the whole lakehouse bundle, even though" >&2
  echo "Grafana never touches blob storage). On BYOX they never auto-inject -- declare" >&2
  echo "them in the deployment's variables. Locally, set QUIXLAKE_URL/QUIXLAKE_TOKEN." >&2
  exit 1
fi

# Trailing slashes produce '//query' against the API; harmless but noisy in logs.
QUIXLAKE_URL="${QUIXLAKE_URL%/}"

# ---------------------------------------------------------------------------
# Resolve the state directory.
#
# Quix mounts a persistent volume and injects its path as Quix__Deployment__State__Path
# when the deployment has `state: enabled: true`. An absent variable means state is not
# enabled -- and that is a WARNING, never fatal. Making it fatal took the deployment
# down once already. Grafana must always boot; without the volume it simply behaves as
# it did before this shim grew a backup, forgetting everything on restart.
# ---------------------------------------------------------------------------
STATE_DIR="${Quix__Deployment__State__Path:-}"
STATE_GRAFANA=""
STATE_DB=""
BACKUP_LOCK=""
PERSIST=0

if [ -z "$STATE_DIR" ]; then
  echo "quix-entrypoint: WARNING: Quix__Deployment__State__Path is not set, so" >&2
  echo "quix-entrypoint: persistence is OFF. Dashboards, alert rules, users and any" >&2
  echo "quix-entrypoint: datasource edit made in the UI are lost on restart, and the" >&2
  echo "quix-entrypoint: datasource is re-seeded from the environment on every boot." >&2
  echo "quix-entrypoint: Fix: enable state on the deployment -- 'state: enabled: true'" >&2
  echo "quix-entrypoint: is declared in the pipeline repo's quix.yaml, not in this" >&2
  echo "quix-entrypoint: repo's app.yaml. Starting anyway." >&2
else
  STATE_GRAFANA="${STATE_DIR}/grafana"
  STATE_DB="${STATE_GRAFANA}/grafana.db"
  BACKUP_LOCK="${STATE_GRAFANA}/.backup.lock"
  if mkdir -p "$STATE_GRAFANA" 2>/dev/null; then
    PERSIST=1
    echo "quix-entrypoint: persistence ON, database copy at ${STATE_DB}"
    echo "quix-entrypoint: (QUIXLAKE_SKIP_RESTORE=true ignores that copy and starts from"
    echo "quix-entrypoint: an empty database instead)"
  else
    echo "quix-entrypoint: WARNING: Quix__Deployment__State__Path is '${STATE_DIR}' but" >&2
    echo "quix-entrypoint: ${STATE_GRAFANA} cannot be created, so persistence is OFF." >&2
    echo "quix-entrypoint: Starting anyway." >&2
  fi
fi

# ---------------------------------------------------------------------------
# Both directions go through sqlite3: the backup API to take a snapshot of a live
# database, PRAGMA integrity_check to verify one. It is installed in deploy/Dockerfile
# precisely for this. If it is somehow absent, persistence is switched OFF rather than
# falling back to cp -- cp of a live database produces torn copies at a measured rate,
# and a torn copy restored on the next boot is worse than no copy at all. Nothing is
# deleted from the volume in that state, so a later container with sqlite3 picks the
# existing copy back up.
# ---------------------------------------------------------------------------
SQLITE_BIN="$(command -v sqlite3 2>/dev/null || true)"
if [ "$PERSIST" = "1" ] && [ -z "$SQLITE_BIN" ]; then
  PERSIST=0
  echo "quix-entrypoint: WARNING: sqlite3 is not on PATH, so persistence is OFF for this" >&2
  echo "quix-entrypoint: container -- nothing is restored and nothing is backed up. There" >&2
  echo "quix-entrypoint: is deliberately no cp fallback: a cp of a live database tears." >&2
  echo "quix-entrypoint: Fix: 'apk add --no-cache sqlite' in deploy/Dockerfile's runtime" >&2
  echo "quix-entrypoint: stage. Any existing copy on the volume is left untouched." >&2
fi

# ---------------------------------------------------------------------------
# Secrets at rest. Grafana encrypts secureJsonData -- which is where the datasource's
# lakehouse token lives -- with security.secret_key, and its built-in default is
# published in conf/defaults.ini. Before persistence the database never left the
# container; now a durable copy sits on a shared state volume, where a token encrypted
# with a publicly known key is recoverable by anyone who can read the file.
#
# A warning, never fatal: a fatal check on a missing variable took this deployment down
# once already. Grafana must always boot.
# ---------------------------------------------------------------------------
if [ "$PERSIST" = "1" ] && [ -z "${GF_SECURITY_SECRET_KEY:-}" ]; then
  echo "quix-entrypoint: WARNING: GF_SECURITY_SECRET_KEY is not set, so Grafana encrypts" >&2
  echo "quix-entrypoint: the lakehouse API token with its PUBLICLY KNOWN default key and" >&2
  echo "quix-entrypoint: writes it to the state volume. Anyone who can read ${STATE_DB}" >&2
  echo "quix-entrypoint: can decrypt the token. Set GF_SECURITY_SECRET_KEY as a Quix" >&2
  echo "quix-entrypoint: secret -- BEFORE the first boot, because changing it later" >&2
  echo "quix-entrypoint: leaves already-encrypted secrets undecryptable and the token" >&2
  echo "quix-entrypoint: has to be re-entered in Connections > Data Sources." >&2
  echo "quix-entrypoint: Starting anyway." >&2
fi

# ---------------------------------------------------------------------------
# Restore, before Grafana starts and therefore before it opens the database.
#
# Copied via a temporary name and renamed into place: a cp cut short by COPY_TIMEOUT
# must not leave a truncated grafana.db behind for Grafana to open.
#
# The copy is VERIFIED before it is trusted. It is read onto container-local disk and
# PRAGMA integrity_check is run there -- not on the state file itself, because opening
# a database on the CIFS volume is the exact thing that does not work (see the top of
# this file), and the local copy is byte-for-byte what would be restored anyway. Only
# a result of exactly `ok` earns the rename into place.
#
# A copy that FAILS the check is renamed aside to grafana.db.corrupt-<UTC timestamp>
# and Grafana starts fresh, with backups left ON. Restoring a malformed database
# crash-loops Grafana, and because the next boot restores the same file it stays
# crash-looped; there is nothing to protect in a copy that is known bad, so the sound
# copy this container takes a few seconds later should replace it.
#
# A copy that cannot be READ is the other case and keeps backups OFF for this
# container: nothing is known about that file, so the periodic loop must not overwrite
# a possibly-good copy with the empty database Grafana is about to create -- the one
# way this design could lose data that a plain ephemeral Grafana would not.
#
# QUIXLAKE_SKIP_RESTORE skips all of it and starts empty: the way out of a database
# that is intact enough to pass integrity_check but still wedges Grafana.
# ---------------------------------------------------------------------------
SKIP_RESTORE=0
case "$(printf '%s' "${QUIXLAKE_SKIP_RESTORE:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) SKIP_RESTORE=1 ;;
esac

RESTORED=0
if [ "$PERSIST" = "1" ] && [ -f "$STATE_DB" ] && [ "$SKIP_RESTORE" = "1" ]; then
  echo "quix-entrypoint: WARNING: QUIXLAKE_SKIP_RESTORE is set, so ${STATE_DB} is NOT" >&2
  echo "quix-entrypoint: restored and Grafana starts with an empty database. Backups stay" >&2
  echo "quix-entrypoint: ON, so that copy is overwritten within ${BACKUP_INTERVAL}s --" >&2
  echo "quix-entrypoint: move it aside now if you still want it." >&2
elif [ "$PERSIST" = "1" ] && [ -f "$STATE_DB" ]; then
  mkdir -p "$GF_DATA_DIR"
  rm -f "${LIVE_DB}.restore" 2>/dev/null || true
  if ! timeout "$COPY_TIMEOUT" cp "$STATE_DB" "${LIVE_DB}.restore"; then
    rm -f "${LIVE_DB}.restore" 2>/dev/null || true
    PERSIST=0
    echo "quix-entrypoint: WARNING: could not read ${STATE_DB}. Starting with an" >&2
    echo "quix-entrypoint: empty database and seeding the datasource from the environment." >&2
    echo "quix-entrypoint: Backups are OFF for this container so the existing copy on the" >&2
    echo "quix-entrypoint: volume is not overwritten with the empty one." >&2
  elif db_is_ok "${LIVE_DB}.restore"; then
    mv -f "${LIVE_DB}.restore" "$LIVE_DB"
    if [ "$IS_ROOT" = "1" ]; then chown 472:0 "$LIVE_DB"; fi
    RESTORED=1
    echo "quix-entrypoint: restored Grafana database from ${STATE_DB} ($(db_size "$LIVE_DB") bytes, integrity_check ok)"
  else
    rm -f "${LIVE_DB}.restore" 2>/dev/null || true
    CORRUPT_DB="${STATE_DB}.corrupt-$(date -u +%Y%m%dT%H%M%SZ)"
    echo "quix-entrypoint: WARNING: ${STATE_DB} FAILED PRAGMA integrity_check and was NOT" >&2
    echo "quix-entrypoint: restored -- restoring it would crash-loop Grafana on every boot." >&2
    if mv -f "$STATE_DB" "$CORRUPT_DB" 2>/dev/null; then
      echo "quix-entrypoint: The bad copy is kept at ${CORRUPT_DB}" >&2
    else
      echo "quix-entrypoint: It could not be renamed aside, so the next backup overwrites" >&2
      echo "quix-entrypoint: it. Copy it off the volume now if you want to examine it." >&2
    fi
    echo "quix-entrypoint: Starting with an empty database and seeding the datasource from" >&2
    echo "quix-entrypoint: the environment. Backups stay ON, so a sound copy replaces it" >&2
    echo "quix-entrypoint: within ${BACKUP_INTERVAL}s." >&2
  fi
fi

# ---------------------------------------------------------------------------
# Datasource provisioning is SEED-ONLY.
#
# Grafana re-applies provisioning at every boot and overwrites whatever the
# provisioned datasource's fields were changed to in the UI. So once a database has
# been restored, the template is not rendered at all and the restored row stands with
# its edits. Not rendering the file does NOT delete the datasource: Grafana only
# removes datasources named under `deleteDatasources`, and leaves an existing
# provisioned one alone when its file is absent.
#
# Escape hatch: QUIXLAKE_FORCE_PROVISION=true re-seeds from the environment if the
# datasource gets broken. It overwrites UI edits -- that is the point of it.
# ---------------------------------------------------------------------------
FORCE_PROVISION=0
case "$(printf '%s' "${QUIXLAKE_FORCE_PROVISION:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) FORCE_PROVISION=1 ;;
esac

if [ "$RESTORED" = "1" ] && [ "$FORCE_PROVISION" = "0" ]; then
  echo "quix-entrypoint: datasource comes from the restored database; NOT rendering the"
  echo "quix-entrypoint: provisioning template, so a URL or token edited in Connections >"
  echo "quix-entrypoint: Data Sources survives. Set QUIXLAKE_FORCE_PROVISION=true to"
  echo "quix-entrypoint: re-seed from the environment (that overwrites UI edits)."
else
  echo "quix-entrypoint: provisioning datasource -> ${QUIXLAKE_URL} (token: set)"

  mkdir -p "${TARGET_DIR}/datasources"
  for tpl in "${TEMPLATE_DIR}"/datasources/*.tpl; do
    [ -e "$tpl" ] || continue
    out="${TARGET_DIR}/datasources/$(basename "${tpl}" .tpl)"
    # '#' as the sed delimiter: the URL contains '/'. Tokens are substituted from
    # shell variables and never echoed.
    sed -e "s#__QUIXLAKE_URL__#${QUIXLAKE_URL}#g" \
        -e "s#__QUIXLAKE_TOKEN__#${QUIXLAKE_TOKEN}#g" \
        -e "s#__PLUGIN_ID__#${PLUGIN_ID}#g" \
        "$tpl" > "$out"
    # Rendered as root, read by Grafana as 472: chmod 600 alone would lock it out.
    chmod 600 "$out"
    if [ "$IS_ROOT" = "1" ]; then chown 472:0 "$out"; fi
    echo "quix-entrypoint: rendered $(basename "$out")"
  done
fi

# Non-datasource provisioning is code-managed and IS re-applied on every boot: it
# lives in git, has no UI-edit story to protect, and shipping an updated version of it
# is the whole point of a redeploy. The seed-only rule above is for the datasource
# alone, which is the only provisioned object users edit by hand.
for sub in dashboards alerting notifiers plugins; do
  if [ -d "${TEMPLATE_DIR}/${sub}" ]; then
    mkdir -p "${TARGET_DIR}/${sub}"
    cp -r "${TEMPLATE_DIR}/${sub}/." "${TARGET_DIR}/${sub}/" 2>/dev/null || true
    if [ "$IS_ROOT" = "1" ]; then chown -R 472:0 "${TARGET_DIR}/${sub}"; fi
  fi
done

# ---------------------------------------------------------------------------
# Backup: a snapshot of the database out to the state volume, never the database
# itself.
#
# Taken with sqlite3's online backup API, NOT with cp. A cp of a live database is
# check-then-act however it is guarded -- a write transaction starting while cp reads
# mixes pre- and post-transaction pages, and the result is a file that opens and then
# fails integrity_check. Measured on this image: ~1.7% of copies were malformed at
# Grafana's idle write rate (2 of 118) and 6/18 and 17/25 under load, even with a
# grafana.db-journal guard in front of them. The backup API is safe against concurrent
# writers by construction and measured 12/12 clean against a continuous writer.
#
# The snapshot lands on container-local disk and is integrity-checked there before
# anything on the volume is touched, for two reasons: the CIFS-backed volume cannot
# grant the locks SQLite needs to open a database on it -- as a backup destination or
# for the check -- and copying an already-verified file that nothing is writing to is
# the one case where a plain cp is sound. That cp goes to a .tmp beside the target and
# is renamed, so the next container's restore can never read a half-written file.
#
# Its only caller is the loop below, under that lock.
# ---------------------------------------------------------------------------
copy_db_to_state() {
  [ -f "$LIVE_DB" ] || return 0
  rm -f "$BACKUP_STAGE" 2>/dev/null || true
  if ! timeout "$COPY_TIMEOUT" "$SQLITE_BIN" "$LIVE_DB" ".backup '${BACKUP_STAGE}'"; then
    rm -f "$BACKUP_STAGE" 2>/dev/null || true
    return 1
  fi
  if ! db_is_ok "$BACKUP_STAGE"; then
    rm -f "$BACKUP_STAGE" 2>/dev/null || true
    return 1
  fi
  if ! timeout "$COPY_TIMEOUT" cp "$BACKUP_STAGE" "${STATE_DB}.tmp"; then
    rm -f "$BACKUP_STAGE" "${STATE_DB}.tmp" 2>/dev/null || true
    return 1
  fi
  rm -f "$BACKUP_STAGE" 2>/dev/null || true
  mv -f "${STATE_DB}.tmp" "$STATE_DB" || return 1
}

# The exclusive lock is taken PER TICK, not once for the life of the loop. Quix state
# is shared between replicas, and an overlapping redeploy puts two containers on the
# same volume; whichever loses the race may well be the one that outlives the other, so
# it has to keep trying rather than give up for good while the boot log promises a copy
# every ${BACKUP_INTERVAL}s. A tick that cannot take the lock is skipped. The subshell
# is what makes that possible: the lock is released when it exits and fd 9 closes.
#
# Its exit status is the tick's outcome: 0 copied, 3 lock held elsewhere, anything else
# a failed copy. Each state is logged on its first occurrence and then not again until
# it changes -- a line every ten seconds for the life of a deployment is noise, not a
# signal. Failures are never fatal: losing a backup must not take Grafana down.
#
# The loop copies BEFORE it sleeps, so a container stopped inside the first interval
# still leaves a usable database on the volume rather than nothing. On a cold boot that
# first round is a no-op -- Grafana has not created the file yet -- and copy_db_to_state
# returns quietly; after a restore it re-snapshots what is already there, which is cheap.
backup_worker() {
  lock_warned=0
  fail_warned=0
  while :; do
    rc=0
    (
      exec 9>"$BACKUP_LOCK"
      flock -n 9 || exit 3
      copy_db_to_state || exit 1
      exit 0
    ) || rc=$?
    case "$rc" in
      0)
        if [ "$lock_warned" = "1" ]; then
          echo "quix-entrypoint: took ${BACKUP_LOCK}; backups to ${STATE_DB} resumed."
          lock_warned=0
        fi
        if [ "$fail_warned" = "1" ]; then
          echo "quix-entrypoint: backup to ${STATE_DB} is succeeding again."
          fail_warned=0
        fi
        ;;
      3)
        if [ "$lock_warned" = "0" ]; then
          echo "quix-entrypoint: WARNING: ${BACKUP_LOCK} is held by another container, so" >&2
          echo "quix-entrypoint: this tick is skipped. Retrying every ${BACKUP_INTERVAL}s;" >&2
          echo "quix-entrypoint: logged once, not on every tick." >&2
          lock_warned=1
        fi
        ;;
      *)
        if [ "$fail_warned" = "0" ]; then
          echo "quix-entrypoint: WARNING: backup to ${STATE_DB} failed; nothing on the" >&2
          echo "quix-entrypoint: volume was replaced. Retrying every ${BACKUP_INTERVAL}s;" >&2
          echo "quix-entrypoint: logged once, not on every tick. Grafana is unaffected." >&2
          fail_warned=1
        fi
        ;;
    esac
    sleep "$BACKUP_INTERVAL" || true
  done
}

# Started before the exec below, and that is the whole design. Verified empirically in
# this image: a background child keeps running after its parent shell execs -- the exec
# replaces the parent's process image, it does not touch the child -- so the loop
# survives to the moment the container stops. That is why there is no trap, no signal
# forwarding and no shutdown copy: nothing has to outlive Grafana.
if [ "$PERSIST" = "1" ]; then
  # touch, not ':' with a redirection: ':' is a special built-in, so a redirection
  # error on it exits a non-interactive shell outright and cannot be guarded.
  if touch "$BACKUP_LOCK" 2>/dev/null; then
    backup_worker &
    echo "quix-entrypoint: backing up every ${BACKUP_INTERVAL}s via sqlite3's online"
    echo "quix-entrypoint: backup API, integrity-checked before it replaces the copy on"
    echo "quix-entrypoint: the volume. There is no copy at shutdown, so up to"
    echo "quix-entrypoint: ${BACKUP_INTERVAL} seconds of changes are lost if the container"
    echo "quix-entrypoint: stops between copies."
  else
    PERSIST=0
    echo "quix-entrypoint: WARNING: cannot create ${BACKUP_LOCK}; persistence is OFF." >&2
  fi
fi

# ---------------------------------------------------------------------------
# Hand off. Grafana replaces this shell and becomes PID 1, which is what the stock
# image expects: it receives SIGTERM from the container runtime directly and shuts
# itself down. /run.sh is the Grafana image's own entrypoint.
#
# An earlier version ran Grafana in the background and supervised it so it could take
# a copy at shutdown. It did not work -- the shell died inside the trap and no backup
# was ever written -- and su does not forward signals to its child anyway, so the
# forwarded TERM killed su rather than Grafana. The background loop above replaces it.
#
# su is the only mechanism available for the privilege drop: /bin/setpriv in this image
# is a symlink to busybox, whose applet takes only -d/--nnp/--inh-caps/--ambient-caps
# and cannot change uid at all. The literal 'sh' after '--' is a $0 placeholder:
# without it the first argument lands in $0 and is silently dropped. Target is uid 472,
# gid 0, no supplementary groups: what stock Grafana runs as.
# ---------------------------------------------------------------------------
echo "quix-entrypoint: starting Grafana"
if [ "$IS_ROOT" = "1" ]; then
  # The single quotes are the point: "$@" must be expanded by the shell su starts,
  # from the args after '--', not by this one.
  # shellcheck disable=SC2016
  exec su -s /bin/sh -c '/run.sh "$@"' grafana -- sh "$@"
else
  exec /run.sh "$@"
fi
