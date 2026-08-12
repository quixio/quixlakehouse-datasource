# Changelog

## 0.0.6 - unreleased

- WHERE now supports `AND`/`OR` with bracketed groups, so predicates like
  `(a AND b) OR (c AND d)` can be built without dropping to Code mode. Nesting is shown
  with indentation and a left rule, and an `OR` at the top level is always bracketed so
  `$__timeFilter` keeps bounding every branch. (sc-74551)
- Value dropdowns narrow only by conditions guaranteed to hold alongside the row being
  edited: `AND` siblings do, anything under an `OR` does not.
- WHERE values are narrowed by the filters already set, whatever order the rows were
  added in and wherever the columns sit in the partition spec. The catalog intersects
  constraints in any direction, so restricting this to ancestors silently disabled
  narrowing on every column that was not the deepest. (sc-74547)

- Fixed: "split by" grouped a column without selecting it, so the frame had nothing to
  split series on. One line zig-zagged between groups, with no per-series legend or
  colour. Split columns are now selected as dimensions. (sc-74547)
- LIMIT no longer defaults to 1000. An empty field emits no LIMIT clause, so a query is
  unbounded unless you cap it. The old default truncated silently. (sc-74547)

## 0.0.5 - unreleased

- Relative time mode: the anchor is now "Run starts at", a positive epoch-millisecond
  instant, with a read-only line showing where the data will appear. Switching the mode
  on anchors the run so it ends at the present, so an ordinary Last 6 hours shows it.
- Fixed: the origin was not applied to timestamp columns, so relative mode silently did
  nothing as soon as GROUP BY time was enabled and every bucket stayed at 1970.
- Table columns offered in SELECT and TIME COLUMN from /schema, with
  __index_level_0__ and __key filtered out. Partition columns preloaded into WHERE.
- Fixed: builder dropdowns were bound to bare values, so the GROUP BY interval,
  ORDER BY, aggregate and operator changes never reached the query.
- Expressions accepted where a column is expected, for tables whose instant is split
  across two columns.

## 0.0.3 - unreleased

- Relative time mode: switching it on anchors the run's last sample at the current
  clock, so it shows in an ordinary "Last 6 hours" with no 1970 range to set up.
  Zero at stays editable, with Detect (zero at the start) and End at now.
- The origin is rescaled when the epoch unit changes; previously a millisecond origin
  read as seconds landed ~56,000 years out and the panel went blank.
- Builder dropdowns bind to option objects, fixing an interval change that never
  reached the query.

## 0.0.2 - unreleased

- Visual query builder with a Builder/Code toggle, modelled on Grafana's InfluxQL
  editor. `GROUP BY time` defaults to `$__interval`, so buckets follow dashboard zoom.
  The builder generates `rawSql`, so builder-authored queries still evaluate in alert
  rules, which have no frontend.
- WHERE rows populate from catalog metadata: partition columns from
  `/partition-info`, values from `/partition-values`. Both are served through a
  backend resource handler, since the API token never reaches the browser.
- Dashboard variables via `partition_values(table, column, year=2023)`.

## 0.0.1 - 2026-08-07

First tagged release. Pre-1.0 deliberately: alerting is not yet demonstrated end to
end, and the plugin has had one day of testing against a real lakehouse.

- Go-backend data source serving `POST /api/ds/query`, which is what a frontend-only
  datasource answers with `plugin.unavailable`. Verified against the live lakehouse:
  server-side health returns OK and queries return typed data frames with a real
  Grafana time field.
- Raw SQL editor with backend-expanded macros — `$__timeFilter`, `$__timeFrom`,
  `$__timeTo`, `$__timeGroup` — so they behave identically in a dashboard and in an
  alert rule, which has no frontend to interpolate anything.
- Explicit time handling: `timeColumn` selects the column promoted to the frame's
  time field, `timeFormat` says how it is stored (epoch ms by default, matching the
  sink).
- Arrow IPC transport with a CSV fallback used only to disambiguate an empty
  response, since Arrow has no in-stream error channel and an empty body would
  otherwise be indistinguishable from a mid-stream failure.
- Dashboard variables from partition metadata via
  `partition_values(table, column, year=2023)`, served by a backend resource handler.
  Answers from the catalog manifest in well under a second where the equivalent
  `SELECT DISTINCT` does not complete at all.
- Deployable Grafana image with the plugin baked in, published to
  `ghcr.io/quixio/quixlakehouse-grafana`.

Known gaps: no visual query builder, no provisioned-alert-rule proof, no `/partitions`
fallback for catalogs predating `/partition-values`, `maxDataPoints` is not pushed
down, and the plugin is unsigned so self-hosted Grafana needs
`GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS`.
