# Contributing

Thanks for looking at this. Bug reports are as welcome as patches — a clear report of a
query that returns the wrong thing is worth more than a guess at the fix.

## Reporting a bug

Open an issue at
[quixio/quixlakehouse-datasource/issues](https://github.com/quixio/quixlakehouse-datasource/issues)
with:

- the **generated SQL** (the Builder tab shows it, or use Grafana's Query Inspector),
- the **Grafana version** and the **plugin version**,
- what you expected and what you got — a screenshot of the panel is ideal.

The lakehouse itself is a separate, private service, so we usually cannot reproduce
against your data. The SQL and the frame shape from Query Inspector are what let us
reproduce it against ours.

## Development

```bash
npm ci && npm run build     # frontend -> dist/
mage -v                     # Go backend -> dist/gpx_quixlakehouse_*
docker compose -f docker-compose.dev.yml up -d    # stock Grafana on :3002, dist/ mounted
```

A **stock** Grafana image with `dist/` bind-mounted, deliberately: that is how a user
installs a plugin, so if it loads there it loads for them.

One trap worth knowing before you lose an hour to it: Grafana cache-busts plugin assets
with `?_cache=<plugin version>`. Rebuild without bumping the version and the browser
keeps serving the old bundle, so your change appears to do nothing. Hard-refresh
(Ctrl+Shift+R) or use a private window.

## Tests

```bash
npm test                    # frontend unit + component tests
go test ./...               # macros, epoch conversion, Arrow -> frame, error classification
npm run e2e                 # Playwright, needs a running Grafana
```

**If you are fixing a bug, write a failing test first.** A finding with no red test is a
hypothesis, not a bug — and more than once here a test written after the fix turned out
to pass against the broken code too. Run it against the unfixed code and watch it fail
before you trust it.

The logic risk lives in macro expansion, epoch conversion, Arrow-to-frame conversion and
the SQL generator, so that is where the tests are concentrated.

## Pull requests

- One feature or fix per branch; branches are named `feature/<story>/<slug>` or
  `bug/<story>/<slug>`.
- PRs need one approving review before merge.
- Update `CHANGELOG.md` under the unreleased heading.
- The version in `package.json` is bumped **once per PR**, not per commit.
- CI runs lint, typecheck, the Go and frontend test suites, and a Trivy scan. It must be
  green.

## Licence

Apache-2.0. By contributing you agree your work is licensed under it.

Note for anyone porting code in: **do not copy from Grafana core**, which is AGPLv3 —
that would pull copyleft into a plugin we ship under Apache-2.0. Reading
`pkg/tsdb/influxdb` for patterns is fine; copying is not. Apache-2.0 sources such as
`grafana-plugin-sdk-go`, `grafana/sqlds` and `grafana/clickhouse-datasource` can be
copied from freely.
