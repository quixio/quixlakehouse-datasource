# Datasource provisioning template. Rendered by deploy/entrypoint.sh, which replaces
# the __PLACEHOLDER__ tokens from environment variables.
#
# SEED ONLY. The entrypoint renders this on the first boot of a state volume and not
# again, so a fresh deployment comes up with a working datasource without anyone
# typing a URL, while later boots leave the database row alone. Grafana's SQLite
# database lives on the Quix state volume (Quix__Deployment__State__Path), so that
# row -- and everything else created through the UI -- survives a restart.
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
    # without a redeploy, and those edits now LAST: the database is on the state
    # volume, and the entrypoint stops re-rendering this file once the datasource has
    # been seeded, so Grafana has nothing to overwrite the edit with on the next boot.
    #
    # To deliberately throw a UI edit away and re-seed from the environment, set
    # QUIXLAKE_FORCE_PROVISION=true on the deployment for one boot.
    editable: true
