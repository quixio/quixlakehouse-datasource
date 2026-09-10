#!/bin/sh
# Boot shim for the Quix-deployed Grafana. Before handing off it:
#
#   1. resolves the Quix-injected lakehouse credentials, and aborts if they are absent;
#   2. restores Grafana's SQLite database from the Quix state volume, if a copy is
#      there, before Grafana opens it;
#   3. seeds the datasource provisioning file from the environment, but only when
#      there was nothing to restore, so a URL or token edited in the UI is not
#      overwritten on the next boot;
#   4. starts a background loop that copies the database out to the state volume
#      every 10 seconds, then execs Grafana as uid 472 so it becomes PID 1.
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
# SQLite's rollback journal. Present only while a transaction is in flight -- the
# backup loop below uses it as the signal to skip a round.
LIVE_JOURNAL="${LIVE_DB}-journal"

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
  else
    echo "quix-entrypoint: WARNING: Quix__Deployment__State__Path is '${STATE_DIR}' but" >&2
    echo "quix-entrypoint: ${STATE_GRAFANA} cannot be created, so persistence is OFF." >&2
    echo "quix-entrypoint: Starting anyway." >&2
  fi
fi

# ---------------------------------------------------------------------------
# Restore, before Grafana starts and therefore before it opens the database.
#
# Copied via a temporary name and renamed into place: a cp cut short by COPY_TIMEOUT
# must not leave a truncated grafana.db behind for Grafana to open.
#
# If a copy exists on the volume but restoring it FAILS, backups are switched off for
# this container. Otherwise the periodic loop below would overwrite a good copy with
# the empty database Grafana is about to create -- the one way this design could lose
# data that a plain ephemeral Grafana would not.
# ---------------------------------------------------------------------------
RESTORED=0
if [ "$PERSIST" = "1" ] && [ -f "$STATE_DB" ]; then
  mkdir -p "$GF_DATA_DIR"
  if timeout "$COPY_TIMEOUT" cp "$STATE_DB" "${LIVE_DB}.restore" \
     && mv -f "${LIVE_DB}.restore" "$LIVE_DB"; then
    if [ "$IS_ROOT" = "1" ]; then chown 472:0 "$LIVE_DB"; fi
    RESTORED=1
    echo "quix-entrypoint: restored Grafana database from ${STATE_DB} ($(db_size "$LIVE_DB") bytes)"
  else
    rm -f "${LIVE_DB}.restore" 2>/dev/null || true
    PERSIST=0
    echo "quix-entrypoint: WARNING: could not restore ${STATE_DB}. Starting with an" >&2
    echo "quix-entrypoint: empty database and seeding the datasource from the environment." >&2
    echo "quix-entrypoint: Backups are OFF for this container so the existing copy on the" >&2
    echo "quix-entrypoint: volume is not overwritten with the empty one." >&2
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
# Backup: a copy of the database out to the state volume, never the database itself.
#
# Written to a .tmp beside the target and renamed, so the next container's restore can
# never read a half-written file. Its only caller is the loop below, under that lock.
# ---------------------------------------------------------------------------
copy_db_to_state() {
  [ -f "$LIVE_DB" ] || return 0
  if timeout "$COPY_TIMEOUT" cp "$LIVE_DB" "${STATE_DB}.tmp"; then
    mv -f "${STATE_DB}.tmp" "$STATE_DB"
  else
    rm -f "${STATE_DB}.tmp" 2>/dev/null || true
    return 1
  fi
}

# Holds one exclusive lock for the whole life of the loop, so two containers sharing a
# state volume cannot interleave their copies. A container that cannot take the lock
# does not back up at all -- that is the safe outcome, not a reason to retry. Failures
# go to stderr and are never fatal: losing a backup must not take Grafana down.
#
# Why copying a live database is safe here: Grafana 13.1.1 ships `wal = false`
# (conf/defaults.ini), so SQLite is in rollback-journal mode and there is no -wal/-shm
# pair that would have to be captured atomically alongside the database. In that mode
# the copy is consistent as long as no transaction is in flight, and an in-flight
# transaction is exactly what a sibling grafana.db-journal means -- so a round that
# sees one skips and retries on the next tick. The journal is never copied and never
# waited on.
#
# The loop copies BEFORE it sleeps, so a container stopped inside the first interval
# still leaves a usable database on the volume rather than nothing. On a cold boot that
# first round is a no-op -- Grafana has not created the file yet -- and copy_db_to_state
# returns quietly; after a restore it re-copies what is already there, which is cheap.
backup_worker() {
  exec 9>"$BACKUP_LOCK"
  if ! flock -n 9; then
    echo "quix-entrypoint: WARNING: ${BACKUP_LOCK} is held by another container, so" >&2
    echo "quix-entrypoint: this one will not back its database up." >&2
    return 0
  fi
  while :; do
    if [ ! -e "$LIVE_JOURNAL" ] && ! copy_db_to_state; then
      echo "quix-entrypoint: WARNING: periodic backup to ${STATE_DB} failed" >&2
    fi
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
    echo "quix-entrypoint: backing up every ${BACKUP_INTERVAL}s; there is no copy at"
    echo "quix-entrypoint: shutdown, so up to ${BACKUP_INTERVAL} seconds of changes are"
    echo "quix-entrypoint: lost if the container stops between copies."
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
