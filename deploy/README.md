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
| `entrypoint.sh` | Restores Grafana's database from the state volume, seeds the datasource on first boot, starts the 10-second backup loop, then execs Grafana |
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
    # Required for persistence. Without it Quix does not inject
    # Quix__Deployment__State__Path, and the entrypoint has nowhere to copy the
    # Grafana database to -- see "Persistence" below.
    state:
      enabled: true
      size: 1
```

Watch the `port` / `targetPort` mapping: Grafana listens on 3000, and a mismatch
here produces silent timeouts rather than an error — the same class of trap the
Flight server documents for `FLIGHT_SQL_PORT`.

## Persistence

**What survives:** the whole Grafana database — the datasource URL and token as
edited in Connections > Data Sources, plus dashboards, alert rules, users, API keys
and everything else Grafana keeps in SQLite.

**How:** `entrypoint.sh` copies `/var/lib/grafana/grafana.db` to
`<state>/grafana/grafana.db` **every 10 seconds**, and copies it back before Grafana
starts on the next boot. The copy loop is a background child started before the
entrypoint execs Grafana; it survives the exec and runs until the container stops.
Each copy is written to a `.tmp` and renamed, so a restore never reads a half-written
file, and the loop holds an `flock` on the state volume so two containers cannot
interleave.

**Why a copy and not the live database.** The obvious move — point `GF_PATHS_DATA` at
the state mount — does not work and will waste a day if you retry it. The volume is
CIFS-backed and cannot grant the exclusive POSIX locks SQLite needs, so Grafana loops
forever on its first migration with `SQLITE_BUSY` and never listens. Proven three
times on the real deployment. Ordinary reads, writes, `cp` and `mkdir` on that volume
all work fine; only SQLite's live locking fails. So the database stays on
container-local disk and only a copy of the file travels.

**The failure window.** There is **no copy at shutdown**. Every stop — a graceful
`docker stop`, a Quix redeploy, an OOM kill, node loss — loses whatever changed since
the last periodic copy, so **up to 10 seconds**. That is acceptable because of what is
being persisted: a datasource URL and an API token typed once, and dashboards and
alert rules edited by hand. Ten seconds after saving any of those, it is on the
volume; nobody saves a datasource and redeploys in the same breath, and if they do,
they retype one field. Buying the last ten seconds back meant supervising Grafana
from the entrypoint instead of exec'ing it, which was tried and reversed — the
shutdown copy never actually ran (`su` does not forward signals to its child, and the
supervising shell died inside its own trap), so the mechanism that was supposed to
guarantee zero loss was in practice writing nothing at all.

A periodic copy skips its turn if a `grafana.db-journal` sits beside the database,
meaning a transaction is in flight; that is what keeps a hot copy consistent, since
Grafana 13 runs SQLite with `wal = false`. One copy is taken immediately at boot, so a
container stopped inside the first ten seconds still leaves a usable database.

**State must be enabled on the deployment.** The entrypoint reads
`Quix__Deployment__State__Path`, which Quix injects only when the deployment has
`state: enabled: true` — and that declaration lives in the *pipeline* repo's
`quix.yaml`, not in this repo's `app.yaml`. Without it there is nowhere to copy to,
so persistence silently does not happen: Grafana logs a warning at boot and runs with
the old behaviour, re-seeding the datasource from the environment every time and
forgetting everything else. This is deliberately a warning and not a fatal error —
an earlier version aborted here and took the deployment down.

`QUIXLAKE_FORCE_PROVISION=true` re-seeds the datasource from the environment on the
next boot, overwriting UI edits. It is the way back from a datasource edited into a
broken state.

Dashboards and alert rules can still be provisioned as code instead — drop them in
`deploy/provisioning/dashboards/` and `deploy/provisioning/alerting/`, which the
entrypoint copies through on every boot. That keeps them in git, which is a better
home for them than a database copy regardless of this mechanism.
