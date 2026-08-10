#!/bin/sh
# Renders the datasource provisioning file from environment variables, then hands
# off to Grafana's own entrypoint.
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
  chmod 600 "$out"
  echo "quix-entrypoint: rendered $(basename "$out")"
done

# Copy any non-template provisioning (dashboards, alert rules) through untouched.
for sub in dashboards alerting notifiers plugins; do
  if [ -d "${TEMPLATE_DIR}/${sub}" ]; then
    mkdir -p "${TARGET_DIR}/${sub}"
    cp -r "${TEMPLATE_DIR}/${sub}/." "${TARGET_DIR}/${sub}/" 2>/dev/null || true
  fi
done

# /run.sh is the Grafana image's own entrypoint.
exec /run.sh "$@"
