package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/grafana/grafana-plugin-sdk-go/data/sqlutil"

	"github.com/quix/quixlakehouse/pkg/models"
)

// Query format values.
const (
	FormatTimeSeries = "time_series"
	FormatTable      = "table"
)

// healthCheckSQL is deliberately trivial and touches no object storage, so a green
// "Save & test" means "the API is reachable and the token is accepted" and nothing
// else. Probing a real table would make health depend on the catalog and on blob
// storage, and would bill a real query on every settings save.
const healthCheckSQL = "SELECT 1"

var (
	_ backend.QueryDataHandler      = (*Datasource)(nil)
	_ backend.CheckHealthHandler    = (*Datasource)(nil)
	_ instancemgmt.InstanceDisposer = (*Datasource)(nil)
)

// Datasource is one configured QuixLakeHouse connection. Grafana creates one
// instance per datasource UID and disposes it when the settings change.
type Datasource struct {
	settings *models.PluginSettings
	client   *RESTClient
	baseURL  string
}

// NewDatasource is the instance factory handed to datasource.Manage.
func NewDatasource(ctx context.Context, instance backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	cfg, err := models.LoadPluginSettings(instance)
	if err != nil {
		return nil, err
	}

	client, err := NewRESTClient(ctx, instance, cfg)
	if err != nil {
		return nil, err
	}

	log.DefaultLogger.Info("QuixLakeHouse datasource created",
		"url", instance.URL, "unionByName", cfg.UnionByName, "timeoutSeconds", cfg.TimeoutSeconds)

	return &Datasource{
		settings: cfg,
		client:   client,
		baseURL:  strings.TrimRight(instance.URL, "/"),
	}, nil
}

// Dispose releases per-instance resources. The HTTP client needs no explicit
// teardown; its idle connections are reaped by the transport.
func (d *Datasource) Dispose() {}

// queryModel is the JSON the query editor sends per panel target.
//
// intervalMs, maxDataPoints and the time range are NOT duplicated here -- they
// arrive on backend.DataQuery and are read from there.
type queryModel struct {
	// RawSQL is the SQL to execute. Raw SQL is the only query type in this spike;
	// the visual builder is a later phase.
	RawSQL string `json:"rawSql"`
	// Format is "time_series" (default) or "table".
	Format string `json:"format"`
	// TimeColumn optionally names the column to promote to the frame's time field.
	TimeColumn string `json:"timeColumn"`
	// TimeFormat says how that column is stored; defaults to epoch milliseconds,
	// which is how the QuixLake sink writes time-series data.
	TimeFormat TimeFormat `json:"timeFormat"`
	// TimeMode selects an absolute or a zero-based ("relative") time axis.
	TimeMode TimeMode `json:"timeMode"`
	// TimeOrigin is the instant that becomes zero in relative mode, in the time
	// column's own units. Supplied by the caller and stored in the panel, NOT derived
	// per request: an origin recomputed from the filtered rows would move every time
	// the user zoomed, so the window would always restart at zero and zoom would look
	// broken.
	TimeOrigin int64 `json:"timeOrigin"`
}

// TimeMode selects how the time axis is anchored.
type TimeMode string

const (
	// TimeModeAbsolute plots real wall-clock instants. The default.
	TimeModeAbsolute TimeMode = "absolute"
	// TimeModeRelative rebases the time field so the run starts at zero.
	//
	// Zero means the Unix epoch, because a Grafana time field is defined as an offset
	// from 1970-01-01 and there is no duration field type -- so an elapsed axis can
	// only be expressed by moving the data, not by changing the axis. The dashboard
	// range is then read as elapsed too: $__timeFilter shifts by the origin, so
	// selecting 00:00:20-00:00:40 fetches the rows 20-40 seconds into the run.
	//
	// Cost, and it is real: the frames claim to be from 1970. Alert rules on them are
	// meaningless and now-relative ranges never match. Fine for a fixed-window
	// analysis dashboard; wrong for anything alerting.
	TimeModeRelative TimeMode = "relative"
)

// Normalize defaults an unset or unrecognised mode to absolute.
func (m TimeMode) Normalize() TimeMode {
	if TimeMode(strings.TrimSpace(string(m))) == TimeModeRelative {
		return TimeModeRelative
	}
	return TimeModeAbsolute
}

// QueryData runs every target on the panel. Grafana calls this for dashboards,
// Explore, and -- the reason this plugin has a backend at all -- alert rule
// evaluation, where there is no browser in the loop.
func (d *Datasource) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	response := backend.NewQueryDataResponse()

	for _, q := range req.Queries {
		response.Responses[q.RefID] = d.query(ctx, q)
	}

	return response, nil
}

