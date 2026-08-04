# Architecture — QuixLakeHouse Grafana data source plugin

Spike for Shortcut **sc-74412**. Spec: `dev-planning/quixlakehouse-grafana-datasource/spec.md`.
Progress log, measurements and the transport reversal: [SPIKE-NOTES.md](SPIKE-NOTES.md).

---

## 1. What this is

A first-party Grafana data source plugin, id `quix-quixlakehouse-datasource`, that
queries the Quix Lakehouse over the **REST API** (`POST /query`, Arrow IPC) and
renders the result as Grafana data frames. It has a **Go backend**
(`backend: true`), so every query executes inside grafana-server rather than in the
user's browser: dashboards, Explore, "Save & test", recorded queries, shared
dashboards, and — the reason the ticket exists — **alert rule evaluation**.

The plugin it replaces, `simpod-json-datasource`, is frontend-only. Grafana's schema
makes `alerting: true` invalid without `backend: true`, so today a customer cannot put
an alert rule on data that lives in QuixLake, and the config page's "Save & test"
returns `{"statusCode":500,"messageId":"plugin.unavailable"}`. This spike closes that:
server-side health returns `{"status":"OK"}` and `POST /api/ds/query` returns
correctly-typed frames.

**Spike scope.** Raw SQL only. No visual query builder, no dashboard variables, no
ad-hoc filters, no annotations, no logs/traces, no `maxDataPoints` push-down.
Section 8 is the honest gap list.

---

## 2. Transport: REST, after an explicit reversal from Arrow Flight SQL

**This plugin was first built on Arrow Flight SQL and then retargeted to REST.** The
history is recorded rather than tidied away, because the reasoning is the most
reusable output of the spike.

### Why Flight was chosen first

Flight promised a large code saving: Arrow ships a Flight SQL `database/sql` driver in
Go, and `github.com/grafana/sqlds/v4` builds macros, row→frame conversion, health
checks and error classification on top of any `database/sql` driver. That would have
deleted most of the backend.

### Why Flight was abandoned

1. **The `sqlds` saving does not exist.** Measured against the live Flight server, the
   driver (`github.com/apache/arrow-go/v18/arrow/flight/flightsql/driver`, v18.7.0)
   connects and returns correct values, but its `Rows` implements only
   `Columns/Next/Close`. No `ColumnTypeDatabaseTypeName`, no `ColumnTypeScanType`, no
   `ColumnTypeNullable`:

   ```
   ts_ms    DatabaseTypeName="" ScanType=interface {} Nullable=(false,ok=false)
   val      DatabaseTypeName="" ScanType=interface {} Nullable=(false,ok=false)
   circuit  DatabaseTypeName="" ScanType=interface {} Nullable=(false,ok=false)
   ```

   `sqlds` selects converters from `DatabaseTypeName()`. With `""` for every column,
   field typing collapses. The single biggest argument for Flight evaporated.

2. **`quix-ts-datalake-flight` is a translator, not a fast path.** It turns Flight
   calls into REST calls to the same API. Building on it meant
   `plugin → Flight → REST API → storage`: an extra network hop and an extra tier-1
   service, ending in exactly the same place. Arrow already comes out of REST via
   `?format=arrow`.

3. **gRPC through the Quix Cloud ingress is unvalidated.** Flight needs end-to-end
   HTTP/2 with trailer support. REST over HTTP/1.1 is already deployed and proxied
   everywhere.

4. **Flight doubles the billable query count.** Its schema probe issues a separate
   `LIMIT 0` query per statement (`api_client.py:198-226`), so every panel refresh
   would bill twice on a surface that is already a query amplifier.

Flight is **not** deleted from the product. It remains the BI-tool path (DBeaver,
Tableau, Power BI, ADBC), which is what it is good at. It is simply not the right
substrate for this plugin.

### Decision: keep the hand-written client, do not adopt `sqlds`

With REST, `sqlds` became optional again — it would require wrapping REST in a
`database/sql` driver. We did not, for five reasons:

