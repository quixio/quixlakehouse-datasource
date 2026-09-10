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
FROM golang:1.27-alpine AS backend
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
    # The entrypoint renders provisioning at boot into a directory owned by uid 472
    # -- the user Grafana ends up running as -- rather than into the image's
    # /etc/grafana tree, and points Grafana there via GF_PATHS_PROVISIONING. The
    # rendered datasource file carries the token and is chmod 600, so it has to be
    # owned by the server's uid to be readable at all.
    && mkdir -p /var/lib/grafana/provisioning/datasources \
    && chown -R 472:0 /var/lib/grafana/provisioning /var/lib/grafana/plugins

# Deliberately NO `USER 472` here. The entrypoint has to start as root: the Quix
# persistent state volume is mounted owned by root, and only root can create the
# Grafana subdirectories on it and chown them to 472. The entrypoint drops to uid
# 472 itself (setpriv, su fallback) immediately before exec'ing Grafana, so the
# server still runs unprivileged -- see deploy/entrypoint.sh.

# GF_PATHS_DATA and GF_PATHS_LOGS are NOT set here on purpose. They must point at
# the state mount, whose path Quix injects at runtime as
# Quix__Deployment__State__Path, so the entrypoint derives and exports them.
#
# GF_PATHS_PLUGINS is NOT set here either, and must NOT be pointed at the state
# volume. The quix-samples Grafana image does exactly that; copying it here would
# break this image, because our plugin is baked into /var/lib/grafana/plugins at
# build time and repointing the variable would hide it behind an empty volume.
#
# GF_PATHS_PROVISIONING stays on the image filesystem: the entrypoint writes it at
# boot from the environment and from the baked templates, so it is derived state and
# needs no volume. (The datasource within it is seeded once per state volume, not
# re-rendered every boot -- see deploy/entrypoint.sh -- but the marker that records
# that lives on the volume, not here.)
ENV GF_PATHS_PROVISIONING=/var/lib/grafana/provisioning \
    # Unsigned is fine on self-hosted Grafana, which is what a Quix deployment is.
    # This is precisely why deploying here does not wait on Grafana Labs signing.
    GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=${PLUGIN_ID} \
    GF_ANALYTICS_REPORTING_ENABLED=false \
    GF_ANALYTICS_CHECK_FOR_UPDATES=false

ENTRYPOINT ["/usr/local/bin/quix-entrypoint.sh"]
