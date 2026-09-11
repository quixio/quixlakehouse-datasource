# Installing the QuixLakeHouse data source

How to get the plugin into a Grafana you already run.

Catalog publication comes later; until then, install by one of the routes below.

The URLs below pin **v0.1.0**; they are updated when a release is tagged. Check the
[releases page](https://github.com/quixio/quixlakehouse-datasource/releases) for the
newest version.

## Before you start

**Grafana 12.3 or newer** (`grafanaDependency: ">=12.3.0"` in `plugin.json`).

**The plugin is unsigned**, so Grafana refuses to load it unless you allow it by id:

```
GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=quix-quixlakehouse-datasource
```

Signing comes later.

You also need the plugin id itself, which is used as a directory name, an env var value
and the datasource `type`:

```
quix-quixlakehouse-datasource
```

---

## Route 1 — `GF_INSTALL_PLUGINS` (recommended)

Grafana downloads and unpacks the zip at boot. Nothing to copy by hand, and it works
with the stock `grafana/grafana` image.

```yaml
# docker-compose.yml
services:
  grafana:
    image: grafana/grafana:13.1.1
    ports:
      - "3000:3000"
    environment:
      GF_INSTALL_PLUGINS: "https://github.com/quixio/quixlakehouse-datasource/releases/download/v0.1.0/quix-quixlakehouse-datasource-0.1.0.zip;quix-quixlakehouse-datasource"
      GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS: "quix-quixlakehouse-datasource"
```

The `;quix-quixlakehouse-datasource` suffix is required — it names the directory to
unpack into, and Grafana discovers plugins by directory name.

Same variable works for a Helm chart (`grafana.env`) or a bare `grafana-server` via
`/etc/grafana/grafana.ini`.

**This needs outbound access to GitHub at boot.** In an air-gapped or egress-restricted
environment use route 2 or 3.

## Route 2 — `grafana-cli`

For a Grafana you administer directly:

```bash
grafana-cli --pluginUrl https://github.com/quixio/quixlakehouse-datasource/releases/download/v0.1.0/quix-quixlakehouse-datasource-0.1.0.zip \
  plugins install quix-quixlakehouse-datasource

sudo systemctl restart grafana-server
```

Still set `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS`, or Grafana will install the files
and then decline to load them.

## Route 3 — unzip it yourself

The fallback with no network involved. **The directory name must equal the plugin id** —
Grafana finds plugins by directory name, so unzipping to `dist/` produces a plugin that
is silently never listed.

```bash
unzip quix-quixlakehouse-datasource-0.1.0.zip -d /var/lib/grafana/plugins/
chmod +x /var/lib/grafana/plugins/quix-quixlakehouse-datasource/gpx_*
sudo systemctl restart grafana-server
```

The zip is already rooted at `quix-quixlakehouse-datasource/`, so unzipping into the
plugins directory produces the right layout.

**The executable bit matters.** This plugin has a Go backend, and Grafana cannot launch
a binary it may not execute. The symptom is subtle: the plugin loads, the query editor
appears, and every query fails — because only the frontend half is running.

## Verify the checksum

Each release ships a `.sha1` beside the zip:

```bash
sha1sum -c quix-quixlakehouse-datasource-0.1.0.zip.sha1
```

---

## Alternative: use the prebuilt Grafana image

If you are deploying Grafana anyway, skip installation entirely:

```
ghcr.io/quixio/quixlakehouse-grafana
```

Stock Grafana with the plugin already inside, the unsigned allowlist set, and an
entrypoint that provisions the datasource from two environment variables:

```bash
docker run -d -p 3000:3000 \
  -e QUIXLAKE_URL='https://<your-lakehouse-query-host>' \
  -e QUIXLAKE_TOKEN='<token or PAT>' \
  -e GF_SECURITY_ADMIN_PASSWORD='<password>' \
  ghcr.io/quixio/quixlakehouse-grafana:<version>
```

Pin a version tag or a digest. `:latest` only moves when a version is tagged, and `:dev`
tracks the current development branch and will change under you.

See [deploy/README.md](../deploy/README.md) for the Quix Cloud deployment, where the
lakehouse credentials are injected by the platform instead.

---

## After installing

**1. Check Grafana loaded it.** The log should show:

```
level=info msg="Plugin registered" pluginId=quix-quixlakehouse-datasource
```

Alongside a warning that it is unsigned but permitted — that one is expected.

If you instead see `plugin is unsigned` with no "permitting" line, the allowlist env var
did not reach Grafana.

**2. Add the data source.** Connections → Data sources → Add new data source →
**QuixLakeHouse**. Two fields matter:

| Field | Value |
| --- | --- |
| URL | The Lakehouse Query API root, e.g. `https://lh-query-<id>-<org>-global.<cluster>`. No `/query` suffix. |
| API token | A Quix PAT or an org-scoped token. Stored encrypted; never returned to the browser. |

**3. Save & test.** Expect:

```
Connected to the QuixLake API at <your url>.
```

That check runs `SELECT 1`, so it proves the API is reachable and the token is accepted
— and nothing more. It deliberately touches no object storage, so a green result does
not guarantee that a query over real data will succeed. If Save & test passes but panels
fail, the token is being accepted at the front door but refused for data access.

## Provisioning instead of clicking

A container's Grafana database is usually not persisted, so a hand-created data source
disappears on restart. Provision it instead:

```yaml
# /etc/grafana/provisioning/datasources/quixlakehouse.yml
apiVersion: 1
datasources:
  - name: QuixLakeHouse
    uid: quixlakehouse
    type: quix-quixlakehouse-datasource
    access: proxy
    url: https://<your-lakehouse-query-host>
    jsonData:
      unionByName: true
      timeoutSeconds: 60
    secureJsonData:
      token: <token>
```

`type` must be the plugin id. `uid` is what dashboard JSON references, so keep it stable
across environments or dashboards will not resolve their data source.

## Troubleshooting

**The plugin does not appear in the data source list.** Almost always the directory name.
It must be exactly `quix-quixlakehouse-datasource`; a zip unpacked to `dist/` is ignored
without any error. Check `ls /var/lib/grafana/plugins/`.

**"Plugin is unsigned" and it will not load.** The allowlist variable is missing or has
the wrong id. It takes the plugin id, not the display name.

**Query editor works but every query fails.** Usually the backend binary is not
executable — `chmod +x` the `gpx_*` files — or your platform is missing from the build.
The zip ships linux amd64/arm64/arm, darwin amd64/arm64 and windows amd64.

**Editor changes appear to do nothing after an upgrade.** Grafana cache-busts plugin
assets with `?_cache=<plugin version>`, so two builds sharing a version serve the same
cached JavaScript. Hard-refresh, or use a private window.
