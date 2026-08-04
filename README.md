# QuixLakeHouse Grafana data source plugin

A first-party Grafana data source plugin that queries the **Quix Lakehouse** over the
**REST API** (`POST /query`, Arrow IPC). It has a Go backend, so queries run inside
grafana-server: dashboards, Explore, a working server-side "Save & test", and **alert
rules** on lakehouse data.

- Plugin id: `quix-quixlakehouse-datasource`
- Backend binary: `gpx_quixlakehouse`
- Transport: HTTP `POST {url}/query?format=arrow` (SQL as a `text/plain` body)
- Status: **spike** — raw SQL only. See [ARCHITECTURE.md](ARCHITECTURE.md) §8 for the gap list.

> An earlier revision of this plugin used Arrow Flight SQL. It was retargeted to REST
> because `quix-ts-datalake-flight` is a translation layer over this same API (an extra
> hop for no added capability), and because the `sqlds` code saving that justified
> Flight turned out not to exist. ARCHITECTURE.md §2 records the full reasoning.
> Flight remains the right path for BI tools (DBeaver, Tableau, ADBC).

Licensed under **Apache-2.0** — see [LICENSE](LICENSE). Dependencies
(`grafana-plugin-sdk-go`, `arrow-go`, `@grafana/create-plugin`) are Apache-2.0 too.
Grafana core is AGPLv3 and no code from it is used here.

---

## Prerequisites

| Tool | Version used | Notes |
|---|---|---|
| Go | 1.25+ | `go.mod` declares `go 1.25.0` |
| Node | 22+ | `.nvmrc` says 22; 24 also works |
| mage | 1.17+ | `go install github.com/magefile/mage@latest` |
| Docker | any recent | for the dev Grafana |

`@grafana/create-plugin` (only needed to re-scaffold) **does not run on Windows** — use
WSL or a `node:24-bookworm` container.

---

## Build

```bash
cd quix-ts-datalake-grafana

# Frontend -> dist/module.js, dist/plugin.json
npm ci
npm run build

# Backend -> dist/gpx_quixlakehouse_linux_amd64
mage -v build:linux
chmod +x dist/gpx_quixlakehouse_linux_amd64   # required; mage does not set it on Windows
```

`mage -v build:all` cross-compiles every platform. Without mage:

```bash
GOOS=linux GOARCH=amd64 go build -o dist/gpx_quixlakehouse_linux_amd64 ./pkg
```

> Grafana will not launch the plugin if the binary lacks the executable bit. The symptom
> is `Successfully started backend plugin process` never appearing in the Grafana log.

---

## Run

The dev stack is a **stock** Grafana with `dist/` bind-mounted — the same way a user
installs a plugin. It does not run its own lakehouse; it joins the integration stack's
network so it can reach `api:80` directly (the same service is `localhost:8080` from the
host).

```bash
# 1. From the repo root: the lakehouse. `flight-sql` is NOT needed.
docker compose -f docker-compose.integration-test.yml up -d

# 2. From this directory: Grafana with the plugin.
docker compose -f docker-compose.dev.yml up -d
```

Open <http://localhost:3002> (admin/admin). Port **3002**, because the integration
stack's own Grafana already owns 3001.

The datasource is pre-provisioned as **QuixLakeHouse**, uid `quixlake-rest`
(`provisioning/datasources/quixlakehouse.yml`) pointing at `http://api:80`, so it
exists on boot. Open it and click **Save & test**:

```
Connected to the QuixLake API at http://api:80.
```

