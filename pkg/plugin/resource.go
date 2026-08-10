package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

var _ backend.CallResourceHandler = (*Datasource)(nil)

// CallResource serves the datasource's own HTTP endpoints, reachable from the
// browser at /api/datasources/uid/<uid>/resources/<path>.
//
// WHY THE BACKEND HAS TO PROXY THIS AT ALL: the API token lives in secureJsonData,
// which Grafana decrypts only for the backend process -- the browser never receives
// it. So the frontend cannot call the lakehouse directly, and a resource handler is
// the only route by which a query editor dropdown or a dashboard variable can reach
// catalog metadata. Routing through here also inherits the datasource's TLS options,
// proxy configuration and timeout, rather than re-deriving them in TypeScript.
func (d *Datasource) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	// req.Path has no leading slash and no query string.
	path := "/" + strings.TrimPrefix(req.Path, "/")

	switch {
	case path == pathPartitionValues && req.Method == http.MethodGet:
		return d.handlePartitionValues(ctx, req, sender)
	case path == pathPartitionInfo && req.Method == http.MethodGet:
		return d.handlePartitionInfo(ctx, req, sender)
	case path == pathTables && req.Method == http.MethodGet:
		return d.handleTables(ctx, sender)
	case path == pathSchema && req.Method == http.MethodGet:
		return d.handleSchema(ctx, req, sender)
	default:
		return sendJSON(sender, http.StatusNotFound, map[string]string{
			"error": "no such resource: " + req.Method + " " + path,
		})
	}
}

// partitionValuesResult is what the frontend consumes. Deliberately a superset of
// the upstream shape: `values` alone would force the caller to re-derive the table
// and column it asked about when several requests are in flight for one panel.
type partitionValuesResult struct {
	Table  string   `json:"table"`
	Column string   `json:"column"`
	Values []string `json:"values"`
	Count  int      `json:"count"`
}

func (d *Datasource) handlePartitionValues(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	params, err := url.ParseQuery(req.URL)
	if err != nil {
		// req.URL is the raw query string; a malformed one is a caller bug.
		return sendJSON(sender, http.StatusBadRequest, map[string]string{
			"error": "could not parse query parameters: " + err.Error(),
		})
	}
	// ParseQuery on a full "path?query" string keeps the path glued to the first
	// key, so strip it if present.
	params = stripPathFromQuery(params)

	table := params.Get("table")
	column := params.Get("column")
	if table == "" || column == "" {
		return sendJSON(sender, http.StatusBadRequest, map[string]string{
			"error": "both 'table' and 'column' are required",
		})
	}

	// Everything else is an ancestor partition filter, matching the API's own
	// convention rather than inventing a nested encoding.
	filters := map[string]string{}
	for k := range params {
		if k == "table" || k == "column" {
			continue
		}
		if v := params.Get(k); v != "" {
			filters[k] = v
		}
	}

	values, err := d.client.PartitionValues(ctx, table, column, filters)
	if err != nil {
		if errors.Is(err, ErrCatalogUnsupported) {
			// 501 is the API's documented signal that the connected catalog predates
			// /partition-values. Pass it through verbatim so the caller can tell
			// "this catalog is too old" apart from "your request was wrong", and so a
			// /partitions tree-walk fallback can be added without guesswork.
			return sendJSON(sender, http.StatusNotImplemented, map[string]string{
				"error": "the connected catalog does not support /partition-values; " +
					"walking /partitions is not implemented yet",
			})
		}
		msg, _ := classifyError(err, d.baseURL)
		log.DefaultLogger.Warn("partition-values failed", "table", table, "column", column, "err", err)

		status := http.StatusBadGateway
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode >= 400 && apiErr.StatusCode < 500 {
			status = apiErr.StatusCode
		}
		return sendJSON(sender, status, map[string]string{"error": msg})
	}

	return sendJSON(sender, http.StatusOK, partitionValuesResult{
		Table:  table,
		Column: column,
		Values: values,
		Count:  len(values),
	})
}

