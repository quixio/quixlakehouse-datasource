#!/bin/sh
# Boot shim for the Quix-deployed Grafana. It does three things and then hands off
# to Grafana's own entrypoint:
#
#   1. points Grafana's database and logs at the Quix persistent state volume, so
#      dashboards, alert rules, users and datasource edits survive a restart;
#   2. SEEDS the datasource provisioning file from the Quix-injected lakehouse
#      credentials on first boot only (see "seed-only" below);
#   3. drops from root to uid 472 before exec'ing Grafana.
#
# Grafana is a stock image with no code of ours in it, so this shim is the only
# place the Quix-injected lakehouse credentials can be turned into a configured
# datasource. Grafana does expand $VAR in provisioning files, but the Quix variable
# names contain double underscores and we would rather not depend on how its
# expander tokenises those -- so we render explicitly here.
#
# Uses sed, not envsubst: the Grafana image does not ship gettext.
set -eu

PLUGIN_ID="${PLUGIN_ID:-quix-quixlakehouse-datasource}"
TEMPLATE_DIR=/etc/grafana/provisioning-template
TARGET_DIR="${GF_PATHS_PROVISIONING:-/var/lib/grafana/provisioning}"

# The image has no USER line, so this normally runs as root and hands ownership to
# 472 as it goes. Someone running the image with --user skips those chowns: their
# files are already theirs, and chown would only fail.
if [ "$(id -u)" = "0" ]; then IS_ROOT=1; else IS_ROOT=0; fi

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
# Persistence: Grafana's SQLite database and logs go on the Quix state volume.
#
# Quix mounts that volume and injects its path as Quix__Deployment__State__Path
# when the deployment has `state: enabled: true`. There is deliberately NO default
# path: an unset variable means state is not enabled, and a Grafana without a state
# volume loses every dashboard, alert rule, user and datasource edit on restart --
# which is the bug this whole shim exists to prevent. So it is fatal, not a warning.
#
# The mount arrives owned by root, which is why this script starts as root and
# drops to uid 472 at the very end instead of the image declaring USER 472.
#
# GF_PATHS_PLUGINS is deliberately left alone: the plugin is baked into
# /var/lib/grafana/plugins and moving that path onto the volume would hide it.
# ---------------------------------------------------------------------------
if [ -z "${Quix__Deployment__State__Path:-}" ]; then
  echo "FATAL: persistent state is not configured." >&2
  echo "  Quix__Deployment__State__Path = <empty>" >&2
  echo "" >&2
  echo "Quix injects this variable only when the deployment has state enabled, and" >&2
  echo "without the volume it points at, Grafana's database is thrown away on every" >&2
  echo "restart -- dashboards, alert rules, users and any datasource edit made in the" >&2
  echo "UI are lost. Refusing to start a Grafana that silently forgets everything." >&2
  echo "" >&2
  echo "Fix: enable state on the deployment. The 'state: enabled: true' declaration" >&2
  echo "lives in the pipeline repo's quix.yaml, not in this repo's app.yaml." >&2
  exit 1
fi

STATE_GRAFANA="${Quix__Deployment__State__Path}/grafana"

if ! mkdir -p "${STATE_GRAFANA}/data" "${STATE_GRAFANA}/logs"; then
  echo "FATAL: cannot create ${STATE_GRAFANA}." >&2
  echo "Quix__Deployment__State__Path is set to '${Quix__Deployment__State__Path}'," >&2
  echo "but that path is not writable, so Grafana has nowhere durable to keep its" >&2
  echo "database. Refusing to start without persistence." >&2
  exit 1
fi

# Only chown when it is not already ours. A populated volume can hold tens of
# thousands of files, and a recursive chown on every boot would be pure latency.
if [ "$IS_ROOT" = "1" ] && [ "$(stat -c %u "${STATE_GRAFANA}" 2>/dev/null || echo -1)" != "472" ]; then
  chown -R 472:0 "${STATE_GRAFANA}"
fi

