# Changelog

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
