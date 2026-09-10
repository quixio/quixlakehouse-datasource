# Datasource provisioning template. Rendered by deploy/entrypoint.sh, which replaces
# the __PLACEHOLDER__ tokens from environment variables.
#
# Rendered only when there is no Grafana database to restore -- in practice, the first
# boot of a given state volume. The entrypoint copies Grafana's SQLite database out to
# that volume while it runs and restores it before Grafana starts, so on every later
# boot the datasource already exists, with whatever was typed into the UI, and this
# template is not rendered at all. The environment variables SEED the datasource; they
# do not keep re-applying to it. (With no state volume there is never anything to
# restore, so it is rendered every boot and UI edits do not survive -- see
# deploy/README.md.)
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
    # without a redeploy, and those edits now survive: they live in the Grafana
    # database, which the entrypoint copies to the state volume and restores on boot.
    # Provisioning only seeds the initial values from the environment.
    #
    # Two caveats worth knowing before relying on it. The state volume has to be
    # enabled on the deployment, or there is nowhere to copy to and the old
    # lost-on-restart behaviour is what you get. And QUIXLAKE_FORCE_PROVISION=true
    # re-renders this file, deliberately overwriting UI edits -- it is the way back
    # from a datasource edited into a broken state.
    editable: true
