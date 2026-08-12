package plugin

import (
	"bytes"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/ipc"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

// Arrow -> data.Frame conversion.
//
// Both ends of this pipe are already Arrow: DuckDB produces columnar batches, the
// API serialises them as Arrow IPC via ?format=arrow, and Grafana's data.Frame is
// itself columnar. So the conversion is a per-column copy and nothing else -- no
// JSON, no row-at-a-time loop. (The legacy server-side path builds datapoints with
// pandas df.iterrows(), an O(rows) Python loop per panel;
// quix-ts-datalake-api/grafana_api.py:462-503.)

// recordStream is the subset of an Arrow reader we need. Both *ipc.Reader and
// Flight's reader satisfy it; depending on the interface rather than a concrete
// type is what let the transport swap from Flight to REST without touching this
// file.
type recordStream interface {
	Schema() *arrow.Schema
	Next() bool
	// arrow.RecordBatch, not arrow.Record: the latter is deprecated in arrow-go v18
	// to remove the ambiguity of "record" meaning a single row elsewhere. They are
	// the same type, so *ipc.Reader still satisfies this.
	Record() arrow.RecordBatch
	Err() error
}

// colBuilder accumulates one output column across every record batch in a stream.
type colBuilder struct {
	appendAll func(arr arrow.Array)
	build     func(name string) *data.Field
}

// newColBuilder builds a column accumulator. When the Arrow field is nullable we
// emit a pointer slice so NULL survives as nil rather than being silently coerced
// to a zero value -- a NULL speed reading is not 0 km/h.
func newColBuilder[T any](nullable bool, capacity int, valueAt func(arrow.Array, int) T) *colBuilder {
	if nullable {
		vals := make([]*T, 0, capacity)
		return &colBuilder{
			appendAll: func(arr arrow.Array) {
				for i := range arr.Len() {
					if arr.IsNull(i) {
						vals = append(vals, nil)
						continue
					}
					v := valueAt(arr, i)
					vals = append(vals, &v)
				}
			},
			build: func(name string) *data.Field { return data.NewField(name, nil, vals) },
		}
	}

	vals := make([]T, 0, capacity)
	return &colBuilder{
		appendAll: func(arr arrow.Array) {
			for i := range arr.Len() {
				vals = append(vals, valueAt(arr, i))
			}
		},
		build: func(name string) *data.Field { return data.NewField(name, nil, vals) },
	}
}

// builderFor picks the accumulator for one Arrow field.
//
// asTime forces a numeric column to be materialised as a Grafana time field, which
// is how an INT64 epoch-millis column becomes something a time-series panel can
// plot. Arrow-native timestamp/date types are always converted to time.Time.
func builderFor(field arrow.Field, asTime bool, format TimeFormat, origin int64, capacity int) (*colBuilder, error) {
	nullable := field.Nullable

	if asTime {
		switch field.Type.ID() {
		case arrow.INT64:
			return newColBuilder(nullable, capacity, func(a arrow.Array, i int) time.Time {
				return format.ToTime(a.(*array.Int64).Value(i) - origin)
			}), nil
		case arrow.INT32:
			return newColBuilder(nullable, capacity, func(a arrow.Array, i int) time.Time {
				return format.ToTime(int64(a.(*array.Int32).Value(i)) - origin)
			}), nil
		case arrow.UINT64:
			return newColBuilder(nullable, capacity, func(a arrow.Array, i int) time.Time {
				return format.ToTime(int64(a.(*array.Uint64).Value(i)) - origin)
			}), nil
		case arrow.FLOAT64:
			return newColBuilder(nullable, capacity, func(a arrow.Array, i int) time.Time {
				return format.ToTime(int64(a.(*array.Float64).Value(i)) - origin)
			}), nil
		}
		// Anything else falls through to its natural mapping below; an Arrow
		// timestamp is already a time field.
	}

	switch field.Type.ID() {
	case arrow.BOOL:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) bool {
			return a.(*array.Boolean).Value(i)
		}), nil
	case arrow.INT8:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) int8 {
			return a.(*array.Int8).Value(i)
		}), nil
	case arrow.INT16:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) int16 {
			return a.(*array.Int16).Value(i)
		}), nil
	case arrow.INT32:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) int32 {
			return a.(*array.Int32).Value(i)
		}), nil
	case arrow.INT64:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) int64 {
			return a.(*array.Int64).Value(i)
		}), nil
	case arrow.UINT8:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) uint8 {
			return a.(*array.Uint8).Value(i)
		}), nil
	case arrow.UINT16:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) uint16 {
			return a.(*array.Uint16).Value(i)
		}), nil
	case arrow.UINT32:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) uint32 {
			return a.(*array.Uint32).Value(i)
		}), nil
	case arrow.UINT64:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) uint64 {
			return a.(*array.Uint64).Value(i)
		}), nil
	case arrow.FLOAT32:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) float32 {
			return a.(*array.Float32).Value(i)
		}), nil
	case arrow.FLOAT64:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) float64 {
			return a.(*array.Float64).Value(i)
		}), nil
	case arrow.STRING:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) string {
			return a.(*array.String).Value(i)
		}), nil
	case arrow.LARGE_STRING:
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) string {
			return a.(*array.LargeString).Value(i)
		}), nil
	case arrow.TIMESTAMP:
		unit := field.Type.(*arrow.TimestampType).Unit
		// Shifted as a duration, not an integer: $__timeGroup wraps the column in
		// time_bucket(), which hands back a TIMESTAMP, so by the time it reaches here
		// there is no epoch value left to subtract from. Skipping this is why relative
		// mode looked broken as soon as GROUP BY time was enabled -- the numeric paths
		// rebased and this one silently did not. Only the promoted time column is
		// shifted; an ordinary timestamp column keeps its real value.
		shift := time.Duration(0)
		if asTime {
			shift = format.OriginDuration(origin)
		}
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) time.Time {
			return a.(*array.Timestamp).Value(i).ToTime(unit).UTC().Add(-shift)
		}), nil
	case arrow.DATE32:
		dateShift := time.Duration(0)
		if asTime {
			dateShift = format.OriginDuration(origin)
		}
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) time.Time {
			return a.(*array.Date32).Value(i).ToTime().UTC().Add(-dateShift)
		}), nil
	case arrow.DATE64:
		date64Shift := time.Duration(0)
		if asTime {
			date64Shift = format.OriginDuration(origin)
		}
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) time.Time {
			return a.(*array.Date64).Value(i).ToTime().UTC().Add(-date64Shift)
		}), nil
	default:
		// Decimals, intervals, lists, structs, binary. Rendering them as text keeps
		// the panel working (as a table) instead of failing the whole query. A
		// production version should map DECIMAL to float64 and nested types to JSON.
		return newColBuilder(nullable, capacity, func(a arrow.Array, i int) string {
			return a.ValueStr(i)
		}), nil
	}
}

