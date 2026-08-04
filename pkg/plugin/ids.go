package plugin

// PluginID is the single source of truth for the Grafana plugin id on the Go side.
//
// The id is NOT final: public-catalog publication requires the first segment to be
// our grafana.com organisation slug, which has not been claimed yet (it may end up
// `quix` or `quixio`). Renaming means editing this constant plus the non-Go files
// listed in SPIKE-NOTES.md ("Plugin id — rename inventory"). Nothing else in the Go
// tree should ever spell the id literally.
const PluginID = "quix-quixlakehouse-datasource"

// ExecutableName must match the `executable` field in src/plugin.json. Grafana
// appends the platform suffix (e.g. `_linux_amd64`) when it launches the binary.
const ExecutableName = "gpx_quixlakehouse"
