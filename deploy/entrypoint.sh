#!/bin/sh
# Boot shim for the Quix-deployed Grafana. Before handing off it:
#
#   1. resolves the Quix-injected lakehouse credentials, and aborts if they are absent;
#   2. restores Grafana's SQLite database from the Quix state volume, if a copy is
#      there and that copy passes PRAGMA integrity_check, before Grafana opens it;
#   3. seeds the datasource provisioning file from the environment, but only when the
#      database Grafana is about to open has no datasource row of its own, so a URL or
#      token edited in the UI is not overwritten on the next boot;
#   4. starts a background loop that snapshots the database out to the state volume
#      every 10 seconds -- the first snapshot one full interval in, never at boot --
#      then execs Grafana as uid 472 so it becomes PID 1.
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
# That same missing lock support is why the backup loop PROBES flock at startup instead
# of trusting it (see probe_lock): a share that refuses flock would otherwise turn every
# tick into "held by another container" and back nothing up for the life of the pod.
#
# Grafana is a stock image with no code of ours in it, so this shim is also the only
# place the Quix-injected credentials can be turned into a configured datasource.
# Grafana does expand $VAR in provisioning files, but the Quix variable names contain
# double underscores and we would rather not depend on how its expander tokenises
# those -- so we render explicitly here.
#
# Uses sed, not envsubst: the Grafana image does not ship gettext. Values substituted
# into the template are escaped for both sed and YAML first -- see render_escape.
set -eu

PLUGIN_ID="${PLUGIN_ID:-quix-quixlakehouse-datasource}"
TEMPLATE_DIR=/etc/grafana/provisioning-template
TARGET_DIR="${GF_PATHS_PROVISIONING:-/var/lib/grafana/provisioning}"

# Must match `uid:` in provisioning/datasources/quixlakehouse.yml.tpl. It is the key the
# seed decision is made on: if the database already has this row, the template is not
# rendered over it.
DATASOURCE_UID=quixlakehouse

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
# Re-warn about a failing backup roughly every 30 minutes rather than once per
# container: a volume that fills or goes read-only at hour three deserves a line then,
# not only in the boot log nobody is still tailing.
FAIL_REWARN_TICKS=$(( 30 * 60 / BACKUP_INTERVAL ))

# Identity for the ownership marker on the state volume (see owner_taken_over). Boot
# time, not tick time: the newest container wins, and it must not keep re-winning
# against itself.
HOST_ID="$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || echo unknown)"
BOOT_TS="$(date -u +%s)"

# The image deliberately has no USER line (see deploy/Dockerfile), so this normally
# runs as root and hands ownership to 472 as it goes. Someone running the image with
# --user skips those chowns: their files are already theirs, and chown would only fail.
if [ "$(id -u)" = "0" ]; then IS_ROOT=1; else IS_ROOT=0; fi

db_size() {
  stat -c %s "$1" 2>/dev/null || echo unknown
}

# Every sqlite3 invocation goes through here, so that every one of them carries a busy
# timeout. The CLI's default is ZERO: the shared read lock a snapshot or an
# integrity_check takes would then make Grafana's concurrent writes fail outright with
# "database is locked" instead of waiting a moment. The window that matters most is
# Grafana's startup burst of migrations and provisioning writes, which is also why the
# backup loop sleeps before its first tick.
SQLITE_TIMEOUT_MS=10000
sqlite_run() {
  _db="$1"
  shift
  timeout "$COPY_TIMEOUT" "$SQLITE_BIN" -cmd ".timeout ${SQLITE_TIMEOUT_MS}" "$_db" "$@"
}

# True only for a database SQLite calls sound. PRAGMA integrity_check prints exactly
# `ok` on a good file and one line per problem otherwise; sqlite3 exits non-zero with
# nothing on stdout if it cannot open the file at all, which fails the same comparison.
# The size test is not redundant: a zero-byte file is a *valid* empty database to
# SQLite and would otherwise pass.
db_is_ok() {
  [ -n "${SQLITE_BIN:-}" ] || return 1
  [ -s "$1" ] || return 1
  [ "$(sqlite_run "$1" 'PRAGMA integrity_check;' 2>/dev/null | head -n 1)" = "ok" ]
}