// handleTables lists catalog tables for the builder's FROM dropdown.
func (d *Datasource) handleTables(ctx context.Context, sender backend.CallResourceResponseSender) error {
	tables, err := d.client.Tables(ctx)
	if err != nil {
		msg, _ := classifyError(err, d.baseURL)
		log.DefaultLogger.Warn("tables lookup failed", "err", err)

		status := http.StatusBadGateway
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode >= 400 && apiErr.StatusCode < 500 {
			status = apiErr.StatusCode
		}
		return sendJSON(sender, status, map[string]string{"error": msg})
	}
	return sendJSON(sender, http.StatusOK, map[string]any{"tables": tables})
}

// handleSchema lists a table's columns with their types, for the SELECT and
// TIME COLUMN dropdowns.
func (d *Datasource) handleSchema(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	params, err := url.ParseQuery(req.URL)
	if err != nil {
		return sendJSON(sender, http.StatusBadRequest, map[string]string{
			"error": "could not parse query parameters: " + err.Error(),
		})
	}
	params = stripPathFromQuery(params)

	table := params.Get("table")
	if table == "" {
		return sendJSON(sender, http.StatusBadRequest, map[string]string{"error": "'table' is required"})
	}

	cols, err := d.client.Schema(ctx, table)
	if err != nil {
		msg, _ := classifyError(err, d.baseURL)
		log.DefaultLogger.Warn("schema lookup failed", "table", table, "err", err)

		status := http.StatusBadGateway
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode >= 400 && apiErr.StatusCode < 500 {
			status = apiErr.StatusCode
		}
		return sendJSON(sender, status, map[string]string{"error": msg})
	}

	return sendJSON(sender, http.StatusOK, map[string]any{"table": table, "columns": cols})
}

// handlePartitionInfo lists the columns a table is partitioned by, so the query
// builder can offer them instead of asking the user to remember them.
func (d *Datasource) handlePartitionInfo(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	params, err := url.ParseQuery(req.URL)
	if err != nil {
		return sendJSON(sender, http.StatusBadRequest, map[string]string{
			"error": "could not parse query parameters: " + err.Error(),
		})
	}
	params = stripPathFromQuery(params)

	table := params.Get("table")
	if table == "" {
		return sendJSON(sender, http.StatusBadRequest, map[string]string{"error": "'table' is required"})
	}

	columns, err := d.client.PartitionColumns(ctx, table)
	if err != nil {
		if errors.Is(err, ErrCatalogUnsupported) {
			return sendJSON(sender, http.StatusNotImplemented, map[string]string{
				"error": "the connected catalog does not support /partition-info",
			})
		}
		msg, _ := classifyError(err, d.baseURL)
		log.DefaultLogger.Warn("partition-info failed", "table", table, "err", err)

		status := http.StatusBadGateway
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode >= 400 && apiErr.StatusCode < 500 {
			status = apiErr.StatusCode
		}
		return sendJSON(sender, status, map[string]string{"error": msg})
	}

	return sendJSON(sender, http.StatusOK, map[string]any{
		"table":   table,
		"columns": columns,
	})
}

// stripPathFromQuery removes a leading "<path>?" that some SDK versions leave on
// CallResourceRequest.URL. Without this the first parameter's key arrives as
// "partition-values?table" and the lookup silently misses.
func stripPathFromQuery(in url.Values) url.Values {
	out := url.Values{}
	for k, vs := range in {
		if i := strings.LastIndex(k, "?"); i >= 0 {
			k = k[i+1:]
		}
		out[k] = vs
	}
	return out
}

func sendJSON(sender backend.CallResourceResponseSender, status int, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return sender.Send(&backend.CallResourceResponse{
		Status:  status,
		Headers: map[string][]string{"Content-Type": {ctJSON}},
		Body:    body,
	})
}