1. **It is strictly more code, not less.** A `database/sql` adapter means
   implementing `driver.Conn`, `driver.Stmt`, `driver.Rows` *plus* the three
   `ColumnType*` interfaces, all so `sqlds` can then convert rows into frames. That
   adapter alone would be larger than the current REST client and both frame
   converters combined.
2. **`database/sql` is row-oriented; Arrow IPC is columnar.** We would flatten Arrow
   into `driver.Value` rows and let `sqlds` re-columnarise — the same double transpose
   that made the Flight driver unattractive, on the highest-volume path we have.
3. **The 200-with-error-body detection needs the raw HTTP response.** Status code,
   `Content-Type` and a body prefix must be inspected together (see §5).
   `database/sql` offers no seam for that; the information would have to be smuggled
   through driver error strings.
4. **Content-type dispatch has nowhere to live in a driver.** The API answers CSV on
   some paths even when Arrow is requested, so the decoder is chosen per response.
5. **The valuable part of the `sqlds` family is already in use.**
   `sqlutil.Interpolate` + `sqlutil.Macros` from `grafana-plugin-sdk-go` power the
   macro engine, and they are transport-independent — they operate on a SQL string and
   a time range. This is exactly the split spec §4 recommended.

### Licensing

Everything is Apache-2.0: the `create-plugin` scaffold, `grafana-plugin-sdk-go`,
`arrow-go`, and this plugin's own `LICENSE`. **Grafana core is AGPLv3** — its InfluxDB
datasource was read for structure and never copied. Pattern references are
`grafana/clickhouse-datasource` and `grafana/sqlds`, both Apache-2.0.

---

## 3. The API contract

Verified against `quix-ts-datalake-api` and
`test/test_duckdb_read_only_statements_integration.py:31-40`:

```
POST {url}/query?format=arrow&union_by_name=true
Authorization: Bearer <token>
Content-Type: text/plain
Accept: application/vnd.apache.arrow.stream

SELECT timestamp, speed_kmh FROM test_telemetry WHERE timestamp >= 1785835272409 ...
```

- **SQL is the raw request body**, not a JSON field.
- **Auth is a bearer token.** `auth.py:26-42` accepts either the static
  `API_AUTH_TOKEN` or any Quix platform token / PAT via
  `quixportal.validate_permissions`, so one config field covers both.
- **The URL points at the API root** — no `/grafana` suffix. That legacy prefix is the
  simpod contract; this plugin uses `/query`.
- The URL lives in Grafana's **standard `url` field**, not in `jsonData`, so the
  backend inherits TLS options, proxy configuration and the standard HTTP middleware
  chain from Grafana's `httpclient` provider.

---

## 4. Component responsibilities

| File | Responsibility |
|---|---|
| `pkg/main.go` | Entry point. `datasource.Manage(plugin.PluginID, ...)`. |
| `pkg/plugin/ids.go` | Plugin id and `gpx_` binary name as Go constants — the only place Go spells them. |
| `pkg/models/settings.go` | Decodes `jsonData` (`unionByName`, `timeoutSeconds`) and `secureJsonData` (token), applies defaults. |
| `pkg/plugin/rest.go` | HTTP client, `POST /query`, **all three error shapes**, content-type dispatch, error classification. |
| `pkg/plugin/frames.go` | Arrow record batches → `data.Frame`; time-column selection; nullability. |
| `pkg/plugin/csvframe.go` | CSV → `data.Frame` with per-column type inference, for when the API does not honour `?format=arrow`. |
| `pkg/plugin/macros.go` | `$__timeFilter`, `$__timeFrom`, `$__timeTo`, `$__timeGroup`; Grafana→DuckDB interval mapping. |
| `pkg/plugin/timefmt.go` | The epoch-vs-timestamp model shared by macros and both frame converters. |
| `pkg/plugin/datasource.go` | `QueryData`, `CheckHealth`, the query model, the empty-Arrow disambiguation. |
| `src/components/ConfigEditor.tsx` | Settings page: URL, token (`secureJsonData`), union-by-name, timeout. Unstyled. |
| `src/components/QueryEditor.tsx` | Raw-SQL textarea + format / time column / time format. Unstyled. |
| `src/datasource.ts` | `DataSourceWithBackend` — routes everything through `/api/ds/query`. |

