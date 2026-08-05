# Development Guidelines — QuixLakeHouse Grafana data source plugin

## What this repo is

A first-party Grafana **data source plugin** (`quix-quixlakehouse-datasource`) that
lets Grafana query the Quix Lakehouse with SQL. It replaces the third-party
`simpod-json-datasource` plus the `/grafana/*` shim in the lakehouse API.

**Why it exists** (lead with this, it is the whole justification): a frontend-only
datasource cannot serve Grafana's *server-side* query path — `POST /api/ds/query`
and `POST /api/datasources/uid/<uid>/health` both return `plugin.unavailable`. That
means **no alert rules, no recorded queries, no public dashboards on lakehouse
data**. Grafana's plugin schema makes `alerting: true` invalid without
`backend: true`, so only a plugin with a backend closes the gap.

Tracking: Shortcut **sc-74412**. Full spec in `docs/internal/spec.md` (gitignored —
this repo is public and the spec is not).

## Relationship to the lakehouse repo

The services this plugin talks to live in a **separate, private** repo,
`Quix.DataLake.Timeseries`: the Query API (`quix-ts-datalake-api`), the Iceberg
catalog, the sink, and the Arrow Flight server. This repo contains **only** the
plugin and its deployment. Do not vendor lakehouse code here.

Consequence for CI: the real-stack integration harness (api + catalog + MinIO
images) lives in that private repo behind ACR auth, so a GitHub runner cannot pull
it. Plan accordingly — either a fake `/query` server for this repo's CI, or run
real-stack e2e in the lakehouse repo's pipeline.

## Transport: REST. Do not re-propose Flight.

The plugin talks to the API's `POST /query` with `?format=arrow`. Arrow Flight SQL
was **built first and then reversed**, and the reasons are measured, not
aesthetic:

1. The Flight `database/sql` driver (`arrow-go/v18`) exposes no
   `ColumnTypeDatabaseTypeName` / `ScanType`, so `grafana/sqlds` cannot type
   fields — every column arrives as `interface{}`. The sqlds reuse that justified
   Flight does not exist on that path.
2. `quix-ts-datalake-flight` is a *translation layer over the same REST API*, so
   Flight meant an extra hop and an extra tier-1 deployable.
3. gRPC ingress through the Quix platform is unvalidated; trailer-stripping
   proxies turn DuckDB errors into hangs.

`sqlds` was also rejected **for REST**: `database/sql` is row-oriented and would
reintroduce the transposes that disqualified Flight. We use a direct client plus
`sqlutil.Interpolate`/`Macros` (transport-independent). Flight remains the BI-tool
path (DBeaver/Tableau/ADBC) and is not our concern here.

## Licensing — this matters

Apache-2.0. **Grafana core is AGPLv3.** Read `pkg/tsdb/influxdb` and
`public/app/plugins/datasource/influxdb` for patterns if useful, but **never copy
code from Grafana core into this repo** — it would pull copyleft into a plugin we
ship. Copy freely from Apache-2.0 sources: `grafana-plugin-sdk-go`,
`grafana/sqlds`, `grafana/clickhouse-datasource` (the closest precedent — external,
Go backend, `category: sql`).

## Naming constraints

- Plugin id `quix-quixlakehouse-datasource`: `quix` is our **grafana.com org slug**
  (org ID 1866430). Final — the id is painful to change after catalog publication.
- Go binary must keep Grafana's `gpx_` prefix: `gpx_quixlakehouse`.
- Centralised in `pkg/plugin/ids.go` and `.env` (`PLUGIN_ID`). It is also spelled in
  `src/plugin.json`, `provisioning/datasources/quixlakehouse.yml` and the
  tool-managed `.config/` files — see the rename inventory in `SPIKE-NOTES.md`.

## Testing requirements

Cover functionality with tests that can run in CI. **If a bug is reported, write a
failing test first, then fix it** — a finding with no red test is a hypothesis, not
a bug.

Four layers, cheapest first:

1. **Go unit tests** — macro expansion, epoch conversion, Arrow→frame, error
   classification. This is where the logic risk actually lives.
2. **The headline regression test** — assert `POST /api/ds/query` returns frames.
   Plain HTTP, no browser, and it is exactly the call a frontend-only plugin
   cannot serve, so it doubles as the acceptance criterion.
