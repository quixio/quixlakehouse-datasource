package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// Catalog metadata endpoints on the QuixLake API, as distinct from POST /query.
//
// WHY THESE EXIST SEPARATELY FROM SQL, which is the whole point of this file:
// partition values are directory names recorded in the catalog manifest. Asking for
// them with `SELECT DISTINCT <partition_column>` makes DuckDB open every Parquet
// file in the table to rediscover values that are already metadata. Measured against
// the testrig lakehouse on 2026-08-06:
//
//	GET /partition-values?table=rawdata&column=rotorID  -> 1007 values in 0.58s
//	SELECT DISTINCT rotorID FROM rawdata                -> cut off by the ingress
//
// The scan is not merely slower; it does not complete at all, and the ingress kills
// it before the plugin's own timeout, so raising timeoutSeconds does not help.
const (
	pathPartitionValues = "/partition-values"
	pathPartitionInfo   = "/partition-info"
	pathPartitions      = "/partitions"
	pathTables          = "/tables"
	pathSchema          = "/schema"
	pathTimeOrigin      = "/time-origin"
)

type tablesResponse struct {
	Tables []string `json:"tables"`
}

// Column is one column of a table's schema.
type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type schemaResponse struct {
	Columns []Column `json:"columns"`
}

// internalColumns are written by the sink and the Arrow/pandas round trip, not by the
// user, and are never something anyone means to plot. Hiding them from the builder is
// an explicit requirement on sc-74412 for __index_level_0__; __key is the same class
// of artefact. They remain queryable in raw SQL -- this only removes them from the
// suggestions.
var internalColumns = map[string]bool{
	"__index_level_0__": true,
	"__key":             true,
}

