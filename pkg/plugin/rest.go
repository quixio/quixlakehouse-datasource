package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"

	"github.com/quix/quixlakehouse/pkg/models"
)

// RESTClient talks to the QuixLake REST API's POST /query endpoint.
//
// Contract (verified against quix-ts-datalake-api and
// test/test_duckdb_read_only_statements_integration.py:31-40):
//
//   - SQL is the raw request body with Content-Type: text/plain. It is NOT a JSON
//     field.
//   - Auth is `Authorization: Bearer <token>`. auth.py accepts either the static
//     API_AUTH_TOKEN or any Quix platform token / PAT.
//   - ?format=arrow (or an Accept header) asks for an Arrow IPC stream. The API's
//     default is CSV.
type RESTClient struct {
	http     *http.Client
	baseURL  string
	settings *models.PluginSettings
}

// Content types the API can answer with.
const (
	ctArrowStream = "application/vnd.apache.arrow.stream"
	ctCSV         = "text/csv"
	ctJSON        = "application/json"
)

// csvErrorSentinel is how the CSV streaming path reports a failure that happened
// after the HTTP 200 header was already flushed (main.py:576).
const csvErrorSentinel = "# ERROR:"

// NewRESTClient builds the HTTP client. It goes through Grafana's httpclient
// provider so the datasource inherits TLS options, proxy configuration and the
// standard middleware chain instead of us hand-rolling a transport.
func NewRESTClient(ctx context.Context, instance backend.DataSourceInstanceSettings, settings *models.PluginSettings) (*RESTClient, error) {
	opts, err := instance.HTTPClientOptions(ctx)
	if err != nil {
		return nil, fmt.Errorf("could not read HTTP client options: %w", err)
	}
	opts.Timeouts.Timeout = settings.Timeout()

	cl, err := httpclient.New(opts)
	if err != nil {
		return nil, fmt.Errorf("could not create HTTP client: %w", err)
	}

	return &RESTClient{
		http:     cl,
		baseURL:  strings.TrimRight(instance.URL, "/"),
		settings: settings,
	}, nil
}

// queryURL builds the /query URL with its parameters.
//
// wantArrow asks for Arrow IPC so DuckDB's declared column types survive. The API
// may still answer with CSV -- see the note on Response.
func (c *RESTClient) queryURL(wantArrow bool) string {
	q := url.Values{}
	if wantArrow {
		q.Set("format", "arrow")
	} else {
		q.Set("format", "csv")
	}
	if c.settings.UnionByName {
		q.Set("union_by_name", "true")
	}
	return c.baseURL + "/query?" + q.Encode()
}

// Response is one decoded /query result.
//
// Format is whatever the server actually replied with, not what we asked for.
// This distinction is load-bearing: the deployed API honours ?format=arrow only on
// some code paths, and its own comment calls CSV "the default (legacy UI + grafana
// consumers)". A client that assumes Arrow because it requested Arrow will
// misparse a CSV body.
type Response struct {
	Format string // ctArrowStream or ctCSV
	Body   []byte
}

// Empty reports whether the server sent no payload at all. On the Arrow path this
// is ambiguous -- see Datasource.query.
func (r *Response) Empty() bool {
	return len(bytes.TrimSpace(r.Body)) == 0
}

// Query executes SQL and returns the decoded response, or a classified error.
//
// wantArrow selects the transport. Arrow preserves DuckDB's types; CSV is the only
// transport on which this API can report a failure that happens after the 200
// header was flushed.
func (c *RESTClient) Query(ctx context.Context, sql string, wantArrow bool) (*Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.queryURL(wantArrow), strings.NewReader(sql))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "text/plain")
	if wantArrow {
		req.Header.Set("Accept", ctArrowStream)
	} else {
		req.Header.Set("Accept", ctCSV)
	}
	if c.settings.Secrets != nil && c.settings.Secrets.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.settings.Secrets.Token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("could not read the response body: %w", err)
	}

	contentType := strings.ToLower(resp.Header.Get("Content-Type"))

	// 1. Ordinary HTTP failure. The body is usually {"error": "..."}.
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &APIError{
			StatusCode: resp.StatusCode,
			Message:    extractErrorMessage(body),
		}
	}

	// 2. HTTP 200 that is actually a failure.
	//
	// THIS IS THE DANGEROUS ONE. The CSV streaming path flushes a 200 header
	// before executing, so a failure mid-stream can only be reported as a
	// "# ERROR: ..." comment line inside a 200 body (main.py:576). Reading that
	// as data would render an error string in a panel as though it were a value,
	// which is the worst failure mode available to us.
	if msg, found := findCSVError(body); found {
		return nil, &APIError{StatusCode: resp.StatusCode, Message: msg}
	}

	// 3. A JSON error body served with a 200. Belt and braces -- cheap to check
	// and it costs one byte comparison on the happy path.
	if looksLikeJSONError(body) {
		return nil, &APIError{StatusCode: resp.StatusCode, Message: extractErrorMessage(body)}
	}

	switch {
	case strings.Contains(contentType, ctArrowStream):
		return &Response{Format: ctArrowStream, Body: body}, nil
	case strings.Contains(contentType, ctCSV):
		return &Response{Format: ctCSV, Body: body}, nil
	case len(bytes.TrimSpace(body)) == 0:
		// Empty body with no useful content type: treat as an empty Arrow stream,
		// which readerToFrame handles as zero rows.
		return &Response{Format: ctArrowStream, Body: nil}, nil
	default:
		// Unknown content type. Guess from the body rather than failing outright:
		// an Arrow IPC stream starts with the 0xFFFFFFFF continuation marker.
		if isArrowIPC(body) {
			return &Response{Format: ctArrowStream, Body: body}, nil
		}
		return &Response{Format: ctCSV, Body: body}, nil
	}
}