---

## 5. Data flow

```
Grafana panel  OR  alert rule evaluator
        │                    │
        │  (browser)         │  (no browser — this is why macros are backend-side)
        ▼                    ▼
        POST /api/ds/query   (grafana-server, server-side)
                     │
                     ▼
   ┌──────────────────────────────────────────────────┐
   │ gpx_quixlakehouse  (Go, this plugin)             │
   │                                                  │
   │ 1. queryModel <- query.JSON                      │
   │      rawSql, format, timeColumn, timeFormat      │
   │ 2. sqlutil.Interpolate  (macros.go)              │
   │      $__timeFilter(timestamp)                    │
   │        -> timestamp >= 1785835272409             │
   │           AND timestamp <= 1785838872409         │
   │ 3. POST {url}/query?format=arrow                 │
   │      body = SQL (text/plain)                     │
   │      Authorization: Bearer <token>               │
   │ 4. INSPECT THE RESPONSE (rest.go)                │
   │      non-2xx JSON     -> error                   │
   │      200 + "# ERROR:" -> error                   │
   │      200 + empty arrow-> re-ask as CSV           │
   │      else dispatch on Content-Type               │
   │ 5. arrowBodyToFrame / csvBodyToFrame             │
   │      int64 epoch ms -> []*time.Time              │
   │      float64        -> []*float64                │
   └──────────────────────────────────────────────────┘
                     │ HTTP/1.1
                     ▼
   quix-ts-datalake-api      (DuckDB, partition pruning, SAG scoping)
                     ▼
              S3 / MinIO / Azure / GCS  (Parquet)
```

### Never treat HTTP 200 as success

The API has **three** distinct failure shapes, all measured:

| # | Trigger | HTTP | Content-Type | Body |
|---|---|---|---|---|
| 1 | pre-execution failure | 500 / 400 / 499 | `application/json` | `{"error": "..."}` |
| 2 | CSV path fails after the header was flushed | **200** | `text/csv` | contains `# ERROR: ...` |
| 3 | Arrow path fails after the header was flushed | **200** | `arrow.stream` | **empty (0 bytes)** |

Shape 2 exists because the CSV response is streamed: the 200 header is on the wire
before execution finishes, so a mid-stream failure can only be reported as a comment
line inside the body (`main.py:576`). Reading that as data would render an error
string in a panel as if it were a value — the worst failure mode available to us.
`findCSVError` scans every line for the sentinel, and **partial rows plus an error are
treated as an error**, not as partial success: a half-complete series silently
rendered as a full one is worse than a visible failure.

**Shape 3 is subtler and was not anticipated.** Arrow IPC has no in-stream error
channel, so the handler logs the exception and closes the stream
(`main.py:545-551`), yielding an empty body. But the API *also* returns an empty body
for a legitimately empty result (`main.py:438-446`, empty-partition detection). The
two are **indistinguishable on the wire**. Measured on the same query at the same
moment:

```
SELECT count(*) AS n FROM test_telemetry
  ?format=csv   -> 200  text/csv       body: "# ERROR: IO Error: ..."
  ?format=arrow -> 200  arrow.stream   body: 0 bytes
```

Taken at face value, a failed query would be reported as "no data" — and for an alert
rule that means NoData instead of an error, which is a silent monitoring gap.

**Mitigation:** when an Arrow response is empty, re-issue the same SQL **once** over
CSV purely to disambiguate. If CSV reports `# ERROR:`, surface it as a query error; if
CSV is cleanly empty, return the empty frame. This costs one extra query only in the
empty case, never on the happy path. It should be deleted once the API grows a real
error channel for Arrow (an Arrow schema-metadata error field, or a trailing sentinel
batch). Verified:

