# Deployable Grafana image with the QuixLakeHouse datasource baked in.
#
# Why bake the plugin instead of using GF_INSTALL_PLUGINS with a release URL:
# Quix Cloud environments are not guaranteed egress to GitHub (the lakehouse images
# already bake DuckDB extensions for air-gapped envs), so downloading the plugin at
# boot would be a new runtime dependency on the internet. Baking makes the image
# self-contained and the boot deterministic.
#
# Build from the REPO ROOT, not from deploy/:
#   docker build -f deploy/Dockerfile -t quixlakehouse-grafana:dev .

# ---------------------------------------------------------------------------
# 1. Frontend: TypeScript/React -> dist/ (module.js, plugin.json, assets)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /build
# package-lock.json first so dependency installs cache independently of source edits.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# 2. Backend: Go -> dist/gpx_quixlakehouse_linux_amd64
# ---------------------------------------------------------------------------
# The plugin binary name comes from `executable` in src/plugin.json; the SDK's mage
# targets read it, so it is not duplicated here.
FROM golang:1.26-alpine AS backend
RUN apk add --no-cache git
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go install github.com/magefile/mage@latest \
    && mage -v build:linux

# ---------------------------------------------------------------------------
# 3. Runtime: stock Grafana + the built plugin
# ---------------------------------------------------------------------------
FROM grafana/grafana:13.1.1

# Grafana discovers plugins by directory name, which must equal the plugin id.
ARG PLUGIN_ID=quix-quixlakehouse-datasource
ENV PLUGIN_ID=${PLUGIN_ID}

USER root

COPY --from=frontend /build/dist /var/lib/grafana/plugins/${PLUGIN_ID}
COPY --from=backend  /build/dist /var/lib/grafana/plugins/${PLUGIN_ID}

COPY deploy/provisioning /etc/grafana/provisioning-template
COPY deploy/entrypoint.sh /usr/local/bin/quix-entrypoint.sh
RUN chmod +x /usr/local/bin/quix-entrypoint.sh \
    && chmod +x /var/lib/grafana/plugins/${PLUGIN_ID}/gpx_* \
    # The entrypoint renders provisioning at boot. Grafana runs as uid 472 and cannot
    # write to /etc/grafana, so render into a directory it owns and point Grafana there
    # via GF_PATHS_PROVISIONING rather than fighting permissions.
    && mkdir -p /var/lib/grafana/provisioning/datasources \
    && chown -R 472:0 /var/lib/grafana/provisioning /var/lib/grafana/plugins

USER 472

ENV GF_PATHS_PROVISIONING=/var/lib/grafana/provisioning \
    # Unsigned is fine on self-hosted Grafana, which is what a Quix deployment is.
    # This is precisely why deploying here does not wait on Grafana Labs signing.
    GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=${PLUGIN_ID} \
    GF_ANALYTICS_REPORTING_ENABLED=false \
    GF_ANALYTICS_CHECK_FOR_UPDATES=false

ENTRYPOINT ["/usr/local/bin/quix-entrypoint.sh"]