// frameOptions controls how a result stream becomes a frame.
type frameOptions struct {
	// RefID names the frame, which is what Grafana keys the response on.
	RefID string
	// Format is "time_series" or "table".
	Format string
	// TimeColumn, when set, is the column promoted to the frame's time field.
	TimeColumn string
	// TimeFormat says how that column is physically stored.
	TimeFormat TimeFormat
	// TimeOrigin is subtracted from the stored value in relative mode, so the run
	// starts at the epoch and the axis reads as elapsed. Zero in absolute mode.
	TimeOrigin int64
	// ExecutedQuery is the fully macro-expanded SQL, surfaced in the panel's
	// "Query inspector -> Query" tab. Parity with the legacy path's
	// executedQueryString (quix-ts-datalake-api/grafana_api.py:374-376).
	ExecutedQuery string
}

// pickTimeColumn decides which column, if any, becomes the frame's time field.
//
// An explicitly named column always wins. Otherwise, for a time_series query, we
// fall back to a name-based hint over integer/timestamp columns. The legacy server
// path detects the time column by name only, from a hardcoded list, so a table
// whose time column is `event_time` silently renders as a table instead of a series
// (quix-ts-datalake-api/grafana_api.py:469-475). Honouring an explicit selection
// first fixes that.
func pickTimeColumn(schema *arrow.Schema, opts frameOptions) int {
	if opts.TimeColumn != "" {
		for i, f := range schema.Fields() {
			if f.Name == opts.TimeColumn {
				return i
			}
		}
		// Named but absent: fall through rather than guess.
	}

	if opts.Format == FormatTable {
		return -1
	}

	for i, f := range schema.Fields() {
		if !looksLikeTimeColumn(f.Name) {
			continue
		}
		switch f.Type.ID() {
		case arrow.INT64, arrow.INT32, arrow.UINT64, arrow.FLOAT64,
			arrow.TIMESTAMP, arrow.DATE32, arrow.DATE64:
			return i
		}
	}
	return -1
}

// arrowBodyToFrame parses an Arrow IPC stream body into a frame.
//
// An empty body is a legitimate zero-row answer: the API returns one for a detected
// empty partition (main.py:438-446). It is ALSO what the Arrow streaming path
// produces when a query fails mid-stream, because Arrow IPC has no in-stream error
// channel and the handler just logs and closes (main.py:545-551). Those two cases
// are indistinguishable on the wire -- see ARCHITECTURE.md section 7.
func arrowBodyToFrame(body []byte, opts frameOptions) (*data.Frame, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return emptyFrame(opts), nil
	}

	reader, err := ipc.NewReader(bytes.NewReader(body))
	if err != nil {
		if err == io.EOF {
			return emptyFrame(opts), nil
		}
		return nil, fmt.Errorf("could not read the Arrow stream: %w", err)
	}
	defer reader.Release()

	return recordsToFrame(reader, opts)
}

// emptyFrame is a zero-row frame that still carries the executed SQL, so Query
// Inspector shows what ran even when nothing came back.
func emptyFrame(opts frameOptions) *data.Frame {
	frame := data.NewFrame(opts.RefID)
	frame.Meta = &data.FrameMeta{ExecutedQueryString: opts.ExecutedQuery}
	return frame
}

