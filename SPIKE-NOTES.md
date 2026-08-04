# SPIKE-NOTES — quix-quixlakehouse-datasource

Running progress log. Newest section last. Ticket sc-74412, spike phase.

## Environment probed (before any code)

| Thing | Result |
|---|---|
| Go | `go1.26.1 windows/386` — **32-bit host toolchain**. Cross-compiles to `linux/amd64` fine (verified). |
| Node / npm | v24.14.1 / 11.11.0 |
| mage | **not installed** on PATH |
| Grafana (running) | 13.1.1, host port 3001, network `quixdatalaketimeseries_test-network` |
| `flight-sql` | brought up with `docker compose -f docker-compose.integration-test.yml up -d flight-sql`; listening `grpc://0.0.0.0:32010` |

## Item 0 — transport driver decision (brief's "key question")

**Question:** does Arrow ship a usable Flight SQL `database/sql` driver in Go, so
`sqlds` can delete most of the backend?

**Answer: the driver exists, at `github.com/apache/arrow-go/v18/arrow/flight/flightsql/driver`
(module `github.com/apache/arrow-go/v18`, latest `v18.7.0`, Apache-2.0). It connects,
authenticates with a bearer token, and returns correct values. But it is NOT usable
with `sqlds`, so we are NOT using sqlds.**

Evidence — `rows.ColumnTypes()` through the driver against the live server:

```
ts_ms    DatabaseTypeName="" ScanType=interface {} Nullable=(false,ok=false)
val      DatabaseTypeName="" ScanType=interface {} Nullable=(false,ok=false)
circuit  DatabaseTypeName="" ScanType=interface {} Nullable=(false,ok=false)
flag     DatabaseTypeName="" ScanType=interface {} Nullable=(false,ok=false)
```

`driver.Rows` implements only `Columns()`, `Next()`, `Close()` — it does not implement
`driver.RowsColumnTypeDatabaseTypeName`, `RowsColumnTypeScanType`, or
`RowsColumnTypeNullable`. `sqlds` / `sqlutil.FrameFromRows` select converters by
`DatabaseTypeName()`; with `""` for every column nothing matches and field typing
collapses. It also throws away the Arrow schema (`int64`, `float64`) that we need to
decide "is this column epoch-millis time?" — brief item 6.

**Decision: hand-written `QueryData` over the native `flightsql.Client`, Arrow →
`data.Frame` directly.** Still take the cheap, transport-independent part of the sqlds
family: `sqlutil.Interpolate` + `sqlutil.Macros` from `grafana-plugin-sdk-go`
(Apache-2.0) for the macro engine. This matches spec §4's "take the sqlds saving where
it is cheap and transport-independent".

Verified working against live `flight-sql:32010` before writing any plugin code:

```
--- NATIVE flightsql.Client: SELECT timestamp, speed_kmh FROM test_telemetry LIMIT 5
  ARROW SCHEMA:
    timestamp      int64 (nullable=true)
    speed_kmh      float64 (nullable=true)
  row 0: [1785836694257 204.44]
  total rows: 5
```

## Pre-existing stack bug found while probing (NOT mine, outside my directory)

Intermittent, self-healing query failures from the API's DuckDB httpfs:

```
IO Error: Could not connect to server error for HTTP HEAD to
'http://minio:9000/.../test_telemetry/year%3D2026/circuit%3Dmonaco/
 session_type%3Dpractice/data_<CHANGES EVERY RUN>.parquet'
```

- The referenced parquet filename is **different on every failure**.
- `minio` is `healthy`; Python `urllib` inside `test-api` reaches
  `http://minio:9000/minio/health/live` → 200 at the same moment DuckDB cannot.
- Fails in bursts, then recovers with no intervention; all three query shapes
  (real query, `LIMIT 0` probe, `LIMIT 1` probe) pass once recovered.

