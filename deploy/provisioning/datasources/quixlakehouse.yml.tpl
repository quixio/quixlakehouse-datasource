# Datasource provisioning template. Rendered at boot by deploy/entrypoint.sh, which
# replaces the __PLACEHOLDER__ tokens from environment variables.
#
# Provisioned rather than configured by hand so that a redeploy always comes back
# with a working datasource -- Grafana's SQLite database is not persisted in a Quix
# deployment, so anything created through the UI is lost on restart.
apiVersion: 1

datasources:
  - name: QuixLakeHouse
    # Must equal the plugin id, or Grafana logs "datasource type not found".
    type: __PLUGIN_ID__
    uid: quixlakehouse
    access: proxy
    isDefault: true
    # Grafana's standard `url` field, not jsonData -- that is what gives the backend
    # TLS options, proxy support and the standard HTTP middleware chain for free.
    # This is Quix__Lakehouse__Query__Url: the PUBLIC lh-query host. Note it is NOT
    # CATALOG_URL or QUIX_LAKE_URL, which are legacy aliases for the in-cluster
    # Iceberg catalog and will not serve /query.
    url: __QUIXLAKE_URL__
    jsonData:
      unionByName: true
      timeoutSeconds: 60
    secureJsonData:
      # Encrypted by Grafana at rest and only ever decrypted for the backend process;
      # the browser never receives it back. This is the security gain over the
      # frontend-only JSON datasource it replaces.
      token: __QUIXLAKE_TOKEN__
    # Editable so the URL and token can be corrected from Connections > Data Sources
    # without a redeploy. Provisioning still SEEDS the values from the environment,
    # because a Quix deployment has no persisted Grafana database to create them in.
    #
    # Known consequence, and the reason this was false: Grafana re-applies
    # provisioning at every boot, so a UI edit survives only until the container
    # restarts. Making edits durable needs a persisted Grafana DB (GF_DATABASE_* to
    # Postgres) -- the state mount is not an option here, since the entrypoint runs as
    # uid 472 and cannot take ownership of it.
    editable: true
