# Deploying Grafana with the QuixLakeHouse datasource

A self-contained Grafana image with the plugin baked in, runnable locally and
deployable to Quix Cloud from the same artifact.

**Unsigned plugins load fine on self-hosted Grafana**, and a Quix deployment is
self-hosted. So this path needs nothing from Grafana Labs — no signature, no
catalog submission, no review queue. That only becomes necessary for Grafana Cloud.

## Contents

| File | Purpose |
| --- | --- |
| `Dockerfile` | 3-stage build: frontend → Go backend → stock Grafana with both baked in |
| `entrypoint.sh` | Renders the datasource provisioning file from env vars, then runs Grafana |
| `provisioning/datasources/quixlakehouse.yml.tpl` | Datasource template with `__PLACEHOLDER__` tokens |
| `../app.yaml` | Quix application descriptor (at repo root, so the build context is the repo) |

## Why the plugin is baked in

Rather than `GF_INSTALL_PLUGINS` with a GitHub release URL: Quix environments are
not guaranteed egress to GitHub — the lakehouse images already bake DuckDB
extensions for air-gapped clusters — so downloading at boot would add a runtime
dependency on the internet. Baking makes the boot deterministic.

## Which credentials, and why

The datasource needs two values:

| Value | Env var |
| --- | --- |
| Query API base URL | `Quix__Lakehouse__Query__Url` |
| Bearer token | `Quix__Lakehouse__Query__AuthToken` |

Two traps, both already paid for elsewhere:

1. **Not `Quix__Sdk__Token`.** The Query Engine runs cluster-global in
   `quixdev-global` and rejects cross-environment SDK tokens — the same wall the
   billing integration hit, which is why the dev billing sink ended up running
   with auth disabled. `Quix__Lakehouse__Query__AuthToken` is minted for this.
2. **Not `CATALOG_URL` / `QUIX_LAKE_URL`.** Those are legacy aliases for the
   *in-cluster Iceberg catalog*, not the public Query API, and will not serve
   `/query`.

On **dev**, both inject only when the deployment has `blobStorage: bind: true` —
even though Grafana never touches blob storage. The bind is the injection vehicle
for the whole lakehouse bundle. On **BYOX**, nothing auto-injects; declare them as
deployment variables. `entrypoint.sh` aborts at boot with this explanation rather
than starting a Grafana whose datasource silently cannot connect.

## Stage 1 — local, against the local integration stack

Proves the Dockerfile, the entrypoint's rendering, the provisioning template and
unsigned plugin loading. No platform credentials needed.

```bash
# 1. Bring up the lakehouse stack in the Quix.DataLake.Timeseries repo:
docker compose -f docker-compose.integration-test.yml up -d api

# 2. Build this image from the repo root (NOT from deploy/):
docker build -f deploy/Dockerfile -t quixlakehouse-grafana:dev .

# 3. Run it on the integration network so it can reach the API by name:
docker run -d --name quixlakehouse-grafana \
  --network quixdatalaketimeseries_test-network \
  -p 3003:3000 \
  -e QUIXLAKE_URL=http://api:80 \
  -e QUIXLAKE_TOKEN=test-token-123 \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  quixlakehouse-grafana:dev

# 4. The check that matters -- server-side, the call a frontend-only plugin cannot serve:
curl -s -u admin:admin -X POST \
  http://localhost:3003/api/datasources/uid/quixlakehouse/health
```

Expect `{"status":"OK", ...}`. Port 3003 avoids 3001 (integration stack Grafana)
and 3002 (`docker-compose.dev.yml`).

> When querying, use **partition-filtered** SQL with a `LIMIT`. Wide scans against
> a long-running local stack fail on blob-storage connection exhaustion after the
> sink has produced thousands of 1 MB files — a harness artefact, not a plugin bug.

## Stage 2 — local, against the real dev lakehouse

Same image, real credentials. This retires the auth risk before any deployment
exists, so a later failure is unambiguously about injection or ingress.

```bash
docker run -d --name quixlakehouse-grafana-dev \
  -p 3003:3000 \
  -e QUIXLAKE_URL='https://<current-lh-query-host>' \
  -e QUIXLAKE_TOKEN='<Quix__Lakehouse__Query__AuthToken>' \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  quixlakehouse-grafana:dev
```

Get both from the lakehouse deployment's variables in the Quix portal, or via the
`quix` CLI. Do not reuse the URL in `quix-ts-datalake-ui/svelte-app/.env` — it is
stale and its host 404s at the ingress.

## Stage 3 — deploy to Quix Cloud

`app.yaml` declares the bind and the variables. In `quix.yaml`, the deployment
block needs the bind as a sibling of `variables`, not inside it:

```yaml
  - name: quixlakehouse-grafana
    application: quixlakehouse-grafana
    deploymentType: Service
    version: latest
    resources:
      cpu: 500
      memory: 1000
      replicas: 1
    publicAccess:
      enabled: true
      urlPrefix: grafana
    network:
      serviceName: grafana
      ports:
        - port: 80
          targetPort: 3000
    variables:
      - name: GF_SECURITY_ADMIN_PASSWORD
        inputType: Secret
        value: grafana_admin_password
      - name: GF_SERVER_ROOT_URL
        inputType: FreeText
        value: https://grafana-<workspace>.deployments-dev.quix.io
    blobStorage:
      bind: true
```

Watch the `port` / `targetPort` mapping: Grafana listens on 3000, and a mismatch
here produces silent timeouts rather than an error — the same class of trap the
Flight server documents for `FLIGHT_SQL_PORT`.

## Known gap: persistence

Grafana keeps dashboards, users and alert rules in SQLite at
`/var/lib/grafana/grafana.db`, which is **not persisted** across redeploys here.
The datasource survives because it is re-provisioned at every boot, but anything
created through the UI is lost. Two ways out, both later work:

1. Provision dashboards and alert rules as code — drop them in
   `deploy/provisioning/dashboards/` and `deploy/provisioning/alerting/`, which the
   entrypoint copies through untouched. They then live in git, which is where they
   belong.
2. Point Grafana at an external Postgres (`GF_DATABASE_*`).

Option 1 is preferable until someone actually needs UI-authored dashboards to
survive.