| Case | Result |
|---|---|
| `SELECT count(*) FROM test_telemetry` (fails, 200 + no payload) | `frames: 0`, `errorSource: downstream`, DuckDB text surfaced — **no data frame** |
| `SELECT timestamp FROM test_telemetry WHERE year='1999'` (really empty) | `frames: 1`, 0 rows, **no error** — no false positive |
| `SELECT no_such_column ...` | `frames: 0`, error surfaced |

### Dispatch on the content type received, not the one requested

`?format=arrow` is **not always honoured**. Measured against the deployed API:

```
SELECT 1 AS x                                        -> arrow.stream (ffffffff)
SELECT 1 AS x LIMIT 1                                -> arrow.stream (ffffffff)
SELECT timestamp FROM test_telemetry ... (no LIMIT)   -> arrow.stream (ffffffff)
SELECT timestamp FROM test_telemetry ... LIMIT 5      -> text/csv     ("time...")
SELECT timestamp FROM test_telemetry ... LIMIT 999999 -> text/csv     ("time...")
```

A `LIMIT` against a real table takes the file-cap branch, which materialises through
pandas and serialises CSV. The working tree contains a fix for this
(`if want_arrow: limit_n = None`) that the **deployed image lacks**, so this may
already be resolved in `master`. Regardless, the client dispatches on the actual
`Content-Type`: production images lag the tree, and the API's own comment calls CSV
"the default (legacy UI + grafana consumers)". Assuming Arrow because Arrow was
requested would misparse a CSV body into garbage — a bug that would surface only on
`LIMIT` queries.

The cost of the CSV path is real and worth stating: DuckDB's declared types are gone
and must be re-inferred, an all-NULL column is indistinguishable from empty text, and
DECIMAL/TIME precision is lost. That is precisely why Arrow is requested first.

### Where macros expand, and why it matters

**In the Go backend, before the SQL leaves the process.** Alert rule evaluation runs
inside grafana-server with no browser, so no frontend template interpolation happens.
A macro implemented in TypeScript works on a dashboard and silently breaks the moment
someone puts an alert on that panel — the one capability this ticket exists to deliver.

`$__from`, `$__to` and `$__interval` are deliberately **not** implemented as
standalone macros: they are Grafana *global built-in variables* that the frontend
substitutes as bare epoch milliseconds before a datasource sees them, so a backend
implementation would guarantee dashboards and alerts disagree. The repo's existing
server-side path uses that spelling (`grafana_query_builder.py:161-171`) and inherits
the collision. `$__interval` *is* honoured as the second argument to `$__timeGroup`,
resolved from `backend.DataQuery.Interval`.

Verified expansions:

| Written | `timeFormat` | Expanded |
|---|---|---|
| `$__timeFilter(timestamp)` | `epoch_ms` | `timestamp >= 1785835272409 AND timestamp <= 1785838872409` |
| `$__timeFilter(ts)` | `timestamp` | `ts >= '2026-08-04T09:21:58Z' AND ts <= '2026-08-04T10:21:58Z'` |
| `$__timeFrom()`, `$__timeTo()` | `epoch_ms` | `1785835272409`, `1785838872409` |
| `$__timeFrom()`, `$__timeTo()` | `timestamp` | `'2026-08-04T09:21:58Z'`, `'2026-08-04T10:21:58Z'` |
| `$__timeGroup(timestamp, 1m)` | `epoch_ms` | `time_bucket(INTERVAL '1 minutes', epoch_ms(timestamp))` |
| `$__timeGroup(ts, 5m)` | `timestamp` | `time_bucket(INTERVAL '5 minutes', CAST(ts AS TIMESTAMP))` |
| `$__timeGroup(timestamp, $__interval)` | `epoch_ms` | `time_bucket(INTERVAL '30 seconds', epoch_ms(timestamp))` |

Interval units `ms s m h d w M y` all map. The Python implementation
(`grafana_query_builder.py:117-122`) has no entry for `w`, `M`, `y` or `ms`, so
`$__interval` of `1w` passes through and produces the invalid `INTERVAL '1w'`. Fixed
here rather than replicated, per spec §7.