// MinTime returns the smallest value of a time expression in a table, which is the
// origin for relative mode.
//
// Runs a real query rather than reading metadata, because the value is data, not a
// partition. It is cheap: min() over one column is an aggregate DuckDB answers from
// the column chunks, and the partition filters keep the file count down.
//
// Deliberately NOT filtered by the dashboard time range. An origin recomputed from
// whatever the current zoom left would move on every zoom, so the visible window
// would always restart at zero and dragging would appear to do nothing.
func (c *RESTClient) MinTime(ctx context.Context, table, timeExpr string, filters map[string]string) (int64, int64, error) {
	if strings.TrimSpace(table) == "" || strings.TrimSpace(timeExpr) == "" {
		return 0, 0, fmt.Errorf("table and expr are required")
	}

	// Both ends in one query. min anchors "zero at the start"; max is what lets the
	// run be shifted onto the current clock, which needs the LAST sample to land on
	// now -- anchoring the first would put the whole run in the future, outside any
	// "last N hours" range.
	sql := "SELECT min(" + timeExpr + ") AS lo, max(" + timeExpr + ") AS hi FROM " + table
	keys := make([]string, 0, len(filters))
	for k := range filters {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for i, k := range keys {
		v := filters[k]
		if v == "" {
			continue
		}
		clause := " AND "
		if i == 0 {
			clause = " WHERE "
		}
		sql += clause + k + " = '" + strings.ReplaceAll(v, "'", "''") + "'"
	}

	resp, err := c.Query(ctx, sql, false /* CSV: two scalars, and CSV can report a mid-stream error */)
	if err != nil {
		return 0, 0, err
	}

	// header line, then "lo,hi"
	lines := strings.Split(strings.TrimSpace(string(resp.Body)), "\n")
	if len(lines) < 2 {
		return 0, 0, fmt.Errorf("no rows returned for the time-range query")
	}
	cols := strings.Split(strings.TrimSpace(lines[1]), ",")
	if len(cols) < 2 {
		return 0, 0, fmt.Errorf("expected two values, got %q", lines[1])
	}
	// Parsed as float because the expression can be one: can_signals.t_rel is a
	// DOUBLE, so min() over it returns "0.0", which ParseInt would reject.
	lo, err := strconv.ParseFloat(strings.TrimSpace(cols[0]), 64)
	if err != nil {
		return 0, 0, fmt.Errorf("could not parse the range start %q: %w", cols[0], err)
	}
	hi, err := strconv.ParseFloat(strings.TrimSpace(cols[1]), 64)
	if err != nil {
		return 0, 0, fmt.Errorf("could not parse the range end %q: %w", cols[1], err)
	}
	return int64(lo), int64(hi), nil
}

// Schema lists a table's columns, for the builder's SELECT and TIME COLUMN dropdowns.
//
// This is the only way to get non-partition columns: DESCRIBE fails against this API
// ("Table with name X does not exist") because it resolves table names itself rather
// than registering them in DuckDB's catalog, and SELECT * LIMIT 1 costs a real query --
// 15.8s on rawdata.
func (c *RESTClient) Schema(ctx context.Context, table string) ([]Column, error) {
	if strings.TrimSpace(table) == "" {
		return nil, fmt.Errorf("table is required")
	}
	q := url.Values{}
	q.Set("table", table)

	var out schemaResponse
	if err := c.getJSON(ctx, pathSchema, q, &out); err != nil {
		return nil, err
	}

	cols := make([]Column, 0, len(out.Columns))
	for _, col := range out.Columns {
		if internalColumns[col.Name] {
			continue
		}
		cols = append(cols, col)
	}
	return cols, nil
}

// Tables lists the tables in the catalog, for the builder's FROM dropdown.
func (c *RESTClient) Tables(ctx context.Context) ([]string, error) {
	var out tablesResponse
	if err := c.getJSON(ctx, pathTables, nil, &out); err != nil {
		return nil, err
	}
	return out.Tables, nil
}

// partitionInfoResponse is the shape of GET /partition-info. Only the fields we use
// are declared; the endpoint also returns counts it explicitly refuses to compute
// ("Unknown (use partitions endpoint for details)"), which is why they are ignored.
type partitionInfoResponse struct {
	TableName        string   `json:"table_name"`
	IsPartitioned    bool     `json:"is_partitioned"`
	PartitionColumns []string `json:"partition_columns"`
}

// PartitionColumns lists the columns a table is partitioned by, in spec order.
//
// This is what turns the query builder's WHERE row from a free-text box into a
// dropdown. It matters more here than in a normal SQL builder: filtering on a
// partition column prunes files before anything is read, while filtering on an
// ordinary column does not, so knowing which is which is the difference between a
// query that returns and one the ingress kills.
func (c *RESTClient) PartitionColumns(ctx context.Context, table string) ([]string, error) {
	if strings.TrimSpace(table) == "" {
		return nil, fmt.Errorf("table is required")
	}
	q := url.Values{}
	q.Set("table", table)

	var out partitionInfoResponse
	if err := c.getJSON(ctx, pathPartitionInfo, q, &out); err != nil {
		return nil, err
	}
	if !out.IsPartitioned {
		return []string{}, nil
	}
	return out.PartitionColumns, nil
}

// partitionValuesResponse is the documented shape of GET /partition-values
// (quix-ts-datalake-api/main.py:851-856).
type partitionValuesResponse struct {
	Table  string   `json:"table"`
	Column string   `json:"column"`
	Values []string `json:"values"`
	Count  int      `json:"count"`
}

// ErrCatalogUnsupported reports that the connected catalog predates the endpoint.
//
// The API answers 501 in that case specifically so callers can fall back to walking
// the partition tree via /partitions (main.py:832-833). We surface it as a distinct
// error rather than a generic failure so that fallback can be added without having
// to string-match an error message.
var ErrCatalogUnsupported = fmt.Errorf("catalog does not support this endpoint")

// PartitionValues returns the distinct values of a single partition column.
//
// filters are equality constraints on ANCESTOR partition columns, passed through as
// query parameters -- the same convention the API uses elsewhere, e.g.
// ?table=car_telemetry&column=driver_acronym&year=2025. Narrowing by an ancestor is
// worth doing: it is the difference between every value the table has ever held and
// the ones present in the period being looked at.
func (c *RESTClient) PartitionValues(ctx context.Context, table, column string, filters map[string]string) ([]string, error) {
	if strings.TrimSpace(table) == "" {
		return nil, fmt.Errorf("table is required")
	}
	if strings.TrimSpace(column) == "" {
		return nil, fmt.Errorf("column is required")
	}

	q := url.Values{}
	q.Set("table", table)
	q.Set("column", column)
	// Sorted so the generated URL is deterministic, which keeps it cacheable and
	// makes the unit tests assert something stable.
	keys := make([]string, 0, len(filters))
	for k := range filters {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if k == "table" || k == "column" {
			continue // reserved; a filter cannot shadow them
		}
		if v := filters[k]; v != "" {
			q.Set(k, v)
		}
	}

	var out partitionValuesResponse
	if err := c.getJSON(ctx, pathPartitionValues, q, &out); err != nil {
		return nil, err
	}
	return out.Values, nil
}

// getJSON performs an authenticated GET and decodes a JSON body.
//
// Deliberately not reusing Query's response handling: that path exists to cope with
// the streaming quirks of /query (a "# ERROR:" line inside a 200, an empty Arrow
// body that might be a mid-stream failure). The catalog endpoints are ordinary JSON
// with honest status codes, so treating them the same way would be cargo cult.
func (c *RESTClient) getJSON(ctx context.Context, path string, params url.Values, out any) error {
	u := c.baseURL + path
	if encoded := params.Encode(); encoded != "" {
		u += "?" + encoded
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", ctJSON)
	if c.settings.Secrets != nil && c.settings.Secrets.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.settings.Secrets.Token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("could not read the response body: %w", err)
	}

	if resp.StatusCode == http.StatusNotImplemented {
		return ErrCatalogUnsupported
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{StatusCode: resp.StatusCode, Message: extractErrorMessage(body)}
	}

	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("could not parse the catalog response: %w", err)
	}
	return nil
}