Reading: the data-generator/sink is writing continuously and compaction rewrites
files; the catalog hands DuckDB a file list that momentarily references objects that
have just been replaced/deleted. DuckDB's httpfs reports a 404/403 HEAD as
"Could not connect to server", which sends you looking for a network fault that
isn't there. Reported, not fixed — outside `quix-ts-datalake-grafana/`.

---

## Plugin id — rename inventory

The id `quix-quixlakehouse-datasource` is **not final**. Public-catalog publication
requires the first segment to be our grafana.com organisation slug, and that org has
not been claimed yet — it may end up `quix` or `quixio`. Grafana validates ids
against `^[0-9a-z]+\-([0-9a-z]+\-)?(app|panel|datasource)$`, and changing the id
after dashboards reference it orphans every saved panel, so this must be settled
before anything is shared.

Centralised where a programming language allowed it; the rest is a mechanical list.

| # | File | What to change | Centralised? |
|---|---|---|---|
| 1 | `pkg/plugin/ids.go` | `PluginID`, `ExecutableName` constants | **Yes** — the only place Go spells it. `pkg/main.go` reads `plugin.PluginID`. |
| 2 | `.env` | `PLUGIN_ID=` | **Yes** — `docker-compose.dev.yml` uses `${PLUGIN_ID}` for the plugin dir mount, the unsigned-plugins allowlist and the log filter. |
| 3 | `src/plugin.json` | `"id"`, `"executable"` | No — JSON cannot reference a constant. |
| 4 | `provisioning/datasources/quixlakehouse.yml` | `type:` | No — must equal the plugin id. |
| 5 | `go.mod` + Go import paths | module `github.com/quix/quixlakehouse` | Independent of the plugin id; only worth changing if the repo moves. |
| 6 | `.config/` (`docker-compose-base.yaml`, `supervisord/supervisord.conf`) | container name, mount paths, `gpx_` glob | Tool-managed by `@grafana/create-plugin`; regenerated by `npx @grafana/create-plugin update`. Not used by our `docker-compose.dev.yml`. |
| 7 | `dist/gpx_quixlakehouse_<os>_<arch>` | binary filename | Derived from `executable` in `plugin.json` (item 3). |
| 8 | `README.md`, `ARCHITECTURE.md`, this file | prose references | Docs only. |

Renaming = edit items 1–4 (+7 rebuild), then `docker compose -f docker-compose.dev.yml up -d --force-recreate`.

## Public-repo hygiene

This tree is destined to be a public GitHub repo. Checked:

- `LICENSE` is **Apache-2.0** (scaffolded by `create-plugin`, which is itself
  Apache-2.0). Kept as-is; it is the right licence for the Grafana plugin ecosystem
  and compatible with `sqlds` / `clickhouse-datasource`, whose patterns we follow.
  Grafana core is AGPLv3 — read for structure, never copied.
- The only credential in the tree is `test-token-123`, which is already public in
  the committed `docker-compose.integration-test.yml`.
- No real endpoints, workspace ids, PATs, or the billing-sink URL were copied in.
- Removed from the scaffold before it could be committed: `.claude/`, `.codex/`,
  `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` (a nested `CLAUDE.md` would silently inject
  instructions into future agent sessions), `.github/workflows/` (this repo's CI is
  Azure DevOps `builds/ci.yml`, so they would be dead files advertising a CI that
  does not run), and the scaffold's `docker-compose.yaml` (superseded by
  `docker-compose.dev.yml`, which targets the real lakehouse).
- Removed `tests/configEditor.spec.ts` and `tests/queryEditor.spec.ts`: scaffold
  sample Playwright specs bound to the example query model (`constant`, `queryText`,
  `apiKey`) that no longer exists. Real tests are Tester's deliverable.

## Items 1–3, 8, 9 — scaffold, plugin.json, config editor, compose, provisioning

- Scaffolded with `npx @grafana/create-plugin@7.9.1 --plugin-type=datasource
  --plugin-name=quixlakehouse --org-name=quix --backend`. **The tool refuses to run
  on Windows** ("Create plugin does not support Windows. Please use WSL.") — ran it
  in a `node:24-bookworm` container with the target dir bind-mounted. It emitted the
  wanted id `quix-quixlakehouse-datasource` and `executable: gpx_quixlakehouse`
  without any editing.