**Ordering subtlety:** `sqlutil.Interpolate` applies macros longest-name-first, so
`timeGroup` (9 chars) expands before `interval` (8). `$__timeGroup(ts, $__interval)`
therefore hands our handler the *literal string* `$__interval` as its second
argument; `macros.go` detects that and resolves it from `query.Interval`. Without it
the macro silently emits `INTERVAL '$__interval'`.

### How results become data frames

Both converters build one accumulator per column and append into typed Go slices;
there is no row-oriented intermediate on the Arrow path.

- **Nullability is honoured.** Columns become pointer slices (`[]*float64`,
  `[]*time.Time`). A NULL stays `nil` rather than becoming `0` — a NULL speed reading
  is not 0 km/h. Verified: a NULL `speed_kmh` arrives in Grafana as `null`.
- **Epoch → time.** QuixLake stores time as INT64 epoch **milliseconds**, not a native
  timestamp. Grafana renders a time series only from a real time field, so the
  designated time column is converted with `time.UnixMilli`. `timefmt.go` also covers
  seconds/micros/nanos, because a seconds column rendered as millis lands in 1970 —
  the guard the spec asks for.
- **Time column selection.** An explicit `timeColumn` wins; otherwise, for a
  `time_series` query, a name hint (`time`, `timestamp`, `ts`, `ts_ms`, `datetime`,
  `date`, `event_time`) over integer/timestamp columns. The legacy path detects by
  name only from a hardcoded list (`grafana_api.py:469-475`), so a table whose time
  column is `event_time` silently renders as a table; honouring an explicit selection
  first fixes that.
- **Time field goes first** and `Meta.Type = timeseries-wide` is declared. Ordering by
  time is the query author's job (`ORDER BY`), as with every other SQL datasource.
- **Fallback.** Decimals, intervals, lists, structs and binary render as text, so an
  exotic column degrades the panel to a table rather than failing the query.
- `Meta.ExecutedQueryString` always carries the fully expanded SQL, so Query Inspector
  shows what actually ran. Parity with `grafana_api.py:374-376`.

Measured frame:

```
timestamp    grafana_type=time    go_type=time.Time  nullable=True
speed_kmh    grafana_type=number  go_type=float64    nullable=True
circuit      grafana_type=string  go_type=string     nullable=True
meta.type = timeseries-wide
```

### CheckHealth

Runs `SELECT 1` through the same client a real query uses, then **parses the result**
rather than trusting the status code — a 200 whose body we cannot read is not a
healthy datasource. It touches no object storage, so a green result means "the API is
reachable and the token is accepted" and nothing more; probing a real table would make
health depend on the catalog and on blob storage, and would bill a query on every
settings save.

| Condition | Message |
|---|---|
| Success | `Connected to the QuixLake API at http://api:80.` |
| 401 / 403 | `Authentication rejected by <url> -- check the API token in the datasource settings.` |
| 404 | `<url>/query not found -- check the URL points at the API root, with no /grafana suffix.` |
| DNS / refused | `Cannot reach the QuixLake API at <url> -- check the URL and that the service is running.` |
| TLS | `TLS error talking to <url>: ...` |
| Timeout | `Query timed out. Raise the query timeout ... or narrow the time range.` |
| No URL / no token | explicit "not configured" messages |

Every transport failure is tagged `backend.ErrorSourceDownstream`, so a lakehouse
outage does not count against the plugin's own error-rate SLO in Grafana. SQL errors
pass through with the DuckDB text intact.

---

## 6. File inventory

Scaffolded with `npx @grafana/create-plugin@7.9.1 --plugin-type=datasource
--plugin-name=quixlakehouse --org-name=quix --backend`. **The tool refuses to run on
Windows**, so it was run in a `node:24-bookworm` container. It emitted the wanted id
and `gpx_` name with no editing.

