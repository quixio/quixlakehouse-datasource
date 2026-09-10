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
| `entrypoint.sh` | Points Grafana at the state volume, seeds the datasource from env vars on first boot, drops to uid 472, then runs Grafana |
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
  -v quixlakehouse-grafana-state:/tmp/grafana-state \
  -e Quix__Deployment__State__Path=/tmp/grafana-state \
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

`Quix__Deployment__State__Path` is **required** — the entrypoint exits rather than
run a Grafana that forgets everything (see [Persistence](#persistence)). In a Quix
deployment the platform injects it; locally you supply it, pointing at a mounted
volume so the second run finds the first run's database.

> When querying, use **partition-filtered** SQL with a `LIMIT`. Wide scans against
> a long-running local stack fail on blob-storage connection exhaustion after the
> sink has produced thousands of 1 MB files — a harness artefact, not a plugin bug.

## Stage 2 — local, against the real dev lakehouse

Same image, real credentials. This retires the auth risk before any deployment
exists, so a later failure is unambiguously about injection or ingress.

```bash
docker run -d --name quixlakehouse-grafana-dev \
  -p 3003:3000 \
  -v quixlakehouse-grafana-state:/tmp/grafana-state \
  -e Quix__Deployment__State__Path=/tmp/grafana-state \
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
block needs the bind — and `state` — as siblings of `variables`, not inside it:

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
    state:
      enabled: true
      size: 1
```

`state: enabled: true` is **not optional** and cannot be declared from this repo —
`app.yaml` has no state block, so it belongs to the pipeline repo's `quix.yaml`.
Quix mounts the volume and injects its path as `Quix__Deployment__State__Path`;
without it the entrypoint exits at boot. See [Persistence](#persistence).

Watch the `port` / `targetPort` mapping: Grafana listens on 3000, and a mismatch
here produces silent timeouts rather than an error — the same class of trap the
Flight server documents for `FLIGHT_SQL_PORT`.

## Persistence

Grafana keeps dashboards, users, alert rules and datasource settings in a SQLite
database. The entrypoint puts that database on the **Quix state volume**, so all of
it survives a restart or a redeploy.

| What | Where |
| --- | --- |
| Database, sessions, alert state (`GF_PATHS_DATA`) | `$Quix__Deployment__State__Path/grafana/data` |
| Logs (`GF_PATHS_LOGS`) | `$Quix__Deployment__State__Path/grafana/logs` |
| Seed marker | `$Quix__Deployment__State__Path/grafana/.datasource-provisioned` |
| Plugin (`GF_PATHS_PLUGINS`) | `/var/lib/grafana/plugins` — **image, not volume** |
| Rendered provisioning (`GF_PATHS_PROVISIONING`) | `/var/lib/grafana/provisioning` — image, re-rendered each boot |

The path is read from `Quix__Deployment__State__Path`, which Quix injects **only
when the deployment has state enabled**. There is no hardcoded fallback: if the
variable is missing the entrypoint exits with an explanation instead of starting a
Grafana that quietly discards everything. The `state: enabled: true` declaration
lives in the pipeline repo's `quix.yaml` — see [Stage 3](#stage-3--deploy-to-quix-cloud).

Because the state mount arrives owned by root, the image does **not** declare
`USER 472`. The entrypoint creates and chowns the Grafana directories as root, then
drops to uid 472 (`su`) before exec'ing Grafana, which
therefore still runs unprivileged.

> **`GF_PATHS_PLUGINS` must stay off the state volume.** The `quix-samples` Grafana
> image points it at `/app/state/grafana/plugins`; copying that here breaks this
> image, because our plugin is baked into `/var/lib/grafana/plugins` at build time
> and an empty volume would hide it. The plugin ships with the image on purpose —
> that is what makes a redeploy the way to upgrade it.

### Datasource provisioning is seed-only

Grafana re-applies provisioning at **every** boot, overwriting whatever a
provisioned datasource's fields were changed to in the UI. Persisting the database
alone would therefore not have fixed the reported symptom — a corrected URL or
token reverting on restart. So the entrypoint renders
`provisioning/datasources/*.tpl` only when the seed marker above is absent.

Dropping the rendered file on later boots does not delete the datasource: Grafana
leaves an existing provisioned datasource in place when its provisioning file
disappears. The row, with any UI edits, stands.

To deliberately re-seed from the environment — say the datasource has been edited
into a broken state — set `QUIXLAKE_FORCE_PROVISION=true` for one boot. It
overwrites UI edits by design; remove it afterwards.

Everything **other** than datasources (`dashboards`, `alerting`, `notifiers`,
`plugins`) is still copied through on every boot. Those are code-managed, have no
UI-edit story to protect, and re-applying them is how a redeploy ships changes.

### Still provision dashboards and alert rules as code

Not a workaround any more, just good practice: drop them in
`deploy/provisioning/dashboards/` and `deploy/provisioning/alerting/`. They then
live in git, are reviewable, and are reproducible in a fresh environment — which a
UI-authored dashboard on one volume is not.
