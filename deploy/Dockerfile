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
    # via GF_PATHS_PROVISIONING rather than fighting permissions. The rendered
    # datasource file carries the token and is chmod 600, so the entrypoint also chowns
    # it to 472 -- it writes as root and Grafana reads as 472.
    && mkdir -p /var/lib/grafana/provisioning/datasources \
    && chown -R 472:0 /var/lib/grafana/provisioning /var/lib/grafana/plugins

# Deliberately NO `USER 472`. The entrypoint has to start as root, because the Quix
# state volume is mounted owned by root and only root can create the Grafana
# subdirectory on it and copy the database in and out. It drops to uid 472 itself
# immediately before starting Grafana, so the server still runs unprivileged -- see
# the su invocation in deploy/entrypoint.sh.

# GF_PATHS_DATA is deliberately NOT set: Grafana's SQLite database must stay at the
# image default, on container-local disk. The state volume is CIFS-backed and cannot
# grant the exclusive locks SQLite needs, so a database opened there hangs on its first
# migration with SQLITE_BUSY. Only a *copy* of the file goes to the volume, taken by
# the entrypoint. For the same reason there is no GF_DATABASE_* here either.
#
# GF_PATHS_PLUGINS is NOT set and must NOT be pointed at the state volume. The
# quix-samples Grafana image does exactly that; copying it here would break this image,
# because our plugin is baked into /var/lib/grafana/plugins at build time and
# repointing the variable would hide it behind an empty volume.
#
# GF_PATHS_PROVISIONING stays on the image filesystem: the entrypoint writes it at boot
# from the environment and from the baked templates, so it is derived state and needs
# no volume. (The datasource within it is seeded only when no database was restored --
# see deploy/entrypoint.sh.)
ENV GF_PATHS_PROVISIONING=/var/lib/grafana/provisioning \
    # Unsigned is fine on self-hosted Grafana, which is what a Quix deployment is.
    # This is precisely why deploying here does not wait on Grafana Labs signing.
    GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=${PLUGIN_ID} \
    GF_ANALYTICS_REPORTING_ENABLED=false \
    GF_ANALYTICS_CHECK_FOR_UPDATES=false

ENTRYPOINT ["/usr/local/bin/quix-entrypoint.sh"]