- `plugin.json`: added `alerting: true`, `category: sql`, real name `QuixLakeHouse`,
  description/keywords. Kept the scaffold's `grafanaDependency: >=12.3.0`, which
  Grafana 13.1.1 satisfies. `annotations`/`logs`/`tracing`/`streaming` are explicitly
  `false` — declaring a capability that is not implemented makes Grafana offer a
  broken UI.
- `go.mod`: scaffold pinned `go 1.26.3` but the local toolchain is 1.26.1, which
  would force a toolchain download; lowered to `go 1.25.0`. Promoted
  `github.com/apache/arrow-go/v18 v18.7.0` and `google.golang.org/grpc` to direct
  requires.
- Config editor: host / port / bearer token (`secureJsonData.token`) / TLS toggle /
  skip-verify / timeout. Functional and unstyled — FrontEndEsthetic owns polish.
- `docker-compose.dev.yml`: stock `grafana/grafana:13.1.1`, host port **3002**,
  `dist/` mounted at `/var/lib/grafana/plugins/${PLUGIN_ID}`, joined to
  `quixdatalaketimeseries_test-network` as an **external** network so this file can
  never create or remove the running stack's network.

---

## Plugin id — CONFIRMED FINAL

Mid-spike update: the grafana.com org slug is **`quix`**, so
**`quix-quixlakehouse-datasource` is final**. No rename is pending. The inventory table
above is retained as documentation — useful if a second plugin (e.g. a panel plugin)
is ever added under the same org prefix, and as the checklist if the id ever does move.

## Items 4–7 — CheckHealth, QueryData, time handling, macros

All implemented and verified against the live `flight-sql:32010`.

**Item 4 — CheckHealth.** `SELECT 1` over the same connection a real query uses.
Deliberately touches no object storage, so green means "endpoint reachable + token
accepted" and nothing else. All five failure modes distinguished, measured:

| Condition | Message |
|---|---|
| wrong port | `Cannot reach the Flight SQL server at flight-sql:39999 -- check host, port, and that the service is running.` |
| unknown host | `Cannot reach the Flight SQL server at no-such-host:32010 -- ...` |
| bad token | `Authentication rejected by flight-sql:32010 -- check the API token in the datasource settings.` |
| TLS on vs plaintext server | `TLS mismatch talking to flight-sql:32010 -- the server and the TLS toggle disagree.` |
| no token | `No API token configured. Add the QuixLake token in the datasource settings.` |
| success | `Connected to QuixLake Flight SQL at grpc://flight-sql:32010.` |

**Item 5 — QueryData.** Arrow record batches → `data.Frame` directly, one typed column
at a time, no row-oriented intermediate. Nullable Arrow columns become pointer slices so
NULL stays `nil`.

**Item 6 — time handling.** `test_telemetry.timestamp` (INT64 epoch ms) → Grafana
`type=time`, `frame=time.Time`. `timefmt.go` also covers `epoch_s` / `epoch_us` /
`epoch_ns` / native `timestamp`, because a seconds column rendered as millis lands in
1970. Driven by an explicit `timeFormat` query field rather than a heuristic or a
per-panel `/schema` call (spec §9.4 warns against doubling request volume).

**Item 7 — macros.** Backend-side via `sqlutil.Interpolate` + a custom `sqlutil.Macros`
map. `$__timeFilter`, `$__timeFrom()`, `$__timeTo()`, `$__timeGroup(col, interval)`.
`$__from` / `$__to` / `$__interval` are deliberately NOT implemented as standalone
macros — they are Grafana globals the frontend substitutes as bare epoch millis, so a
backend implementation would make dashboards and alerts disagree.

Interval units all map, including the four the Python implementation gets wrong:

```
1ms -> INTERVAL '1 milliseconds'      3d -> INTERVAL '3 days'
30s -> INTERVAL '30 seconds'          1w -> INTERVAL '1 weeks'    <- Python emits '1w' (invalid)
5m  -> INTERVAL '5 minutes'           1M -> INTERVAL '1 months'   <- unmapped in Python
2h  -> INTERVAL '2 hours'             1y -> INTERVAL '1 years'    <- unmapped in Python
```

**Gotcha found:** `sqlutil.Interpolate` applies macros longest-name-first, so
`timeGroup` (9 chars) expands before `interval` (8). `$__timeGroup(ts, $__interval)`
therefore hands the handler the *literal* `$__interval` string. `macros.go` detects that
and resolves it from `query.Interval`; without it you silently get
`INTERVAL '$__interval'`.

## Items 10–11 — build/run docs, checkpointing

`mage -v build:linux` verified working (needs `go install github.com/magefile/mage@latest`;
mage was not on PATH). It produces a stripped 26 MB binary vs 40 MB from plain
`go build`. **`mage` does not set the executable bit** on a Windows filesystem — without
`chmod +x` Grafana never logs "Successfully started backend plugin process". Both
binaries were verified to run under Grafana.

## Build/toolchain notes worth keeping

- Local Go is **`windows/386`** (32-bit). It cross-compiles to `linux/amd64` fine,
  including the whole arrow-go + grpc graph. Odd base for a release pipeline though.
- Scaffold pinned `go 1.26.3` in `go.mod` while the local toolchain is 1.26.1, which
  would force a toolchain download; lowered to `go 1.25.0`.
- `@grafana/create-plugin` **refuses to run on Windows**. Used a `node:24-bookworm`
  container with the target dir bind-mounted. Git Bash also mangles `-v` paths — needs
  `MSYS_NO_PATHCONV=1`.
- Grafana caches the plugin process: after a backend rebuild you must
  `docker compose -f docker-compose.dev.yml restart grafana`.
- Grafana logs `level=error "Failed to read plugin provisioning files from directory"`
  for each missing `provisioning/*` subdir. Added `.gitkeep` in `plugins/`,
  `dashboards/`, `alerting/`, `notifiers/` so a demo log is clean.

## Two spec assertions that are wrong as written

1. **Spec T2 asserts `GET /api/plugins/<id>/settings` reports `backend: true` and
   `alerting: true`. That endpoint does not return those fields at all in Grafana
   13.1.1** — the keys are simply absent, so a probe reads `None` for *any* plugin,
   including this one, which demonstrably runs a backend process. That makes spec §1's
   evidence row "Plugin manifest: `backend: None`, `alerting: None`" a **measurement
   artefact**, not evidence about simpod. (The `plugin.unavailable` rows in that table
   are real evidence.)
   Correct probe — verified: `GET /api/frontend/settings` →
   `datasources.<name>.meta` → `backend=True, alerting=True, metrics=True,
   category='sql'`.
2. Spec §12 asks for the unsigned-plugins flag and a `dist/` mount in the **root**
   `docker-compose.integration-test.yml`. Out of bounds for this spike, so not done; the
   equivalent lives in `quix-ts-datalake-grafana/docker-compose.dev.yml` on port 3002.

## Blocking bug found in quix-ts-datalake-api (NOT fixed — outside my directory)

**The Arrow output path is materially less reliable than the CSV path, and the Flight
transport depends on Arrow.**

Measured on identical SQL, interleaved within the same second:

```
csv:   OK OK OK OK OK OK        (6/6)
arrow: OK FAIL FAIL ...         (fails repeatedly)
```

And failure scales with the number of files scanned:

```
SELECT timestamp, speed_kmh FROM test_telemetry
  WHERE year=2026 AND circuit='monaco' AND session_type='practice'   -> 1/1 OK
SELECT timestamp, speed_kmh FROM test_telemetry LIMIT 5              -> 0/8 FAIL
```

Error, naming a **different parquet file every time**:

```
IO Error: Could not connect to server error for HTTP HEAD to
'http://minio:9000/.../test_telemetry/year%3D2026/circuit%3D<varies>/...parquet'
```

while `minio` reports `healthy` and Python `urllib` *inside* `test-api` reaches
`http://minio:9000/minio/health/live` → 200 at the same moment DuckDB cannot.

Prime suspect: the lazy streaming reader at `query_manager.py:549-550`
(`con.execute(...)` then `result.fetch_record_batch(chunk_size)`), where the parquet
HTTP reads happen while the generator yields — i.e. after the request handler has
returned — rather than inside the request. The CSV path does not stream the same way.

Needs a red integration test in `quix-ts-datalake-api` first, per `CLAUDE.md`. **This is
the single biggest risk to the Flight transport** and it is not a plugin bug.

## Status: end-to-end vertical slice WORKING

- `POST /api/datasources/uid/quixlake-flight/health` → `{"status":"OK"}`
- `POST /api/ds/query` → real frames, `timestamp` as a Grafana time field
- `/api/frontend/settings` → `backend=True, alerting=True, category='sql'`
- No `plugin.unavailable` anywhere

Caveat: use partition filters, per the API bug above.

---

# ROUND 2 — transport reversed: Flight SQL -> REST

Ludvík's decision after reading the round-1 findings: "do the REST now." Recorded
here rather than rewritten into the history, so the reversal stays auditable.

## Why the reversal (round-1 findings drove it)

1. **The sqlds discovery removed Flight's main advantage.** Flight was attractive
   because Arrow's Flight SQL `database/sql` driver plus `sqlds` promised to delete
   most of the backend. Round 1 measured that the driver exposes no
   `ColumnTypeDatabaseTypeName` / `ScanType` / `Nullable`, so `sqlds` cannot type
   fields from it. The saving does not exist.
2. **`quix-ts-datalake-flight` is a translator, not a fast path.** It converts Flight
   calls into REST calls to the same API. So Flight meant
   plugin -> Flight -> REST API -> storage: one extra hop and one extra tier-1
   service, ending in the same place. Arrow already comes out of REST via
   `?format=arrow`.
3. **gRPC ingress is still unvalidated** in Quix Cloud; REST is already deployed and
   proxied everywhere.

Flight is **not** deleted from the product — it remains the BI-tool path (DBeaver,
Tableau, ADBC). We simply do not build the Grafana plugin on it.

## Correction to my round-1 report (I was wrong)

I reported that "`format=arrow` is materially less reliable than `format=csv`". The
coordinator could not reproduce it and was right to push back. **I now have the root
cause of my own bad measurement:**

**The running `test-api` container is not the working tree.**

```
grep -c 'Skip the LIMIT file-cap path when client requested Arrow' :
  inside test-api container : 0
  working tree              : 1
```

The container also has gzip helper code at lines 424-436 that the working tree does
not have at all, so the image is from a different lineage, not merely older. My
csv-vs-arrow comparison ran against a build that lacks the `want_arrow` file-cap
fix, so the two formats took genuinely different code paths in *that image* and my
conclusion did not generalise. Lesson recorded: verify the deployed artifact matches
the tree before attributing behaviour to the tree.

**What is actually happening** is file-count-dependent and format-independent, as the
coordinator said: an hour-plus of sink writes at `TARGET_FILE_SIZE_MB: 1` has caused
a small-file explosion (the sink logs `Wrote 10 rows` / `uploaded 6 file(s)` every
few seconds). Any query touching many files fails with
`IO Error: Could not connect to server ... HTTP HEAD to http://minio:9000/...` while
MinIO itself is healthy. Not a plugin bug and not an API-code bug.

## Round-2 design decision: keep the direct client, do NOT adopt sqlds

The brief made sqlds optional and asked for a justification either way. **Keeping the
hand-written client.** Reasons, in order of weight:

1. **Wrapping REST in a `database/sql` driver is strictly more code, not less.** It
   means implementing `driver.Conn`, `driver.Stmt`, `driver.Rows` plus the three
   `ColumnType*` interfaces, all so that `sqlds` can then convert rows into frames.
   The existing REST client plus both frame converters is smaller than that adapter
   would be on its own.
2. **`database/sql` is row-oriented; Arrow IPC is columnar.** We would flatten Arrow
   into `driver.Value` rows and let `sqlds` re-columnarise them — the same
   double-transpose that made the Flight driver unattractive, on the highest-volume
   path in the system.
3. **The 200-with-error-body detection needs the raw HTTP response.** Status code,
   `Content-Type`, and a body prefix all have to be inspected together.
   `database/sql` gives no seam for that; the information would have to be smuggled
   out through driver error strings.
4. **Content-type dispatch has nowhere to live in a `database/sql` driver.** The API
   answers CSV on some paths even when Arrow is requested, so the decoder must be
   chosen per response.
5. **The genuinely valuable part of the sqlds family is already in use** —
   `sqlutil.Interpolate` / `sqlutil.Macros` — and it is transport-independent, so it
   costs nothing to keep.

## The three error shapes on POST /query — all measured

| # | Trigger | HTTP | Content-Type | Body |
|---|---|---|---|---|
| 1 | pre-execution failure | **500** (or 400/499) | `application/json` | `{"error": "..."}` |
| 2 | CSV path fails after the header was flushed | **200** | `text/csv` | starts with / contains `# ERROR: ...` |
| 3 | Arrow path fails after the header was flushed | **200** | `application/vnd.apache.arrow.stream` | **empty (0 bytes)** |

Shape 2 is the one the brief flagged, and it is as dangerous as advertised: read
naively, an error string renders in a panel as if it were a value.

**Shape 3 was not in the brief and is worse in one specific way.** Arrow IPC has no
in-stream error channel, so `main.py:545-551` logs the exception and closes the
stream — producing an empty body. But the API *also* returns an empty body for a
legitimately empty result (`main.py:438-446`, empty-partition detection). The two are
**indistinguishable on the wire**, and taking an empty body at face value reports a
failed query as "no data" — which for an alert rule means NoData instead of an error.

Measured, same query, same moment:

```
SELECT count(*) AS n FROM test_telemetry
  ?format=csv   -> 200  text/csv                             body: "# ERROR: IO Error: ..."
  ?format=arrow -> 200  application/vnd.apache.arrow.stream   body: 0 bytes
```

**Mitigation implemented:** when an Arrow response comes back empty, re-issue the
same SQL once over CSV purely to disambiguate. If CSV reports `# ERROR:`, surface it
as a query error; if CSV is cleanly empty, return the empty frame. This costs one
extra query only in the empty case, never on the happy path. It should be deleted
once the API gains a real error channel for Arrow (e.g. an Arrow schema-level
metadata error field, or a trailing sentinel batch).

Verified end to end through Grafana:

| Case | Result |
|---|---|
| `SELECT count(*) FROM test_telemetry` (fails, 200 + no payload) | `frames: 0`, `errorSource: downstream`, DuckDB error text surfaced — **no data frame** |
| `SELECT timestamp FROM test_telemetry WHERE year='1999'` (genuinely empty) | `frames: 1`, 0 rows, **no error** — no false positive |
| `SELECT no_such_column ...` (SQL error) | `frames: 0`, error surfaced |

## Second discovery: `?format=arrow` is not always honoured

Measured against the deployed API:

```
SELECT 1 AS x                                          -> arrow.stream  (magic ffffffff)
SELECT 1 AS x LIMIT 1                                  -> arrow.stream  (magic ffffffff)
SELECT timestamp FROM test_telemetry ... (no LIMIT)     -> arrow.stream  (magic ffffffff)
SELECT timestamp FROM test_telemetry ... LIMIT 5        -> text/csv      ("time...")
SELECT timestamp FROM test_telemetry ... LIMIT 999999   -> text/csv      ("time...")
```