export GF_PATHS_DATA="${STATE_GRAFANA}/data"
export GF_PATHS_LOGS="${STATE_GRAFANA}/logs"
echo "quix-entrypoint: persistent state at ${STATE_GRAFANA} (data + logs)"

# ---------------------------------------------------------------------------
# Datasource provisioning is SEED-ONLY.
#
# Grafana re-applies provisioning at every boot and overwrites whatever the
# provisioned datasource's fields were changed to in the UI. That -- not the
# missing volume alone -- is why a URL or token corrected in Connections > Data
# Sources kept reverting on restart. So the file is rendered only on the first boot
# of a given state volume, tracked by a marker on that volume.
#
# Not rendering the file on later boots does NOT delete the datasource: Grafana
# leaves an existing provisioned datasource in the database when its provisioning
# file disappears, so the row -- with any UI edits -- simply stands.
#
# Escape hatch: set QUIXLAKE_FORCE_PROVISION=true to re-seed from the environment
# if the datasource gets broken. It overwrites UI edits -- that is the point of it.
# ---------------------------------------------------------------------------
MARKER="${STATE_GRAFANA}/.datasource-provisioned"

FORCE_PROVISION=0
case "$(printf '%s' "${QUIXLAKE_FORCE_PROVISION:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) FORCE_PROVISION=1 ;;
esac

if [ "$FORCE_PROVISION" = "1" ] || [ ! -f "$MARKER" ]; then
  echo "quix-entrypoint: seeding datasource -> ${QUIXLAKE_URL} (token: set)"

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
    # Rendered as root now, read by Grafana as 472: chmod 600 alone would lock it out.
    chmod 600 "$out"
    if [ "$IS_ROOT" = "1" ]; then chown 472:0 "$out"; fi
    echo "quix-entrypoint: rendered $(basename "$out")"
  done

  : > "$MARKER"
  if [ "$IS_ROOT" = "1" ]; then chown 472:0 "$MARKER"; fi
else
  echo "quix-entrypoint: datasource already seeded (${MARKER}); leaving it to the"
  echo "quix-entrypoint: Grafana database so UI edits survive. Set"
  echo "quix-entrypoint: QUIXLAKE_FORCE_PROVISION=true to re-seed from the environment"
  echo "quix-entrypoint: (that overwrites UI edits)."
fi

# Non-datasource provisioning is code-managed and IS re-applied on every boot: it
# lives in git, has no UI-edit story to protect, and shipping an updated version of
# it is the whole point of a redeploy. The seed-only rule above is for the
# datasource alone, which is the only provisioned object users edit by hand.
for sub in dashboards alerting notifiers plugins; do
  if [ -d "${TEMPLATE_DIR}/${sub}" ]; then
    mkdir -p "${TARGET_DIR}/${sub}"
    cp -r "${TEMPLATE_DIR}/${sub}/." "${TARGET_DIR}/${sub}/" 2>/dev/null || true
  fi
done

# ---------------------------------------------------------------------------
# Drop privileges and hand off. /run.sh is the Grafana image's own entrypoint.
#
# Everything above needed root (the state mount arrives root-owned); Grafana itself
# must not keep it. su is the only mechanism available: /bin/setpriv in this image is
# a symlink to busybox, whose applet takes only -d/--nnp/--inh-caps/--ambient-caps
# and cannot change uid at all -- exec'ing it kills PID 1. su is also what the
# quix-samples Grafana image uses. The literal 'sh' after '--' is a $0 placeholder:
# without it the first argument lands in $0 and is silently dropped. Target is
# uid 472, gid 0, no supplementary groups: what stock Grafana runs as.
# ---------------------------------------------------------------------------
if [ "$IS_ROOT" = "1" ]; then
  # The single quotes are the point: "$@" must be expanded by the shell su starts,
  # from the args after '--', not by this one.
  # shellcheck disable=SC2016
  exec su -s /bin/sh -c '/run.sh "$@"' grafana -- sh "$@"
fi

exec /run.sh "$@"
