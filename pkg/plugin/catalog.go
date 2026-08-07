package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
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
	pathPartitions      = "/partitions"
)

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
