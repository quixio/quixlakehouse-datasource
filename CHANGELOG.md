# Changelog

All notable changes to this plugin are documented here. Versions follow
[semantic versioning](https://semver.org/); dates are the date the tag was cut.

Pre-1.0 deliberately: alerting works but is not yet demonstrated end to end with a
provisioned rule, and `maxDataPoints` is not pushed down.

## 0.1.1 - unreleased

### Added

- **The Quix deployment now remembers what you type into the datasource settings
  page.** The URL and the API token entered in Connections > Data Sources — and with
  them dashboards, alert rules and users, since it is the whole Grafana database —
  survive a restart or a redeploy. Previously provisioning re-applied on every boot
  and reverted the URL, and the token was gone with the container's disk. Nothing in
  the plugin changed; this is entirely `deploy/entrypoint.sh`. (sc-74412)

  The mechanism is a **copy**, not a relocation. Pointing `GF_PATHS_DATA` at the Quix
  state volume was tried and reversed: the volume is CIFS-backed and cannot grant the
  exclusive POSIX locks SQLite needs, so Grafana loops forever on its first migration
  with `SQLITE_BUSY` and never listens — reproduced three times on the real
  deployment. Ordinary reads, writes, `cp` and `mkdir` on that volume all work, so the
  live database stays on container-local disk and the entrypoint copies it out to
  `<state>/grafana/grafana.db` every **10 seconds**, restoring it before Grafana
  starts. The loop is a background child started before the entrypoint execs Grafana,
  so Grafana still runs as PID 1 and handles its own signals. Copies go to a `.tmp`
  and are renamed so a restore never reads a half-written file, are skipped while a
  `grafana.db-journal` shows a transaction in flight, and are serialised across
  containers with `flock`.

  Consequences worth knowing. There is **no copy at shutdown**, so any stop — graceful
  or not — loses **up to 10 seconds** of changes, back to the last periodic copy. That
  is the whole loss window and it is acceptable for a URL and a token that are typed
  once. Persistence requires `state: enabled: true` on the deployment, which is
  declared in the pipeline repo's `quix.yaml` — without it Grafana logs a warning and
  runs exactly as it did before, rather than refusing to start, because an earlier
  version made that fatal and took the deployment down. The datasource template is now
  rendered only when no database was restored, so seeding no longer overwrites UI
  edits; `QUIXLAKE_FORCE_PROVISION=true` forces a re-seed from the environment. The
  deploy image drops its `USER 472` line so the entrypoint can write to the
  root-owned state mount, and drops to uid 472 itself before starting Grafana.

## 0.1.0 - unreleased

### Changed

- **Go toolchain 1.26.8 → 1.27.1**, and the deploy image `golang:1.26-alpine` →
  `golang:1.27-alpine`. This is an alignment move, not a fix for anything the plugin
  does: Grafana's plugin-review runner has Go 1.27 on PATH, and running a minor behind
  it means the toolchain that validates a catalog submission is not the one we build
  and test with. Nothing in the dependency graph required it — the Grafana Go SDK asks
  for at most 1.26.5 and arrow-go for 1.25.0 — so no code changed with it. The 0.0.9
  entry below still says `Go 1.25.5 → 1.26.8`; that is left as written, because it
  records what 0.0.9 shipped. (sc-74412)
- **Our plugin-validator gate now treats `govulncheck-scan-failed` as a warning rather
  than an error**, in `.github/plugin-validator.yaml`. The govulncheck binary inside
  `grafana/plugin-validator-cli` is built with Go 1.26, so against a module declaring
  1.27 its *source* scan aborts before it inspects anything ("uses version go1.26 of
  the source-processing packages but runs version go1.27 of `go list`"). This is
  upstream `grafana/plugin-validator` issue #827; the fix, PR #851, merged 2026-09-09
  but is not in a release yet. Staying on Go 1.26 would not have avoided it, because
  Grafana's own runner is already on 1.27 and their scan fails the same way — the
  2026-09-07 submission report carries that exact line. The downgrade is scoped as
  narrowly as we could make it: `govulncheck-issue-found` stays an **error**, so a real
  vulnerability still blocks the build, and the analyzer is not disabled, so the binary
  scan of the packaged zip keeps running. It reverts to `error` as soon as a validator
  image built after 2026-09-09 is published. (sc-74412)

## 0.0.9 - 2026-09-09

### Changed

- **Dependency and toolchain bump answering Grafana's 2026-09-07 catalog validation.**
  The report failed us on SDK age and on published advisories, none of which the plugin
  itself triggers, so nothing here changes its behaviour. Grafana Go SDK v0.285.0 →
  v0.296.4 (the `go-sdk-older-than-5-months` rule); `google.golang.org/grpc` → v1.83.2
  for CVE-2026-84304; Go 1.25.5 → 1.26.8, because Go 1.25 is end of life and
  govulncheck found 35 standard-library findings in the binary we ship, plus
  `golang.org/x/net` GO-2026-5942 and `golang.org/x/text` GO-2026-5970. On the frontend
  the `@grafana/*` packages move 13.1.0 → 13.1.5, which relaxes their pins on
  `react-use` and `dompurify` from exact to caret and so lets the js-cookie
  (GHSA-qjx8-664m-686j) and dompurify advisories be lifted; `fast-uri`
  (CVE-2026-75931, -75975, -75899, -76172), `nanoid` (CVE-2026-67213) and `js-yaml`
  (CVE-2026-84375) are build-only dependencies and move too. 13.2.1 was the intended
  target but requires React 19, and
  this plugin is on React 18 — that migration is its own change. (sc-74412)
- Grafana's own plugin validator now runs in CI with the source tree attached, on pull
  requests, on release tags before the zip is published, and weekly. It is the same
  gate a catalog submission faces, and its SDK-age and vulnerability rules fail on the
  calendar rather than on anything a commit did — which is exactly how the findings
  above reached us from Grafana instead of from CI. See `CONTRIBUTING.md`. (sc-74412)

## 0.0.8 - 2026-08-17

### Changed

- The plugin logo is now the Quix icon mark. It was still the `@grafana/create-plugin`
  placeholder, which used Grafana's own brand palette — misleading on a third-party
  plugin, and the catalog listing renders it beside the plugin name. The fill follows
  `prefers-color-scheme`, because `plugin.json` has no theme-specific logo slots and each
  mono variant is invisible against its own colour. (sc-74602)

## 0.0.7 - 2026-08-17

### Documentation

- Screenshots of the query builder and a multi-series panel, shown on the plugin
  catalog listing.
- `CONTRIBUTING.md`, and a README that opens with what the plugin does and what it
  looks like.

## 0.0.6 - 2026-08-14

### Features

- **`AND`/`OR` with bracketed groups in WHERE.** Predicates like
  `(a AND b) OR (c AND d)` can be built visually instead of dropping to Code mode.
  Nesting is shown with indentation and a left rule. An `OR` at the top level is always
  bracketed, so `$__timeFilter` keeps bounding every branch — without that,
  `$__timeFilter(t) AND a OR b` binds as `($__timeFilter(t) AND a) OR b` and the
  right-hand branch scans the whole table.
  ([#3](https://github.com/quixio/quixlakehouse-datasource/pull/3))
- Brackets can be put around any row, including the first. The control wraps a
  condition in place rather than appending a new group, so `(a OR b) AND c` is
  reachable from the builder.
- WHERE value dropdowns narrow by the filters already set, in any direction and in any
  order. The catalog intersects partition constraints regardless of their position in
  the partition spec, so the previous ancestors-only rule silently disabled narrowing
  on every column that was not the deepest.
- Narrowing respects the logic: only conditions guaranteed to hold alongside a row are
  used, so `AND` siblings narrow it and anything under an `OR` does not.

### Bug fixes

- **`split by` drew one line instead of one series per tag.** Two causes: the builder
  grouped a column without selecting it, and the backend then declared every frame
  `timeseries-wide` even when it was long, so Grafana ignored the tag column. Long
  frames are now pivoted with `data.LongToWide`, giving one series per combination of
  split-column values, each named after its tag values.
- `LIMIT` no longer defaults to 1000. The old default truncated silently — a
  60-second recording looked one second long. An empty field emits no `LIMIT` clause.
- Removing a bracketed group's last condition left an unremovable empty group on
  screen.
- Removing a WHERE row handed its loaded value list to the row that moved up into its
  place.

## 0.0.5 - 2026-08-11

Includes the work previously listed under 0.0.2 and 0.0.3, which were development
builds and were never published.

### Features

- **Visual query builder** with a Builder/Code toggle, modelled on Grafana's InfluxQL
  editor. `GROUP BY time` defaults to `$__interval`, so buckets follow dashboard zoom.
  The builder generates `rawSql`, so builder-authored queries still evaluate in alert
  rules, which have no frontend.
  ([#2](https://github.com/quixio/quixlakehouse-datasource/pull/2))
- WHERE rows populate from catalog metadata: partition columns from `/partition-info`,
  values from `/partition-values`, both served through a backend resource handler since
  the API token never reaches the browser.
- SELECT and TIME COLUMN offer real table columns from `/schema`, with
  `__index_level_0__` and `__key` filtered out.
- **Relative time mode**, for recordings with no meaningful wall-clock date. The anchor
  is "Run starts at", a positive epoch-millisecond instant, with a read-only line
  showing where the data will appear. Switching it on anchors the run so it ends at the
  present, so an ordinary Last 6 hours shows it.
- Expressions accepted where a column is expected, for tables whose instant is split
  across two columns.
- Dashboard variables via `partition_values(table, column, year=2023)`.

### Bug fixes

- The origin was not applied to timestamp columns, so relative mode silently did
  nothing as soon as GROUP BY time was enabled and every bucket stayed at 1970.
- The origin is rescaled when the epoch unit changes. A millisecond origin read as
  seconds landed ~56,000 years out and the panel went blank.
- Builder dropdowns were bound to bare values rather than option objects, so changes to
  the GROUP BY interval, ORDER BY, aggregate and operator never reached the query.

## 0.0.1 - 2026-08-07

First tagged release.

### Features

- Go-backend data source serving `POST /api/ds/query` — the call a frontend-only
  datasource answers with `plugin.unavailable`, and therefore what makes alert rules,
  recorded queries and public dashboards possible on lakehouse data.
- Raw SQL editor with backend-expanded macros — `$__timeFilter`, `$__timeFrom`,
  `$__timeTo`, `$__timeGroup` — so they behave identically in a dashboard and in an
  alert rule, which has no frontend to interpolate anything.
- Explicit time handling: `timeColumn` selects the column promoted to the frame's time
  field, `timeFormat` says how it is stored (epoch ms by default, matching the sink).
- Arrow IPC transport, with a CSV fallback used only to disambiguate an empty response:
  Arrow has no in-stream error channel, so an empty body is otherwise indistinguishable
  from a mid-stream failure.
- Dashboard variables from partition metadata via
  `partition_values(table, column, year=2023)`. Answers from the catalog manifest in
  well under a second, where the equivalent `SELECT DISTINCT` does not complete at all.
- Deployable Grafana image with the plugin baked in, published to
  `ghcr.io/quixio/quixlakehouse-grafana`.