| Path | Status |
|---|---|
| `pkg/plugin/rest.go` | **new in round 2** — HTTP client, 3-shape error detection, content-type dispatch |
| `pkg/plugin/csvframe.go` | **new in round 2** — CSV → frame with type inference |
| `pkg/plugin/flight.go` | **deleted in round 2** |
| `pkg/plugin/datasource.go` | rewritten — REST client, empty-Arrow disambiguation |
| `pkg/models/settings.go` | rewritten — standard `url` field; `unionByName` + `timeoutSeconds` |
| `src/components/ConfigEditor.tsx` | rewritten — URL + token + union-by-name + timeout |
| `provisioning/datasources/quixlakehouse.yml` | `url: http://api:80`, uid `quixlake-rest` |
| `pkg/plugin/frames.go` | carried over; `readerToFrame(*flight.Reader)` → `recordsToFrame(recordStream)` + `arrowBodyToFrame` |
| `pkg/plugin/macros.go`, `timefmt.go`, `ids.go` | carried over unchanged |
| `pkg/main.go`, `src/plugin.json`, `src/types.ts`, `datasource.ts`, `module.ts`, `QueryEditor.tsx` | carried over (types.ts trimmed) |
| `docker-compose.dev.yml`, `.env` | carried over unchanged |
| `README.md`, `ARCHITECTURE.md`, `SPIKE-NOTES.md` | docs |

Depending on a small `recordStream` interface rather than Flight's concrete reader is
what made the transport swap cheap: the whole Arrow→frame converter survived intact.

**Deleted from the scaffold:** `.claude/`, `.codex/`, `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`, `.github/workflows/`, `docker-compose.yaml`, `tests/*.spec.ts`,
`pkg/plugin/datasource_test.go`. Rationale in SPIKE-NOTES.md.

**Nothing outside `quix-ts-datalake-grafana/` was modified.**

---

## 7. Integration with neighbouring features

- **`quix-ts-datalake-api`** is the only upstream dependency, via `POST /query`.
  Partition pruning, the read-only guard, `rewrite_sql` and per-user SAG scoping are
  inherited for free — there is no second SQL rewriter to keep in sync, which is the
  duplication class `test_grafana_chat_scoping.py` exists to paper over.
- **`quix-ts-datalake-flight` is no longer on this path.** It remains the BI-tool
  entry point (DBeaver, Tableau, ADBC) and is unaffected.
- **Legacy `/grafana/*` endpoints and `simpod-json-datasource` are untouched.** Both
  datasources coexist with distinct UIDs; existing dashboards keep working. This
  plugin provisions `uid: quixlake-rest`, separate from the legacy `quixlake.yml`.
- **Billing** (`billing_client.py`): every query bills like any other. Dropping Flight
  removed the 2× billing that its `LIMIT 0` schema probe would have caused. Still
  unsolved: `source` attribution reports `api` because `POST /query` hardcodes
  `source="api"` at five call sites and no `?source=` parameter exists yet
  (spec §9.3). Note the empty-Arrow disambiguation adds a second query in the
  empty-result case only.

---

## 8. What a production version still needs

Ordered by how likely each is to bite.

1. **The API needs an error channel for Arrow.** Today an Arrow-path failure is an
   empty body, indistinguishable from an empty result. The plugin works around it with
   a CSV confirmation query; the real fix belongs in the API and would let us delete
   that. Needs a red integration test first, per `CLAUDE.md`.
2. **`source` attribution.** Until `?source=` (or `X-Quix-Query-Source`) exists,
   nobody can answer "how much of the bill is Grafana?".
3. **`maxDataPoints` push-down is not implemented.** The legacy path appends
   `LIMIT {maxDataPoints}` (`grafana_query_builder.py:296-297`), verified working
   today (50 requested → 50 returned). A raw-SQL panel here returns whatever the SQL
   returns.
4. **`timeFormat` is a manual field.** Production should cache a `GET /schema` lookup
   (60s TTL) and pre-fill it. Must be cached, not per-refresh, or we double our own
   request volume (spec §9.4).
5. **Visual query builder**, dashboard variables (`metricFindQuery`), ad-hoc filters
   (`getTagKeys`/`getTagValues`), annotations — spec §8 parity matrix, all unbuilt.
   `annotations`/`logs`/`tracing`/`streaming` are declared `false` rather than
   optimistically `true`.