3. **Playwright e2e** (`playwright.config.ts`, `tests/`) — Grafana with the plugin
   mounted, driving the config and query editors.
4. **Alerting proof** — a provisioned alert rule that evaluates. Nothing else
   demonstrates the feature this plugin exists for.

### Test traps specific to the lakehouse

- **Always use partition-filtered SQL with a `LIMIT`** (e.g. `WHERE year='2026'`).
  Wide scans against a long-running local stack fail with
  `IO Error: Could not connect to server ... HTTP HEAD to http://minio:9000/...`
  once the sink has written thousands of ~1 MB files. That is a harness artefact,
  **not** a plugin bug, and it will waste your afternoon if you assume otherwise.
- **`format=arrow` is not less reliable than `format=csv`.** Both fail identically
  on the above. Do not design around a phantom Arrow bug.
- **The API signals some failures with HTTP 200.** `SELECT count(*)` can return
  `200` with a body starting `# ERROR: IO Error: ...`, while `SELECT *` returns
  `500` with JSON. A third shape is worse: on `?format=arrow` a *mid-stream*
  failure has no error channel at all, and an empty Arrow body is also the
  legitimate empty-partition response — so it is indistinguishable from "no data"
  and renders as an **empty panel**. Treat a truncated IPC stream as an error.
- **Time columns are INT64 epoch millis**, not native timestamps. Conversion is
  explicit via the query's `timeFormat` field (`epoch_ms|epoch_s|epoch_us|epoch_ns|
  timestamp`) — deliberately not heuristic.
- **Macros must expand backend-side.** Do not use `$__from`/`$__to`: Grafana
  interpolates those globals frontend-side as bare epoch ms before any backend sees
  them, and alerting has no frontend at all. Use `$__timeFilter(col)`,
  `$__timeFrom()`, `$__timeTo()`, `$__timeGroup()`.

## Local development

```bash
npm ci && npm run build     # frontend -> dist/
mage -v                     # Go backend -> dist/gpx_quixlakehouse_*
docker compose -f docker-compose.dev.yml up -d    # stock Grafana on :3002, dist/ mounted
```

`docker-compose.dev.yml` joins the lakehouse repo's integration network, so bring
that up first: `docker compose -f docker-compose.integration-test.yml up -d api`.

Deliberately a **stock** Grafana image with `dist/` bind-mounted — that is how a
user installs a plugin, so if it loads there it loads for them.

> The sink in that harness crash-loops with `401` because
> `quix-ts-datalake-sink/main.py` reads only `Quix__Lakehouse__Catalog__AuthToken`
> and ignores the documented `CATALOG_AUTH_TOKEN`. Supply the former via a compose
> override. It is a bug in that repo, not your setup.

## Deployment

See `deploy/README.md`. Two things that will bite:

- **`blobStorage: bind: true` is required on Quix dev** even though Grafana never
  touches blob storage — the bind is the injection vehicle for the whole
  `Quix__Lakehouse__*` bundle. Without it the vars are simply absent. On BYOX
  nothing auto-injects; declare them as deployment variables.
- **Use `Quix__Lakehouse__Query__AuthToken`, never `Quix__Sdk__Token`.** The Query
  Engine runs cluster-global in `quixdev-global` and rejects cross-environment SDK
  tokens — the same wall the billing integration hit. And use
  `Quix__Lakehouse__Query__Url`, not `CATALOG_URL`/`QUIX_LAKE_URL`, which are
  legacy aliases for the in-cluster Iceberg catalog and will not serve `/query`.

Unsigned plugins load fine on self-hosted Grafana, so a Quix deployment needs
nothing from Grafana Labs. Signing/catalog publication is only required for Grafana
Cloud.

## Contributing flow

`main` is owned by `@quixio/customer-success` via `.github/CODEOWNERS`, with
`@quixio/quix-saas` co-listed on `/pkg/` and the build/publish paths. Changes go
through a pull request with code-owner approval.

## Billing awareness

Every panel refresh is a **billable lakehouse query** — a 20-panel dashboard on 10s
auto-refresh is 120 queries/minute with nobody watching. So: preserve the
`maxDataPoints` push-down, and keep Grafana traffic distinguishable in billing via
a `source` tag. The credit/rate formula (sc-73900) does not exist yet; do not invent
one here.
