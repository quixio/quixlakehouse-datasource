package plugin

import (
	"strings"
	"time"
)

// TimeFormat describes how a time column is physically stored in the lakehouse.
//
// This matters because QuixLake tables commonly store time as an INT64 epoch
// value rather than a native TIMESTAMP -- `test_telemetry.timestamp` is INT64
// epoch milliseconds. Two things depend on knowing which it is:
//
//  1. Macro expansion. `$__timeFilter(timestamp)` must compare against a bare
//     integer for an epoch column and against a quoted ISO string for a TIMESTAMP
//     column. Comparing an ISO string to an INT64 is the bug that
//     quix-ts-datalake-api/test/test_grafana_epoch_millis.py exists to prevent.
//  2. Frame conversion. Grafana renders a time series only from a real time field,
//     so an epoch INT64 must be converted to time.Time rather than passed through
//     as a number.
//
// It is an explicit field on the query model, not a heuristic and not a schema
// lookup. A per-panel `GET /schema` call would double our request volume against
// the API (see spec section 9.4); a production version should cache that lookup
// and pre-fill this field in the editor.
type TimeFormat string

const (
	TimeFormatEpochMillis TimeFormat = "epoch_ms"
	TimeFormatEpochSecs   TimeFormat = "epoch_s"
	TimeFormatEpochMicros TimeFormat = "epoch_us"
	TimeFormatEpochNanos  TimeFormat = "epoch_ns"
	// TimeFormatTimestamp means the column is a native TIMESTAMP / DATE.
	TimeFormatTimestamp TimeFormat = "timestamp"
)

// DefaultTimeFormat matches how the QuixLake sink writes time-series data today.
const DefaultTimeFormat = TimeFormatEpochMillis

// Normalize resolves an empty or unrecognised value to the default.
func (f TimeFormat) Normalize() TimeFormat {
	switch TimeFormat(strings.TrimSpace(string(f))) {
	case TimeFormatEpochMillis:
		return TimeFormatEpochMillis
	case TimeFormatEpochSecs:
		return TimeFormatEpochSecs
	case TimeFormatEpochMicros:
		return TimeFormatEpochMicros
	case TimeFormatEpochNanos:
		return TimeFormatEpochNanos
	case TimeFormatTimestamp:
		return TimeFormatTimestamp
	default:
		return DefaultTimeFormat
	}
}

// IsEpoch reports whether the column holds a numeric epoch rather than a native
// timestamp. Drives the numeric-vs-ISO branch in every time macro.
func (f TimeFormat) IsEpoch() bool {
	return f.Normalize() != TimeFormatTimestamp
}

// EpochValue converts a wall-clock time into the integer this column stores.
func (f TimeFormat) EpochValue(t time.Time) int64 {
	switch f.Normalize() {
	case TimeFormatEpochSecs:
		return t.Unix()
	case TimeFormatEpochMicros:
		return t.UnixMicro()
	case TimeFormatEpochNanos:
		return t.UnixNano()
	default:
		return t.UnixMilli()
	}
}

// ToTime converts a stored epoch integer back into a wall-clock time, for frame
// conversion. A column stored in seconds rendered as milliseconds lands in 1970 --
// this is the guard the spec asks for.
func (f TimeFormat) ToTime(v int64) time.Time {
	switch f.Normalize() {
	case TimeFormatEpochSecs:
		return time.Unix(v, 0).UTC()
	case TimeFormatEpochMicros:
		return time.UnixMicro(v).UTC()
	case TimeFormatEpochNanos:
		return time.Unix(0, v).UTC()
	default:
		return time.UnixMilli(v).UTC()
	}
}

// EpochToTimestampExpr wraps an epoch column in the DuckDB call that turns it into
// a TIMESTAMP, so time_bucket() can group on it.
func (f TimeFormat) EpochToTimestampExpr(column string) string {
	switch f.Normalize() {
	case TimeFormatEpochSecs:
		return "to_timestamp(" + column + ")"
	case TimeFormatEpochMicros:
		return "make_timestamp(" + column + ")"
	case TimeFormatEpochNanos:
		return "make_timestamp(" + column + " // 1000)"
	case TimeFormatTimestamp:
		return "CAST(" + column + " AS TIMESTAMP)"
	default:
		return "epoch_ms(" + column + ")"
	}
}

// timeColumnNameHints are the column names treated as a time column when the query
// model does not name one explicitly. Mirrors the set already used server-side in
// quix-ts-datalake-api/grafana_query_builder.py so a migrated panel behaves the same.
var timeColumnNameHints = map[string]bool{
	"time":       true,
	"timestamp":  true,
	"ts":         true,
	"ts_ms":      true,
	"datetime":   true,
	"date":       true,
	"event_time": true,
}

// looksLikeTimeColumn reports whether a column name is conventionally a time column.
func looksLikeTimeColumn(name string) bool {
	return timeColumnNameHints[strings.ToLower(strings.TrimSpace(name))]
}