6. **Alerting is declared and structurally supported but not proven end-to-end.**
   `backend: true` + `alerting: true` are live and the server-side query path works,
   which is the precondition. An actual firing alert rule is spec test T3.
7. **No result-size ceiling.** The whole response body is read into memory before the
   frame is built. A `SELECT *` on a large table will balloon the plugin process.
   Streaming the Arrow reader off `resp.Body` instead of `io.ReadAll` is the fix, but
   it conflicts with body-prefix error sniffing — needs a peek-then-stream reader.
8. **Signing.** Unsigned; the dev stack needs
   `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` and Grafana shows a warning banner.
   Private signing bakes `--rootUrls` into the signature; catalog publication is weeks
   to months (spec §11).
9. **Only `linux/amd64` is built**, and there is no CI stage. The local Go toolchain
   is `windows/386`, which cross-compiles fine but is an odd base for a release
   pipeline.
10. **The CSV fallback is lossy.** All-NULL columns, DECIMAL and TIME lose fidelity.
    Once the API reliably honours `?format=arrow` this path becomes dead code and
    should be removed rather than maintained.
11. **No retry/backoff.** A transient downstream failure fails the panel.

### Environment note, not a code gap

During round 2 the local stack degraded until **every** query against
`test_telemetry` failed, including narrow partition filters that worked earlier. The
sink is writing ~6 files every few seconds at `TARGET_FILE_SIZE_MB: 1`, so queries
must HEAD thousands of tiny objects and MinIO starts refusing connections while still
reporting healthy. The stack needs a compaction run, or a restart with a larger
target file size. Also worth knowing: **the running `test-api` image is not built from
the working tree** (it lacks the `want_arrow` file-cap fix and has gzip code the tree
does not), so behaviour measured against it does not automatically generalise to
`master`.

---

## 9. Verification checklist for Tester

I did not run any linter, formatter, type-checker or test suite. Builds and
`docker compose` only.

### Lint / static analysis scope

Everything under `quix-ts-datalake-grafana/` is new; nothing outside it changed.

| Command | Run in | Notes |
|---|---|---|
| `gofmt -l ./pkg` | plugin dir | expect empty output |
| `go vet ./...` | plugin dir | |
| `golangci-lint run` | plugin dir | scaffold ships `.golangci.yml`; file findings in `pkg/`, not `.config/` |
| `npm run lint` | plugin dir | scaffold ESLint + Prettier |
| `npm run typecheck` | plugin dir | `tsc --noEmit` |
| repo `pre-commit run --all-files` | repo root | **Confirm the Python hooks do not try to parse Go/TS in the new directory.** If `.pre-commit-config.yaml` has no exclusion for `quix-ts-datalake-grafana/`, that is a finding to file against me. |

### Build

```bash
cd quix-ts-datalake-grafana
npm ci
npm run build                 # -> dist/module.js, dist/plugin.json
mage -v build:linux           # -> dist/gpx_quixlakehouse_linux_amd64
chmod +x dist/gpx_quixlakehouse_linux_amd64
```

Both verified. `mage` needs installing (`go install github.com/magefile/mage@latest`);
plain `GOOS=linux GOARCH=amd64 go build -o dist/gpx_quixlakehouse_linux_amd64 ./pkg`
also works. **The binary needs its exec bit** — `mage` does not set it on a Windows
filesystem, and Grafana silently never logs "Successfully started backend plugin
process" without it.

### Smoke checks

Preconditions: integration stack up (`api` healthy), then
`docker compose -f docker-compose.dev.yml up -d` in the plugin dir. Grafana on 3002.
`flight-sql` is **no longer required**.