// recordsToFrame drains an Arrow record-batch stream into a single data.Frame.
func recordsToFrame(reader recordStream, opts frameOptions) (*data.Frame, error) {
	schema := reader.Schema()
	if schema == nil {
		return nil, fmt.Errorf("no schema in the Arrow stream")
	}

	fields := schema.Fields()
	timeIdx := pickTimeColumn(schema, opts)

	const initialCapacity = 1024
	builders := make([]*colBuilder, len(fields))
	for i, f := range fields {
		b, err := builderFor(f, i == timeIdx, opts.TimeFormat, opts.TimeOrigin, initialCapacity)
		if err != nil {
			return nil, fmt.Errorf("column %q: %w", f.Name, err)
		}
		builders[i] = b
	}

	for reader.Next() {
		rec := reader.Record()
		for i := range builders {
			builders[i].appendAll(rec.Column(i))
		}
	}
	// A truncated Arrow stream -- the shape a mid-query failure takes on the Arrow
	// path -- surfaces here rather than as an HTTP error.
	if err := reader.Err(); err != nil && err != io.EOF {
		return nil, fmt.Errorf("the Arrow stream ended early, which usually means the query failed after the response started: %w", err)
	}

	frameFields := make([]*data.Field, len(fields))
	for i, f := range fields {
		frameFields[i] = builders[i].build(f.Name)
	}

	// A wide time-series frame must lead with its time field.
	if timeIdx > 0 {
		tf := frameFields[timeIdx]
		frameFields = append(frameFields[:timeIdx], frameFields[timeIdx+1:]...)
		frameFields = append([]*data.Field{tf}, frameFields...)
	}

	frame := data.NewFrame(opts.RefID, frameFields...)
	frame.Meta = &data.FrameMeta{ExecutedQueryString: opts.ExecutedQuery}

	if opts.Format != FormatTable && timeIdx >= 0 {
		frame = shapeTimeSeries(frame)
	}

	return frame, nil
}

// shapeTimeSeries puts a time-series frame into the shape Grafana can plot.
//
// A GROUP BY on a tag produces a LONG frame -- time, the tag as a string column, and the
// value -- with one row per (time, tag). Grafana cannot split that into series on its
// own: it draws a single line named after the value column, which is why a `split by`
// query rendered one plot with "value" in the legend instead of one line per tag
// (sc-74547). data.LongToWide pivots it into one value field per distinct tag, each
// carrying the tag as a field label, which is what the legend reads.
//
// Declaring the frame type at all lets Grafana skip its own guesswork, but the type has
// to be honest: the previous version claimed WIDE unconditionally, so a long frame was
// announced as something it was not and the string column was simply ignored.
func shapeTimeSeries(frame *data.Frame) *data.Frame {
	switch frame.TimeSeriesSchema().Type {
	case data.TimeSeriesTypeLong:
		wide, err := data.LongToWide(frame, nil)
		if err != nil {
			// LongToWide requires the rows to be sorted by time, which is the query
			// author's job (ORDER BY) exactly as with every other SQL datasource. If they
			// are not, return the long frame unshaped and unlabelled rather than failing
			// the query: a table-shaped panel is recoverable, an error is not.
			return frame
		}
		wide.Meta = frame.Meta
		wide.Meta.Type = data.FrameTypeTimeSeriesWide
		wide.Meta.TypeVersion = data.FrameTypeVersion{0, 1}
		nameSeriesAfterLabels(wide)
		return wide
	case data.TimeSeriesTypeWide:
		frame.Meta.Type = data.FrameTypeTimeSeriesWide
		frame.Meta.TypeVersion = data.FrameTypeVersion{0, 1}
		return frame
	default:
		// Not a time series at all -- no numeric field, say. Leave it alone; claiming a
		// type Grafana then cannot honour is worse than claiming none.
		return frame
	}
}

// nameSeriesAfterLabels makes the legend read the tag rather than the value column.
//
// After the pivot every series carries the same field name -- "value" for a single
// `avg(value)` -- and differs only by its labels, so Grafana's legend would read
// "value {route=r1}". Naming the series after the tag alone is what the InfluxQL editor
// this builder imitates does, and it is the difference between a legend that identifies a
// route and one that says "value" three times.
//
// Only when there is exactly ONE distinct value-column name. With `avg(speed)` and
// `avg(rpm)` in the same query the column name carries meaning of its own, and dropping
// it would leave two different measures both labelled "r1".
func nameSeriesAfterLabels(frame *data.Frame) {
	valueFields := frame.Fields[1:]
	if len(valueFields) < 2 {
		return
	}

	names := map[string]struct{}{}
	for _, f := range valueFields {
		names[f.Name] = struct{}{}
	}
	if len(names) != 1 {
		return
	}

	for _, f := range valueFields {
		if len(f.Labels) == 0 {
			continue
		}
		// Sorted, so a two-tag split reads the same way on every series rather than
		// following Go's randomised map order.
		keys := make([]string, 0, len(f.Labels))
		for k := range f.Labels {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			parts = append(parts, f.Labels[k])
		}
		if f.Config == nil {
			f.Config = &data.FieldConfig{}
		}
		f.Config.DisplayNameFromDS = strings.Join(parts, " ")
	}
}
