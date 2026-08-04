package plugin

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/data"
)

// CSV -> data.Frame conversion.
//
// This path exists because the API does not always answer with Arrow even when
// Arrow is requested. Measured against the deployed API: a query with a LIMIT
// against a real table returns `Content-Type: text/csv` despite `?format=arrow`,
// because the LIMIT file-cap branch materialises through pandas and serialises CSV.
// The API's own comment calls CSV "the default (legacy UI + grafana consumers)".
//
// So the client dispatches on the content type it actually received, not on the one
// it asked for. Assuming Arrow because we requested Arrow would misparse a CSV body
// into garbage.
//
// The cost of CSV is real and worth stating: DuckDB's declared types are gone, so
// they must be re-inferred here. A column that is entirely NULL or entirely empty
// strings is indistinguishable from an empty text column, and DECIMAL/TIME
// precision is lost. That is exactly why Arrow is requested first.

// csvBodyToFrame parses a CSV body into a frame, inferring a type per column.
func csvBodyToFrame(body []byte, opts frameOptions) (*data.Frame, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return emptyFrame(opts), nil
	}

	reader := csv.NewReader(bytes.NewReader(trimmed))
	// Row lengths can legitimately vary if the API appends a trailing comment line.
	reader.FieldsPerRecord = -1

	header, err := reader.Read()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return emptyFrame(opts), nil
		}
		return nil, fmt.Errorf("could not read the CSV header: %w", err)
	}

	columns := make([][]string, len(header))
	for {
		record, err := reader.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, fmt.Errorf("could not read a CSV row: %w", err)
		}
		// Skip comment lines. The "# ERROR:" case is caught earlier in rest.go; any
		// other comment is metadata, not data.
		if len(record) > 0 && strings.HasPrefix(strings.TrimSpace(record[0]), "#") {
			continue
		}
		for i := range header {
			if i < len(record) {
				columns[i] = append(columns[i], record[i])
			} else {
				columns[i] = append(columns[i], "")
			}
		}
	}

	timeIdx := pickCSVTimeColumn(header, opts)

	fields := make([]*data.Field, len(header))
	for i, name := range header {
		fields[i] = csvColumnToField(name, columns[i], i == timeIdx, opts.TimeFormat)
	}

	// A wide time-series frame must lead with its time field.
	if timeIdx > 0 {
		tf := fields[timeIdx]
		fields = append(fields[:timeIdx], fields[timeIdx+1:]...)
		fields = append([]*data.Field{tf}, fields...)
	}

	frame := data.NewFrame(opts.RefID, fields...)
	frame.Meta = &data.FrameMeta{ExecutedQueryString: opts.ExecutedQuery}
	if opts.Format != FormatTable && timeIdx >= 0 {
		frame.Meta.Type = data.FrameTypeTimeSeriesWide
		frame.Meta.TypeVersion = data.FrameTypeVersion{0, 1}
	}
	return frame, nil
}

// pickCSVTimeColumn mirrors pickTimeColumn for the untyped CSV case: an explicitly
// named column wins, otherwise fall back to the name hint for a time_series query.
func pickCSVTimeColumn(header []string, opts frameOptions) int {
	if opts.TimeColumn != "" {
		for i, name := range header {
			if name == opts.TimeColumn {
				return i
			}
		}
	}
	if opts.Format == FormatTable {
		return -1
	}
	for i, name := range header {
		if looksLikeTimeColumn(name) {
			return i
		}
	}
	return -1
}

// csvColumnToField converts one text column into a typed Grafana field.
//
// Values are always nullable pointer slices: an empty CSV cell is a NULL, and
// coercing it to 0 would invent data.
func csvColumnToField(name string, values []string, asTime bool, format TimeFormat) *data.Field {
	if asTime {
		return data.NewField(name, nil, parseCSVTimeColumn(values, format))
	}

	if ints, ok := parseCSVInts(values); ok {
		return data.NewField(name, nil, ints)
	}
	if floats, ok := parseCSVFloats(values); ok {
		return data.NewField(name, nil, floats)
	}
	if bools, ok := parseCSVBools(values); ok {
		return data.NewField(name, nil, bools)
	}

	out := make([]*string, len(values))
	for i, v := range values {
		if isCSVNull(v) {
			continue
		}
		s := v
		out[i] = &s
	}
	return data.NewField(name, nil, out)
}

// isCSVNull treats an empty cell as NULL. CSV cannot distinguish an empty string
// from a NULL, so this is a genuine ambiguity inherited from the transport.
func isCSVNull(v string) bool {
	return strings.TrimSpace(v) == ""
}

// parseCSVTimeColumn converts a time column, accepting either an epoch integer or
// an ISO-8601 timestamp regardless of the declared format, because a CSV body gives
// no type information to rely on.
func parseCSVTimeColumn(values []string, format TimeFormat) []*time.Time {
	out := make([]*time.Time, len(values))
	for i, raw := range values {
		v := strings.TrimSpace(raw)
		if isCSVNull(v) {
			continue
		}
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			t := format.ToTime(n)
			out[i] = &t
			continue
		}
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			t := format.ToTime(int64(f))
			out[i] = &t
			continue
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05.999999", "2006-01-02 15:04:05", "2006-01-02"} {
			if t, err := time.Parse(layout, v); err == nil {
				utc := t.UTC()
				out[i] = &utc
				break
			}
		}
	}
	return out
}

// parseCSVInts succeeds only if every non-null value is an integer.
func parseCSVInts(values []string) ([]*int64, bool) {
	out := make([]*int64, len(values))
	sawValue := false
	for i, raw := range values {
		v := strings.TrimSpace(raw)
		if isCSVNull(v) {
			continue
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return nil, false
		}
		sawValue = true
		out[i] = &n
	}
	// An all-null column is reported as text rather than silently typed as numeric.
	return out, sawValue
}

// parseCSVFloats succeeds only if every non-null value is a float.
func parseCSVFloats(values []string) ([]*float64, bool) {
	out := make([]*float64, len(values))
	sawValue := false
	for i, raw := range values {
		v := strings.TrimSpace(raw)
		if isCSVNull(v) {
			continue
		}
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return nil, false
		}
		sawValue = true
		out[i] = &f
	}
	return out, sawValue
}

// parseCSVBools succeeds only if every non-null value is a boolean. Restricted to
// the spellings DuckDB actually emits, so a column of "t"/"f" strings is not
// silently turned into booleans.
func parseCSVBools(values []string) ([]*bool, bool) {
	out := make([]*bool, len(values))
	sawValue := false
	for i, raw := range values {
		v := strings.ToLower(strings.TrimSpace(raw))
		if isCSVNull(v) {
			continue
		}
		var b bool
		switch v {
		case "true":
			b = true
		case "false":
			b = false
		default:
			return nil, false
		}
		sawValue = true
		out[i] = &b
	}
	return out, sawValue
}