| # | Check | Expected |
|---|---|---|
| S1 | `POST localhost:3002/api/datasources/uid/quixlake-rest/health` | `{"status":"OK"}`, message names `http://api:80` |
| S2 | `/api/frontend/settings` → `datasources.QuixLakeHouse.meta` | `backend=true`, `alerting=true`, `metrics=true`, `category='sql'` |
| S3 | `POST /api/ds/query` with `rawSql` | 200; `frames[0].schema.fields[0].type == "time"`; `typeInfo.frame == "time.Time"` |
| S4 | `frames[0].schema.meta.executedQueryString` | non-empty, macros expanded |
| S5 | `$__timeFilter(timestamp)` + `timeFormat: epoch_ms` | bare integers, not quoted strings |
| S6 | `$__timeFilter(ts)` + `timeFormat: timestamp` | quoted ISO-8601 |
| S7 | `$__timeGroup(timestamp, 1w)` | `INTERVAL '1 weeks'` — the case the Python impl gets wrong |
| S8 | **`SELECT count(*) FROM test_telemetry`** (200-with-error) | `frames: []`, `errorSource: downstream`, DuckDB text in `error`. **Must NOT return a frame.** |
| S9 | a genuinely empty result, e.g. `WHERE year='1999'` | one frame, 0 rows, **no error** — guards against S8's fix over-firing |
| S10 | health with a bad token / bad URL / wrong path | three distinct messages (§5 table) |
| S11 | `docker logs quixlakehouse-plugin-dev-grafana \| grep quixlakehouse` | "Plugin registered", "Successfully started backend plugin process", no panic |
| S12 | no `plugin.unavailable` anywhere in S1 or S3 | the regression that matters |

**S8 and S9 are the pair that matters most.** S8 proves an error is never rendered as
data; S9 proves the fix does not turn every empty panel into a red banner. A change
that passes one and fails the other is a regression.

**Expect S3 to fail against a churned stack**, and do not file it against the plugin.
See §8's environment note: the small-file explosion made every `test_telemetry` query
fail. To verify the frame conversion deterministically without touching storage:

```sql
SELECT * FROM (VALUES
  (1785835622423::BIGINT, 155.47::DOUBLE, 'monaco'),
  (1785835626967::BIGINT, NULL::DOUBLE,   'suzuka')
) AS t(timestamp, speed_kmh, circuit)
```

Expected: `timestamp` → `time`/`time.Time`, `speed_kmh` → `number`/`float64` with the
NULL preserved as `null`, `circuit` → `string`, `meta.type = timeseries-wide`.

### Spec sections each code path should satisfy

| Code | Spec section |
|---|---|
| `CheckHealth` (`datasource.go`) | §1 measured gap; §6 "Save & test"; §13 Phase 0 |
| `rest.go` + `POST /query` | §4 Option 1 (REST with `format=arrow`) — the spec's original recommendation |
| `rest.go` error detection | §4's "an error channel for Arrow" requirement |
| `frames.go` epoch → time | §7 "Epoch-millis handling"; `test_grafana_epoch_millis.py` contract |
| `frames.go` time column selection | §7 "Time-series vs table format" |
| `macros.go` | §7 macro table; the `$__from`/`$__to` collision analysis |
| `plugin.json` `alerting: true` | §3 Option B; §5 flags; ticket AC |
| `ConfigEditor.tsx` token handling | §6 config page — token in `secureJsonData` only |

### Two spec assertions that are wrong as written

1. **Spec T2 says to assert `GET /api/plugins/<id>/settings` reports `backend: true`
   and `alerting: true`. That endpoint has no such keys in Grafana 13.1.1** — a probe
   reads `None` for *any* plugin, including this one, which demonstrably runs a
   backend process. Spec §1's evidence row "Plugin manifest: `backend: None`,
   `alerting: None`" is therefore a measurement artefact, not evidence about simpod.
   (The `plugin.unavailable` rows in that table *are* real evidence.) Use
   `GET /api/frontend/settings` → `datasources.<name>.meta.backend`. Adopted by the
   coordinator.
2. Spec §12 asks for `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` and a `dist/` mount
   in the **root** `docker-compose.integration-test.yml`. Out of bounds for this
   spike; the equivalent lives in `quix-ts-datalake-grafana/docker-compose.dev.yml` on
   port 3002. Wiring the root compose file is a follow-up someone must approve.