func (d *Datasource) query(ctx context.Context, query backend.DataQuery) backend.DataResponse {
	var qm queryModel
	if len(query.JSON) > 0 {
		if err := json.Unmarshal(query.JSON, &qm); err != nil {
			return backend.ErrDataResponse(backend.StatusBadRequest,
				fmt.Sprintf("could not parse the query model: %v", err))
		}
	}

	rawSQL := strings.TrimSpace(qm.RawSQL)
	if rawSQL == "" {
		// An empty panel is not an error; returning no frames leaves the panel blank
		// instead of showing a red banner while the user is still typing.
		return backend.DataResponse{}
	}

	format := qm.Format
	if format == "" {
		format = FormatTimeSeries
	}
	timeFormat := qm.TimeFormat.Normalize()

	// In relative mode the stored column is untouched; only the range bounds and the
	// returned values are shifted, so the SQL still reads the real data while the axis
	// reads as elapsed.
	origin := int64(0)
	if qm.TimeMode.Normalize() == TimeModeRelative {
		origin = qm.TimeOrigin
	}

	// Macro expansion happens here, in the backend, so it works identically for a
	// dashboard panel and an alert rule.
	sqlQuery := &sqlutil.Query{
		RawSQL:        rawSQL,
		RefID:         query.RefID,
		TimeRange:     query.TimeRange,
		Interval:      query.Interval,
		MaxDataPoints: query.MaxDataPoints,
	}
	expanded, err := interpolate(rawSQL, sqlQuery, timeFormat, origin)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, err.Error())
	}

	log.DefaultLogger.Debug("executing query", "refId", query.RefID, "sql", expanded)

	resp, err := d.client.Query(ctx, expanded, true /* wantArrow */)
	if err != nil {
		msg, source := classifyError(err, d.baseURL)
		return backend.DataResponse{Error: fmt.Errorf("%s", msg), ErrorSource: source}
	}

	// An empty Arrow body is ambiguous, and the ambiguity is dangerous.
	//
	// The API returns an empty body BOTH for a legitimately empty result (an empty
	// partition was detected, main.py:438-446) AND when a query fails after the 200
	// header was flushed, because Arrow IPC has no in-stream error channel so the
	// handler just logs and closes (main.py:545-551). Taking it at face value would
	// report a failed query as "no data" -- a silently wrong panel, and worse, an
	// alert rule that reads NoData instead of firing an error.
	//
	// CSV is the only transport where this API can report such a failure (it
	// appends a "# ERROR: ..." line). So when Arrow comes back empty, re-ask over
	// CSV purely to find out which of the two happened. This costs one extra query
	// only in the empty case, never on the happy path, and should be deleted once
	// the API gains a real error channel for Arrow.
	if resp.Format == ctArrowStream && resp.Empty() {
		csvResp, csvErr := d.client.Query(ctx, expanded, false /* wantArrow */)
		if csvErr != nil {
			msg, source := classifyError(csvErr, d.baseURL)
			return backend.DataResponse{Error: fmt.Errorf("%s", msg), ErrorSource: source}
		}
		// The CSV attempt succeeded, so the result really is empty. Use its body so a
		// header-only response still yields the right field names.
		resp = csvResp
	}

	opts := frameOptions{
		RefID:         query.RefID,
		Format:        format,
		TimeColumn:    qm.TimeColumn,
		TimeFormat:    timeFormat,
		TimeOrigin:    origin,
		ExecutedQuery: expanded,
	}

	frame, err := d.decode(resp, opts)
	if err != nil {
		msg, source := classifyError(err, d.baseURL)
		return backend.DataResponse{Error: fmt.Errorf("%s", msg), ErrorSource: source}
	}

	return backend.DataResponse{Frames: data.Frames{frame}}
}

// decode turns a response body into a frame, dispatching on the format the server
// actually sent. The API answers CSV on some paths even when Arrow was requested, so
// trusting the request here would misparse the body.
func (d *Datasource) decode(resp *Response, opts frameOptions) (*data.Frame, error) {
	if resp.Format == ctCSV {
		return csvBodyToFrame(resp.Body, opts)
	}
	return arrowBodyToFrame(resp.Body, opts)
}

// CheckHealth backs the "Save & test" button.
//
// This is the headline fix. The third-party simpod-json-datasource is frontend-only,
// so Grafana's server-side health path returns
// {"statusCode":500,"messageId":"plugin.unavailable"} -- the config page cannot
// verify anything. Here the check runs server-side, in this process, over the same
// HTTP client a real query uses.
func (d *Datasource) CheckHealth(ctx context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	if d.baseURL == "" {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "No URL configured. Set the QuixLake API URL (the API root, with no /grafana suffix).",
		}, nil
	}

	if d.settings.Secrets == nil || d.settings.Secrets.Token == "" {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "No API token configured. Add the QuixLake token in the datasource settings.",
		}, nil
	}

	resp, err := d.client.Query(ctx, healthCheckSQL, true /* wantArrow */)
	if err != nil {
		msg, _ := classifyError(err, d.baseURL)
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: msg}, nil
	}

	// Parse the result rather than trusting the status code. A 200 whose body we
	// cannot read is not a healthy datasource.
	frame, err := d.decode(resp, frameOptions{
		RefID:      "health",
		Format:     FormatTable,
		TimeFormat: DefaultTimeFormat,
	})
	if err != nil {
		msg, _ := classifyError(err, d.baseURL)
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: msg}, nil
	}
	if frame.Rows() == 0 {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: fmt.Sprintf("Connected to %s but %q returned no rows.", d.baseURL, healthCheckSQL),
		}, nil
	}

	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: fmt.Sprintf("Connected to the QuixLake API at %s.", d.baseURL),
	}, nil
}