Teardown (only ever touches this file's container):

```bash
docker compose -f docker-compose.dev.yml down
```

---

## Try a query

New dashboard → new panel → datasource **QuixLakeHouse**:

```sql
SELECT timestamp, speed_kmh
FROM test_telemetry
WHERE $__timeFilter(timestamp)
  AND year = 2026 AND circuit = 'monaco' AND session_type = 'practice'
ORDER BY timestamp
```

Leave **Format** = `Time series` and **Time format** = `Epoch milliseconds`.

> **Always include partition filters** (`year`, `circuit`, `session_type`). Unpruned
> full-table scans currently fail intermittently against the local stack — an API-side
> Arrow-path bug, not a plugin bug. ARCHITECTURE.md §7 item 1.

### Macros

Expanded in the **backend**, so they work in alert rules too (an alert rule has no
browser, so frontend-interpolated variables do not exist there).

| Macro | `epoch_ms` column | native `TIMESTAMP` column |
|---|---|---|
| `$__timeFilter(col)` | `col >= 1785835272409 AND col <= 1785838872409` | `col >= '2026-08-04T09:21:58Z' AND col <= '...'` |
| `$__timeFrom()` / `$__timeTo()` | `1785835272409` | `'2026-08-04T09:21:58Z'` |
| `$__timeGroup(col, 1m)` | `time_bucket(INTERVAL '1 minutes', epoch_ms(col))` | `time_bucket(INTERVAL '1 minutes', CAST(col AS TIMESTAMP))` |
| `$__timeGroup(col, $__interval)` | interval taken from the panel | same |

Interval units: `ms`, `s`, `m`, `h`, `d`, `w`, `M`, `y`.

`$__from`, `$__to` and `$__interval` on their own are **Grafana global variables**, not
plugin macros — the frontend replaces them with bare epoch milliseconds before the
backend sees them. Use `$__timeFrom()` / `$__timeTo()` instead so dashboards and alerts
agree. (`$__interval` *is* honoured inside `$__timeGroup`.)

### Why "Time format" matters

QuixLake time-series tables store time as an **INT64 epoch**, not a native `TIMESTAMP` —
`test_telemetry.timestamp` is epoch milliseconds. The backend needs to know that both to
compare `$__timeFilter` against an integer instead of a string, and to turn the column
into a real Grafana time field. Getting it wrong is the difference between a rendered
chart and an empty panel (or timestamps in 1970).

---

## Iterating

**Backend:**

```bash
mage -v build:linux && chmod +x dist/gpx_quixlakehouse_linux_amd64
docker compose -f docker-compose.dev.yml restart grafana
```

Grafana caches the plugin process, so a restart is required. Backend logs:

```bash
docker logs -f quixlakehouse-plugin-dev-grafana 2>&1 | grep quixlakehouse
```

`GF_LOG_FILTERS` already sets this plugin to `debug`, so every executed SQL statement is
logged.

**Frontend:**

```bash
npm run dev        # webpack watch; rewrites dist/module.js
```

Then hard-reload the browser — no Grafana restart needed for frontend-only changes.

---

## Configuration

| Field | Storage | Default | Notes |
|---|---|---|---|
| API URL | Grafana's standard `url` field | — | e.g. `http://api:80`. The **API root** — no `/grafana` suffix. Using the standard field gives the backend TLS + proxy options for free. |
| API token | `secureJsonData.token` | — | sent as `Authorization: Bearer <token>`; accepts the static API token or a Quix platform token / PAT. Encrypted at rest; never returned to the browser. |
| Union by name | `jsonData.unionByName` | `true` | maps to `?union_by_name=true`, so schema drift across files does not break `SELECT *` |
| Query timeout (s) | `jsonData.timeoutSeconds` | `60` | per-query budget |

All are settable from provisioning YAML.

---

## Layout

```
pkg/
  main.go                 datasource.Manage(plugin.PluginID, ...)
  models/settings.go      jsonData + secureJsonData
  plugin/
    ids.go                plugin id / binary name constants
    datasource.go         QueryData + CheckHealth, query model
    rest.go               POST /query, error detection, content-type dispatch
    frames.go             Arrow record batches -> data.Frame
    csvframe.go           CSV -> data.Frame (the API does not always honour ?format=arrow)
    macros.go             $__timeFilter / $__timeFrom / $__timeTo / $__timeGroup
    timefmt.go            epoch-vs-timestamp model
src/
  plugin.json             backend: true, alerting: true, category: sql
  module.ts, datasource.ts, types.ts
  components/ConfigEditor.tsx, QueryEditor.tsx
provisioning/datasources/quixlakehouse.yml
docker-compose.dev.yml
.env                      PLUGIN_ID / GRAFANA_PORT / GRAFANA_VERSION
```

UI is functional and unstyled by design — visual polish is a separate pass.

---

## Known limitations

Full list in [ARCHITECTURE.md](ARCHITECTURE.md) §7. The ones you will hit first:

1. **Queries touching many files fail** against a churned local stack — the sink writes
   ~6 tiny files every few seconds, so a wide scan must HEAD thousands of objects and
   MinIO starts refusing connections. Use partition filters; if even those fail, the
   stack needs compaction. Not a plugin bug.
2. **Raw SQL only** — no visual builder, no dashboard variables, no ad-hoc filters, no
   annotations.
3. **`maxDataPoints` is not pushed down** — a panel returns whatever the SQL returns.
4. **An empty result costs one extra query.** Arrow has no error channel, so an empty
   Arrow body is ambiguous (failed vs genuinely empty) and the plugin re-asks over CSV
   once to disambiguate. Never on the happy path. ARCHITECTURE.md §5.
5. **Queries are attributed to `source="api"`**, not to Grafana.
6. **Unsigned** — needs `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` and Grafana shows a
   warning banner.
7. **`linux/amd64` only**, no CI stage.
8. **The whole result is buffered in memory** before the frame is built — no result-size
   ceiling yet. ARCHITECTURE.md §8.