// APIError is a failure reported by the QuixLake API, as opposed to a transport
// failure. Message carries the DuckDB text where the API gave us one.
type APIError struct {
	StatusCode int
	Message    string
}

func (e *APIError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("QuixLake API returned HTTP %d", e.StatusCode)
	}
	return e.Message
}

// isArrowIPC reports whether the body opens with the Arrow IPC stream
// continuation marker.
func isArrowIPC(body []byte) bool {
	return len(body) >= 4 && body[0] == 0xFF && body[1] == 0xFF && body[2] == 0xFF && body[3] == 0xFF
}

// findCSVError looks for the "# ERROR:" sentinel that the CSV path emits.
//
// It can appear as the whole body (the query failed before producing rows) or as a
// trailing line after partial results, so we scan every line rather than only the
// prefix. We deliberately do not accept partial rows plus an error as success:
// a half-complete series silently rendered as a full one is worse than an error.
func findCSVError(body []byte) (string, bool) {
	if !bytes.Contains(body, []byte(csvErrorSentinel)) {
		return "", false
	}
	for line := range strings.SplitSeq(string(body), "\n") {
		trimmed := strings.TrimSpace(line)
		if after, ok := strings.CutPrefix(trimmed, csvErrorSentinel); ok {
			return strings.TrimSpace(after), true
		}
	}
	// Sentinel present but not at the start of any line; surface the raw text
	// rather than pretending the response was clean.
	return strings.TrimSpace(string(body)), true
}

// looksLikeJSONError reports whether the body is a JSON object carrying an "error"
// key.
func looksLikeJSONError(body []byte) bool {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &probe); err != nil {
		return false
	}
	_, ok := probe["error"]
	return ok
}

// extractErrorMessage pulls the human-readable text out of an error body.
func extractErrorMessage(body []byte) string {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return ""
	}

	if trimmed[0] == '{' {
		var payload struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(trimmed, &payload); err == nil {
			if payload.Error != "" {
				return payload.Error
			}
			if payload.Message != "" {
				return payload.Message
			}
		}
	}

	if msg, found := findCSVError(trimmed); found {
		return msg
	}

	const maxLen = 500
	text := string(trimmed)
	if len(text) > maxLen {
		text = text[:maxLen] + "..."
	}
	return text
}

// classifyError turns a failure into a message plus a Grafana error source.
//
// Every failure here is Downstream: the lakehouse is a separate service, and
// attributing its outages to the plugin would corrupt the plugin's error-rate SLO
// in Grafana.
func classifyError(err error, baseURL string) (string, backend.ErrorSource) {
	if err == nil {
		return "", backend.ErrorSourceDownstream
	}

	var apiErr *APIError
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return fmt.Sprintf("Authentication rejected by %s -- check the API token in the datasource settings.", baseURL),
				backend.ErrorSourceDownstream
		case http.StatusNotFound:
			return fmt.Sprintf("%s/query not found -- check the URL points at the API root, with no /grafana suffix.", baseURL),
				backend.ErrorSourceDownstream
		default:
			// SQL errors (bad column, DuckDB binder errors) land here with the
			// DuckDB text intact, which is the most useful thing to show.
			return apiErr.Error(), backend.ErrorSourceDownstream
		}
	}

	msg := err.Error()
	lower := strings.ToLower(msg)

	switch {
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(lower, "context deadline exceeded"):
		return fmt.Sprintf("Query timed out. Raise the query timeout in the datasource settings, or narrow the time range. (%s)", baseURL),
			backend.ErrorSourceDownstream

	case strings.Contains(lower, "x509"),
		strings.Contains(lower, "tls"),
		strings.Contains(lower, "certificate"):
		return fmt.Sprintf("TLS error talking to %s: %v", baseURL, msg), backend.ErrorSourceDownstream

	case strings.Contains(lower, "no such host"),
		strings.Contains(lower, "connection refused"),
		strings.Contains(lower, "dial tcp"):
		return fmt.Sprintf("Cannot reach the QuixLake API at %s -- check the URL and that the service is running. (%v)", baseURL, msg),
			backend.ErrorSourceDownstream

	default:
		return msg, backend.ErrorSourceDownstream
	}
}
