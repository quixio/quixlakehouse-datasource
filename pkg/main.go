package main

import (
	"os"

	"github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/quix/quixlakehouse/pkg/plugin"
)

func main() {
	// datasource.Manage blocks until Grafana shuts the plugin process down. It also
	// manages instance lifecycle: one Datasource per configured datasource UID,
	// disposed and recreated whenever its settings change.
	//
	// The plugin id comes from plugin.PluginID so a rename is a one-line edit on the
	// Go side -- see SPIKE-NOTES.md for the non-Go files that also spell it.
	if err := datasource.Manage(plugin.PluginID, plugin.NewDatasource, datasource.ManageOpts{}); err != nil {
		log.DefaultLogger.Error(err.Error())
		os.Exit(1)
	}
}