A `LIMIT` against a real table takes the file-cap branch, which materialises through
pandas and serialises CSV regardless of the requested format. The working tree has a
fix for this (`if want_arrow: limit_n = None`) that the deployed image lacks — so
this specific behaviour may already be resolved in master.

**Either way the client must dispatch on the `Content-Type` it actually received,
not on the one it asked for.** Production images lag the tree, and the API's own
comment calls CSV "the default (legacy UI + grafana consumers)". Hence both an
`arrowBodyToFrame` and a `csvBodyToFrame` path. Assuming Arrow because Arrow was
requested would have misparsed a CSV body into garbage — a bug that would only have
shown up on `LIMIT` queries.

## What carried over vs what was rewritten

**Carried over unchanged:** `macros.go` (all four macros, the 8-unit interval fix, the
`$__timeGroup(col, $__interval)` ordering workaround), `timefmt.go`, `ids.go`,
`frames.go` column builders / time-column selection / nullability handling,
`QueryEditor.tsx`, `module.ts`, `datasource.ts`, `docker-compose.dev.yml`, `.env`,
the exec-bit workaround, and the whole scaffold.

**Rewritten:** `flight.go` -> `rest.go` (HTTP client, three-shape error detection,
content-type dispatch, error classification). `models/settings.go` (URL now comes
from Grafana's standard `url` field, which also supplies TLS/proxy options;
host/port/TLS toggles replaced by `unionByName` + `timeoutSeconds`).
`datasource.go` (REST client, empty-Arrow disambiguation, decode dispatch).
`ConfigEditor.tsx` (URL + token + unionByName + timeout).
`provisioning/datasources/quixlakehouse.yml` (`url: http://api:80`, uid
`quixlake-rest`).

**Added:** `csvframe.go` — CSV -> frame with per-column type inference, needed because
the API does not always honour `?format=arrow`.

**Deleted:** `pkg/plugin/flight.go`.

`frames.go` needed only one structural change: `readerToFrame(*flight.Reader)` became
`recordsToFrame(recordStream)` against a small local interface, plus
`arrowBodyToFrame` to wrap `ipc.NewReader`. Depending on an interface rather than
Flight's concrete reader is what kept the transport swap cheap.

## Round-2 verification status

| Check | Result |
|---|---|
| `Save & test` -> `http://api:80` | `{"message":"Connected to the QuixLake API at http://api:80.","status":"OK"}` |
| `/api/frontend/settings` meta | `backend=True, alerting=True, metrics=True, category=sql` |
| 200-with-error surfaced as a query error | **PASS** |
| genuinely empty result not turned into an error | **PASS** |
| typed frame incl. NULL preservation | **PASS** (see below) |
| real `test_telemetry` data | blocked by the small-file explosion, see below |

The lakehouse degraded during round 2 to the point where **every** query against
`test_telemetry` fails, including the narrowest partition filter
(`year='2026' AND circuit='monaco' AND session_type='practice'`) which worked in
round 1. `/tables` lists only `test_telemetry`, so there is no smaller table to fall
back to. The type/time/NULL mapping was therefore proven with a storage-free query:

```
SELECT * FROM (VALUES (1785835622423::BIGINT, 155.47::DOUBLE, 'monaco'), ...)
  AS t(timestamp, speed_kmh, circuit)

  timestamp   grafana_type=time    go_type=time.Time  nullable=True
  speed_kmh   grafana_type=number  go_type=float64    nullable=True
  circuit     grafana_type=string  go_type=string     nullable=True
  meta.type: timeseries-wide
  1785835622423 -> 2026-08-04T09:27:02.423Z
  NULL speed_kmh preserved as null (not coerced to 0)
```

**Recommendation for the environment:** the stack needs a compaction run, or a
restart with a larger `TARGET_FILE_SIZE_MB`, before it can serve queries against
`test_telemetry` again. That is an environment action for Ludvík, not a code change,
and it is outside `quix-ts-datalake-grafana/`.