# True when the database already carries our datasource row. Any failure -- no sqlite3,
# no such table on a database from a much older Grafana, an unreadable file -- reports
# false, because provisioning is the safe direction: re-seeding a datasource that does
# exist costs a UI edit, while not seeding one that does not leaves the deployment with
# no datasource at all and no way back except QUIXLAKE_FORCE_PROVISION.
db_has_datasource() {
  [ -n "${SQLITE_BIN:-}" ] || return 1
  [ -s "$1" ] || return 1
  [ "$(sqlite_run "$1" \
       "SELECT 1 FROM data_source WHERE uid='${DATASOURCE_UID}' LIMIT 1;" 2>/dev/null \
     | head -n 1)" = "1" ]
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
# at the cause -- on Quix dev, the usual reason is a missing blobStorage bind. The URL
# is printed because a wrong one is the second most common cause and it is not a
# secret; the token is only ever reported as set or empty.
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
BACKUP_OWNER=""
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
  BACKUP_OWNER="${STATE_GRAFANA}/.backup.owner"
  if mkdir -p "$STATE_GRAFANA" 2>/dev/null; then
    PERSIST=1
    echo "quix-entrypoint: persistence ON, database copy at ${STATE_DB}"
    echo "quix-entrypoint: (QUIXLAKE_SKIP_RESTORE=true renames that copy aside and starts"
    echo "quix-entrypoint: from an empty database instead)"
  else
    echo "quix-entrypoint: WARNING: Quix__Deployment__State__Path is '${STATE_DIR}' but" >&2
    echo "quix-entrypoint: ${STATE_GRAFANA} cannot be created, so persistence is OFF." >&2
    echo "quix-entrypoint: Starting anyway." >&2
  fi
fi

# ---------------------------------------------------------------------------
# Both directions go through sqlite3: the backup API to take a snapshot of a live
# database, PRAGMA integrity_check to verify one, and a one-row SELECT to decide whether
# the datasource still needs seeding. It is installed in deploy/Dockerfile precisely for
# this. If it is somehow absent, persistence is switched OFF rather than falling back to
# cp -- cp of a live database produces torn copies at a measured rate, and a torn copy
# restored on the next boot is worse than no copy at all. Nothing is deleted from the
# volume in that state, so a later container with sqlite3 picks the existing copy back
# up.
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
# Every file this script writes that holds that ciphertext is chmod 600, but a mode is
# only as good as the filesystem keeping it: a CIFS mount typically maps every file to
# the mount's own uid and mode and ignores what we set. The key is the control that
# actually travels with the file.
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

# Quarantined copies live on the same 1 GB volume as the copy that matters, and each one
# is a full database. Keep the three most recent and delete the rest, so a boot loop that
# quarantines on every attempt cannot fill the volume and take the backup down with it.
#
# Ordered by the UTC timestamp in the name and NOT by mtime: `mv` preserves mtime, so a
# copy quarantined today can carry a month-old mtime and be pruned ahead of an older
# one. The suffix is the only honest ordering.
prune_quarantine() {
  [ -n "$STATE_DB" ] || return 0
  for _q in "${STATE_DB}".corrupt-* "${STATE_DB}".skipped-*; do
    [ -e "$_q" ] || continue
    printf '%s %s\n' "${_q##*-}" "$_q"
  done \
    | sort -r \
    | tail -n +4 \
    | while read -r _stamp _old; do
        if rm -f "$_old" 2>/dev/null; then
          echo "quix-entrypoint: pruned quarantined copy ${_old} (newest 3 kept)" >&2
        fi
      done
  return 0
}

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
# that is intact enough to pass integrity_check but still wedges Grafana. The copy is
# renamed aside exactly as a corrupt one is, because backups stay ON and would
# otherwise destroy the very file the operator chose not to restore, within
# ${BACKUP_INTERVAL}s -- long before anyone reads a log line asking them to move it.
# ---------------------------------------------------------------------------
SKIP_RESTORE=0
case "$(printf '%s' "${QUIXLAKE_SKIP_RESTORE:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) SKIP_RESTORE=1 ;;
esac

RESTORED=0
if [ "$PERSIST" = "1" ] && [ -f "$STATE_DB" ] && [ "$SKIP_RESTORE" = "1" ]; then
  SKIPPED_DB="${STATE_DB}.skipped-$(date -u +%Y%m%dT%H%M%SZ)"
  echo "quix-entrypoint: WARNING: QUIXLAKE_SKIP_RESTORE is set, so ${STATE_DB} is NOT" >&2
  echo "quix-entrypoint: restored and Grafana starts with an empty database." >&2
  if mv -f "$STATE_DB" "$SKIPPED_DB" 2>/dev/null; then
    echo "quix-entrypoint: The skipped copy is kept at ${SKIPPED_DB}. Backups stay ON and" >&2
    echo "quix-entrypoint: write a fresh ${STATE_DB} within ${BACKUP_INTERVAL}s; the kept" >&2
    echo "quix-entrypoint: copy is not overwritten, but only the three most recent" >&2
    echo "quix-entrypoint: quarantined copies are retained, so move it off the volume if" >&2
    echo "quix-entrypoint: you need it long-term." >&2
    prune_quarantine
  else
    echo "quix-entrypoint: It could NOT be renamed aside, so the next backup overwrites it" >&2
    echo "quix-entrypoint: within ${BACKUP_INTERVAL}s. Copy it off the volume now." >&2
  fi
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
    # 600 before the rename, which preserves it: this file is a full Grafana database
    # carrying the encrypted lakehouse token, and Grafana as its owner needs no wider.
    chmod 600 "${LIVE_DB}.restore" 2>/dev/null || true
    # A docker restart reuses the writable layer, so a hot journal belonging to the
    # PREVIOUS database can still be sitting beside it. SQLite would roll those pages
    # into the file we just restored -- pages from a different database -- and corrupt
    # it on open. The restored file is a complete, checked database and needs no
    # journal of its own.
    rm -f "${LIVE_DB}-journal" "${LIVE_DB}-wal" "${LIVE_DB}-shm" 2>/dev/null || true
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
      echo "quix-entrypoint: The bad copy is kept at ${CORRUPT_DB} (newest 3 kept)" >&2
      prune_quarantine
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
# Datasource provisioning is SEED-ONLY, and the seed decision is made on the DATASOURCE
# ROW, not on whether a database was restored.
#
# Grafana re-applies provisioning at every boot and overwrites whatever the provisioned
# datasource's fields were changed to in the UI, so the template must not be rendered
# once the row exists. But "a database was restored" is a different question: a snapshot
# taken in the seconds before Grafana committed that row restores clean and passes
# integrity_check while containing no datasource at all, and a user can delete the
# datasource in the UI. Gating on the restore left both cases permanently without a
# datasource, so we ask the restored database directly instead.
#
# Not rendering the file does NOT delete the datasource: Grafana only removes
# datasources named under `deleteDatasources`, and leaves an existing provisioned one
# alone when its file is absent.
#
# Escape hatch: QUIXLAKE_FORCE_PROVISION=true re-seeds from the environment even when
# the row is there. It overwrites UI edits -- that is the point of it.
# ---------------------------------------------------------------------------
FORCE_PROVISION=0
case "$(printf '%s' "${QUIXLAKE_FORCE_PROVISION:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) FORCE_PROVISION=1 ;;
esac

DS_EXISTS=0
if [ "$RESTORED" = "1" ] && db_has_datasource "$LIVE_DB"; then
  DS_EXISTS=1
fi

# Escapes one value for BOTH consumers it passes through: sed's replacement text, where
# '\', '&' and the '#' delimiter are special, and a single-quoted YAML scalar, where a
# quote has to be doubled. The YAML doubling runs first so the sed escaping also covers
# what it introduced. Without this, a '#' or '&' in the token is silently mangled, and a
# leading '{', '[', '*' or '!' -- or an embedded ': ' -- breaks the document.
render_escape() {
  printf '%s' "$1" | sed -e "s/'/''/g" -e 's/[\\&#]/\\&/g'
}

if [ "$DS_EXISTS" = "1" ] && [ "$FORCE_PROVISION" = "0" ]; then
  echo "quix-entrypoint: the restored database already has datasource uid=${DATASOURCE_UID};"
  echo "quix-entrypoint: NOT rendering the provisioning template, so a URL or token edited"
  echo "quix-entrypoint: in Connections > Data Sources survives. Set"
  echo "quix-entrypoint: QUIXLAKE_FORCE_PROVISION=true to re-seed from the environment"
  echo "quix-entrypoint: (that overwrites UI edits)."
else
  if [ "$FORCE_PROVISION" = "1" ]; then
    echo "quix-entrypoint: QUIXLAKE_FORCE_PROVISION is set: re-seeding datasource"
    echo "quix-entrypoint: uid=${DATASOURCE_UID} from the environment, overwriting UI edits."
  elif [ "$RESTORED" = "1" ]; then
    echo "quix-entrypoint: the restored database has NO datasource uid=${DATASOURCE_UID} --"
    echo "quix-entrypoint: deleted in the UI, or the copy predates Grafana writing the row."
    echo "quix-entrypoint: Seeding it from the environment."
  else
    echo "quix-entrypoint: no database was restored, so the datasource is seeded from the"
    echo "quix-entrypoint: environment."
  fi

  # Neither value is echoed here. The token is a credential; the URL is printed only on
  # the fatal path above, where a wrong one is the thing being diagnosed.
  URL_SUB="$(render_escape "$QUIXLAKE_URL")"
  TOKEN_SUB="$(render_escape "$QUIXLAKE_TOKEN")"
  PLUGIN_ID_SUB="$(render_escape "$PLUGIN_ID")"

  mkdir -p "${TARGET_DIR}/datasources"
  for tpl in "${TEMPLATE_DIR}"/datasources/*.tpl; do
    [ -e "$tpl" ] || continue
    out="${TARGET_DIR}/datasources/$(basename "${tpl}" .tpl)"
    # '#' as the sed delimiter: the URL contains '/'. The placeholders sit inside
    # single-quoted YAML scalars in the template, and render_escape has already made
    # each value safe for both layers.
    sed -e "s#__QUIXLAKE_URL__#${URL_SUB}#g" \
        -e "s#__QUIXLAKE_TOKEN__#${TOKEN_SUB}#g" \
        -e "s#__PLUGIN_ID__#${PLUGIN_ID_SUB}#g" \
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
# Both files it writes are chmod 600: each is a full Grafana database carrying the
# encrypted lakehouse token. The CIFS mount may ignore the mode on the copy it ends up
# holding, which is exactly why GF_SECURITY_SECRET_KEY matters more than the bits do.
#
# Its only caller is backup_tick below.
# ---------------------------------------------------------------------------
copy_db_to_state() {
  [ -f "$LIVE_DB" ] || return 0
  rm -f "$BACKUP_STAGE" 2>/dev/null || true
  if ! sqlite_run "$LIVE_DB" ".backup '${BACKUP_STAGE}'"; then
    rm -f "$BACKUP_STAGE" 2>/dev/null || true
    return 1
  fi
  chmod 600 "$BACKUP_STAGE" 2>/dev/null || true
  if ! db_is_ok "$BACKUP_STAGE"; then
    rm -f "$BACKUP_STAGE" 2>/dev/null || true
    return 1
  fi
  if ! timeout "$COPY_TIMEOUT" cp "$BACKUP_STAGE" "${STATE_DB}.tmp"; then
    rm -f "$BACKUP_STAGE" "${STATE_DB}.tmp" 2>/dev/null || true
    return 1
  fi
  chmod 600 "${STATE_DB}.tmp" 2>/dev/null || true
  rm -f "$BACKUP_STAGE" 2>/dev/null || true
  mv -f "${STATE_DB}.tmp" "$STATE_DB" || return 1
}

# ---------------------------------------------------------------------------
# Ownership marker. Quix state is shared between replicas, and an overlapping redeploy
# puts two containers on the same volume. A lock only serialises them: they still take
# turns, and the OUTGOING container's next tick writes its now-stale database over the
# incoming one's edits.
#
# This narrows that window; it does not close it. A full fencing protocol is out of
# scope. The rule is "newest boot wins": each container claims the marker on its first
# successful tick, and any container that finds the marker naming a DIFFERENT host with
# a NEWER boot time stops backing up for good. The residual race -- both containers
# ticking between the claim and the next read -- is documented in deploy/README.md.
# ---------------------------------------------------------------------------
owner_host() {
  _line="$(cat "$BACKUP_OWNER" 2>/dev/null || true)"
  printf '%s' "${_line%% *}"
}

owner_taken_over() {
  [ -n "$BACKUP_OWNER" ] || return 1
  [ -f "$BACKUP_OWNER" ] || return 1
  _line="$(cat "$BACKUP_OWNER" 2>/dev/null || true)"
  _host="${_line%% *}"
  _ts="${_line##* }"
  [ -n "$_host" ] || return 1
  [ "$_host" != "$HOST_ID" ] || return 1
  # An unparsable or half-written marker is not evidence of anything.
  case "$_ts" in ''|*[!0-9]*) return 1 ;; esac
  [ "$_ts" -gt "$BOOT_TS" ]
}

claim_ownership() {
  [ "$owner_claimed" = "0" ] || return 0
  printf '%s %s\n' "$HOST_ID" "$BOOT_TS" > "$BACKUP_OWNER" 2>/dev/null || true
  chmod 600 "$BACKUP_OWNER" 2>/dev/null || true
  return 0
}

# One tick's work, run under the lock when there is one. Its exit status is the tick's
# outcome, read by backup_worker: 0 copied, 4 another container has taken over,
# anything else a failed copy.
backup_tick() {
  if owner_taken_over; then return 4; fi
  copy_db_to_state || return 1
  claim_ownership
  return 0
}

# ---------------------------------------------------------------------------
# Does flock actually work on this volume? Ask once, at startup, rather than assume.
#
# The reason the live database cannot live on the state mount at all is that CIFS
# cannot grant SQLite's POSIX locks, so taking flock on that same mount on faith is
# precisely the assumption this design already knows to distrust. If the share refuses
# it, every tick exits "held by another container" and nothing is ever backed up, while
# the boot log has already promised a copy every ${BACKUP_INTERVAL}s.
#
# Three outcomes:
#   usable      -- we took the lock AND a second, independent process was refused it.
#   contended   -- we could not take it and the ownership marker names another host,
#                  which is the only evidence that justifies blaming another container.
#   unsupported -- everything else: no flock binary, the call errored, or the share
#                  accepted it and enforced nothing. Back up WITHOUT the lock. A single
#                  replica is the normal case, and no backup at all is strictly worse
#                  than an unserialised one.
# ---------------------------------------------------------------------------
LOCK_MODE=none
LOCK_PROBE=unsupported

probe_lock() {
  if ! command -v flock >/dev/null 2>&1; then
    LOCK_PROBE=unsupported
    return 0
  fi
  _rc=0
  (
    exec 9>"$BACKUP_LOCK"
    flock -n 9 || exit 4
    # While this process holds it, an independent one must be REFUSED. A filesystem
    # that accepts flock() and enforces nothing between processes would otherwise be
    # indistinguishable from a working lock.
    if sh -c 'exec 9>"$1"; flock -n 9' sh "$BACKUP_LOCK" >/dev/null 2>&1; then
      exit 3
    fi
    exit 0
  ) || _rc=$?
  case "$_rc" in
    0) LOCK_PROBE=usable ;;
    3) LOCK_PROBE=unsupported ;;
    *)
      _other="$(owner_host)"
      if [ -n "$_other" ] && [ "$_other" != "$HOST_ID" ]; then
        LOCK_PROBE=contended
      else
        LOCK_PROBE=unsupported
      fi
      ;;
  esac
  return 0
}

# The lock, where there is one, is taken PER TICK and not once for the life of the loop.
# Whichever container loses the race may well be the one that outlives the other, so it
# has to keep trying rather than give up for good. The subshell is what makes that
# possible: the lock is released when it exits and fd 9 closes.
#
# The loop SLEEPS FIRST. Copying before the first sleep raced Grafana's own startup --
# the snapshot's read lock landing in the middle of the migration and provisioning
# burst, the densest write window of the container's life. One interval of exposure at
# boot is the right trade: there is nothing in the database yet that the previous
# container did not already back up.
#
# A tick whose database is byte-identical to the one last copied is skipped outright,
# lock and all: three full passes over the file every ten seconds for a Grafana nobody
# is editing is pure CIFS traffic. The fingerprint is size plus mtime-in-seconds, so a
# write landing in the same second as the tick that copied it, at exactly the same size,
# is not seen until the next write -- narrow, and the alternative is hashing the file
# every ten seconds.
#
# Each state is logged on its first occurrence, and a persistent failure is re-announced
# roughly every 30 minutes with its consecutive-failure count: a volume that fills at
# hour three must not be announced only in a line nobody is still tailing. Failures are
# never fatal -- losing a backup must not take Grafana down.
backup_worker() {
  lock_warned=0
  lock_skipped=0
  fail_count=0
  owner_claimed=0
  last_sig=""
  while :; do
    sleep "$BACKUP_INTERVAL" || true

    sig=""
    if [ -f "$LIVE_DB" ]; then
      sig="$(stat -c '%s %Y' "$LIVE_DB" 2>/dev/null || echo unknown)"
    fi
    if [ -n "$last_sig" ] && [ "$sig" = "$last_sig" ]; then
      continue
    fi

    rc=0
    if [ "$LOCK_MODE" = "flock" ]; then
      (
        exec 9>"$BACKUP_LOCK"
        flock -n 9 || exit 3
        backup_tick || exit $?
        exit 0
      ) || rc=$?
    else
      backup_tick || rc=$?
    fi

    case "$rc" in
      0)
        last_sig="$sig"
        owner_claimed=1
        if [ "$lock_warned" = "1" ]; then
          echo "quix-entrypoint: took ${BACKUP_LOCK}; backups to ${STATE_DB} resumed after"
          echo "quix-entrypoint: ${lock_skipped} skipped tick(s)."
          lock_warned=0
          lock_skipped=0
        fi
        if [ "$fail_count" -gt 0 ]; then
          echo "quix-entrypoint: backup to ${STATE_DB} is succeeding again after ${fail_count}"
          echo "quix-entrypoint: failed tick(s), about $((fail_count * BACKUP_INTERVAL))s of missed copies."
          fail_count=0
        fi
        ;;
      3)
        lock_skipped=$((lock_skipped + 1))
        if [ "$lock_warned" = "0" ]; then
          echo "quix-entrypoint: WARNING: ${BACKUP_LOCK} is held by another container, so" >&2
          echo "quix-entrypoint: this tick is skipped. Retrying every ${BACKUP_INTERVAL}s;" >&2
          echo "quix-entrypoint: logged once, not on every tick." >&2
          lock_warned=1
        fi
        ;;
      4)
        echo "quix-entrypoint: WARNING: '$(owner_host)' booted after this container and has" >&2
        echo "quix-entrypoint: claimed ${STATE_DB}. Backups from this container STOP here, so" >&2
        echo "quix-entrypoint: an outgoing container cannot write its older database over the" >&2
        echo "quix-entrypoint: incoming one's. Nothing changed in THIS Grafana from now on is" >&2
        echo "quix-entrypoint: persisted; Grafana is otherwise unaffected." >&2
        return 0
        ;;
      *)
        fail_count=$((fail_count + 1))
        if [ "$fail_count" = "1" ]; then
          echo "quix-entrypoint: WARNING: backup to ${STATE_DB} failed; nothing on the" >&2
          echo "quix-entrypoint: volume was replaced. Retrying every ${BACKUP_INTERVAL}s and" >&2
          echo "quix-entrypoint: re-reporting every $((FAIL_REWARN_TICKS * BACKUP_INTERVAL / 60)) minutes until it recovers." >&2
          echo "quix-entrypoint: Grafana is unaffected." >&2
        elif [ "$((fail_count % FAIL_REWARN_TICKS))" = "0" ]; then
          echo "quix-entrypoint: WARNING: backup to ${STATE_DB} has now failed ${fail_count}" >&2
          echo "quix-entrypoint: consecutive ticks, about $((fail_count * BACKUP_INTERVAL / 60)) minutes with nothing persisted." >&2
          echo "quix-entrypoint: Usual causes: the state volume is full, or it has gone" >&2
          echo "quix-entrypoint: read-only." >&2
        fi
        ;;
    esac
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
    probe_lock
    case "$LOCK_PROBE" in
      usable)
        LOCK_MODE=flock
        ;;
      contended)
        LOCK_MODE=flock
        echo "quix-entrypoint: ${BACKUP_LOCK} is held right now and the ownership marker" >&2
        echo "quix-entrypoint: names another container, so ticks are skipped until it is" >&2
        echo "quix-entrypoint: released." >&2
        ;;
      *)
        LOCK_MODE=none
        echo "quix-entrypoint: NOTE: ${BACKUP_LOCK} cannot be locked -- flock is missing or" >&2
        echo "quix-entrypoint: not enforced on this filesystem, which is unsurprising on the" >&2
        echo "quix-entrypoint: CIFS-backed Quix state volume. Backups continue WITHOUT the" >&2
        echo "quix-entrypoint: lock: no backup at all would be strictly worse, and a single" >&2
        echo "quix-entrypoint: replica has nothing to serialise against. With two containers" >&2
        echo "quix-entrypoint: on one volume they are ordered only by the ownership marker --" >&2
        echo "quix-entrypoint: see 'Persistence' in deploy/README.md." >&2
        ;;
    esac
    backup_worker &
    echo "quix-entrypoint: backing up every ${BACKUP_INTERVAL}s via sqlite3's online"
    echo "quix-entrypoint: backup API, integrity-checked before it replaces the copy on"
    echo "quix-entrypoint: the volume. The first copy is taken ${BACKUP_INTERVAL}s from now"
    echo "quix-entrypoint: rather than at boot, so it cannot contend with Grafana's startup"
    echo "quix-entrypoint: migrations. There is no copy at shutdown, so up to"
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
