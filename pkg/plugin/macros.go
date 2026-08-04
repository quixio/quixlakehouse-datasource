package plugin

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/data/sqlutil"
)

// Macros are expanded in the BACKEND, not the frontend. That is not a style
// choice: alert rule evaluation runs inside grafana-server with no browser, so no
// frontend template interpolation happens. A macro that only works on a dashboard
// is a macro that breaks the moment someone puts an alert on the panel -- which is
// the entire point of this plugin (spec section 1).
//
// We deliberately do NOT implement `$__from` / `$__to` / `$__interval`. Those are
// Grafana *global built-in variables*: the frontend substitutes them as bare epoch
// milliseconds before a datasource ever sees the query, so a backend
// implementation would silently disagree with the dashboard behaviour. The repo's
// existing server-side path spells them that way
// (quix-ts-datalake-api/grafana_query_builder.py:161-171) and inherits exactly that
// collision. We use Grafana's standard macro spelling instead.

// timeUnitToDuckDB maps a Grafana interval unit onto a DuckDB INTERVAL unit word.
//
// The Python implementation only maps s/m/h/d, so an interval of `1w` passes
// through untouched and produces the invalid `INTERVAL '1w'`. Fixed here rather
// than replicated (spec section 7 recommends fixing it in Go).
var timeUnitToDuckDB = map[string]string{
	"ms": "milliseconds",
	"s":  "seconds",
	"m":  "minutes",
	"h":  "hours",
	"d":  "days",
	"w":  "weeks",
	"M":  "months",
	"y":  "years",
}

var intervalPattern = regexp.MustCompile(`^(\d+)\s*(ms|s|m|h|d|w|M|y)$`)

// grafanaIntervalToDuckDB turns `30s` into `30 seconds`. Unparseable input is
// returned unchanged so DuckDB produces the error rather than us guessing.
func grafanaIntervalToDuckDB(interval string) string {
	trimmed := strings.TrimSpace(interval)
	m := intervalPattern.FindStringSubmatch(trimmed)
	if m == nil {
		return trimmed
	}
	unit, ok := timeUnitToDuckDB[m[2]]
	if !ok {
		return trimmed
	}
	return m[1] + " " + unit
}

// durationToGrafanaInterval renders a duration the way Grafana's $__interval does,
// used when a panel writes `$__timeGroup(col, $__interval)`.
func durationToGrafanaInterval(d time.Duration) string {
	switch {
	case d <= 0:
		return "1 minutes"
	case d < time.Second:
		return strconv.FormatInt(d.Milliseconds(), 10) + " milliseconds"
	case d < time.Minute:
		return strconv.FormatInt(int64(d.Seconds()), 10) + " seconds"
	case d < time.Hour:
		return strconv.FormatInt(int64(d.Minutes()), 10) + " minutes"
	case d < 24*time.Hour:
		return strconv.FormatInt(int64(d.Hours()), 10) + " hours"
	default:
		return strconv.FormatInt(int64(d.Hours()/24), 10) + " days"
	}
}

// firstArg returns the first macro argument, or "" when the macro was written with
// empty brackets. sqlutil's parser yields a single empty string for `$__timeFrom()`.
func firstArg(args []string) string {
	if len(args) == 0 {
		return ""
	}
	return strings.TrimSpace(args[0])
}

// timeLiteral renders one end of the time range as the SQL literal appropriate to
// how the column is stored: a bare integer for epoch columns, a quoted ISO-8601
// string for native TIMESTAMP columns.
func timeLiteral(t time.Time, format TimeFormat) string {
	if format.IsEpoch() {
		return strconv.FormatInt(format.EpochValue(t), 10)
	}
	return "'" + t.UTC().Format(time.RFC3339) + "'"
}

// buildMacros returns the macro set for one query. It closes over the query's
// declared time format, which is what makes the epoch-vs-ISO branch work.
//
// sqlutil.Interpolate merges these over sqlutil.DefaultMacros, so ours win for the
// names we define and the SDK's defaults remain for $__table / $__column.
func buildMacros(format TimeFormat) sqlutil.Macros {
	return sqlutil.Macros{
		// $__timeFilter(col) -> col >= <from> AND col <= <to>
		"timeFilter": func(q *sqlutil.Query, args []string) (string, error) {
			col := firstArg(args)
			if col == "" {
				return "", fmt.Errorf("$__timeFilter requires a column argument, e.g. $__timeFilter(timestamp)")
			}
			return fmt.Sprintf("%s >= %s AND %s <= %s",
				col, timeLiteral(q.TimeRange.From, format),
				col, timeLiteral(q.TimeRange.To, format)), nil
		},

		// $__timeFrom() -> the range start as a literal.
		// Also accepts $__timeFrom(col) -> `col >= <from>` for symmetry with the SDK.
		"timeFrom": func(q *sqlutil.Query, args []string) (string, error) {
			lit := timeLiteral(q.TimeRange.From, format)
			if col := firstArg(args); col != "" {
				return fmt.Sprintf("%s >= %s", col, lit), nil
			}
			return lit, nil
		},

		// $__timeTo() -> the range end as a literal.
		"timeTo": func(q *sqlutil.Query, args []string) (string, error) {
			lit := timeLiteral(q.TimeRange.To, format)
			if col := firstArg(args); col != "" {
				return fmt.Sprintf("%s <= %s", col, lit), nil
			}
			return lit, nil
		},

		// $__timeGroup(col, interval) -> time_bucket(INTERVAL '<n units>', <col as timestamp>)
		//
		// Note on ordering: sqlutil.Interpolate applies macros longest-name-first,
		// so timeGroup (9 chars) is expanded before interval (8), which means a
		// panel written as $__timeGroup(ts, $__interval) hands us the literal
		// token "$__interval" as the second argument. We resolve it from the
		// query's own interval rather than failing.
		"timeGroup": func(q *sqlutil.Query, args []string) (string, error) {
			if len(args) < 2 {
				return "", fmt.Errorf("$__timeGroup requires 2 arguments, e.g. $__timeGroup(timestamp, 1m)")
			}
			col := strings.TrimSpace(args[0])
			if col == "" {
				return "", fmt.Errorf("$__timeGroup requires a column as its first argument")
			}

			rawInterval := strings.TrimSpace(args[1])
			var bucket string
			if strings.Contains(rawInterval, "$__interval") {
				bucket = durationToGrafanaInterval(q.Interval)
			} else {
				bucket = grafanaIntervalToDuckDB(rawInterval)
			}

			return fmt.Sprintf("time_bucket(INTERVAL '%s', %s)", bucket, format.EpochToTimestampExpr(col)), nil
		},
	}
}

// interpolate expands every macro in the raw SQL for the given query.
func interpolate(rawSQL string, q *sqlutil.Query, format TimeFormat) (string, error) {
	q.RawSQL = rawSQL
	out, err := sqlutil.Interpolate(q, buildMacros(format))
	if err != nil {
		return "", fmt.Errorf("macro expansion failed: %w", err)
	}
	return out, nil
}
