package plugin

import (
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data/sqlutil"
)

// The origin is 2026-08-05 10:30:33.288Z, the first sample of a can_signals run.
const testOrigin int64 = 1785925833288

func interpolateWith(t *testing.T, sql string, from, to time.Time, origin int64) string {
	t.Helper()
	q := &sqlutil.Query{
		RefID:     "A",
		TimeRange: backend.TimeRange{From: from, To: to},
	}
	out, err := interpolate(sql, q, TimeFormatEpochMillis, origin)
	if err != nil {
		t.Fatalf("interpolate: %v", err)
	}
	return out
}

// Relative mode reads the dashboard range as elapsed time, so "20s to 40s" must
// fetch the rows 20-40 seconds into the run -- origin+20s to origin+40s in the stored
// column. Without this shift the filter looks for data in 1970 and finds none, which
// is what makes drag-zoom work on an elapsed axis.
func TestTimeFilterShiftsByOriginInRelativeMode(t *testing.T) {
	from := time.UnixMilli(20_000).UTC() // 20s after the epoch
	to := time.UnixMilli(40_000).UTC()   // 40s after the epoch

	got := interpolateWith(t, "SELECT * FROM t WHERE $__timeFilter(ts_ms)", from, to, testOrigin)

	wantFrom := testOrigin + 20_000
	wantTo := testOrigin + 40_000
	if !strings.Contains(got, "ts_ms >= 1785925853288") {
		t.Errorf("expected lower bound %d in:\n%s", wantFrom, got)
	}
	if !strings.Contains(got, "ts_ms <= 1785925873288") {
		t.Errorf("expected upper bound %d in:\n%s", wantTo, got)
	}
}

// Absolute mode must be untouched: origin 0 leaves the bounds exactly as the
// dashboard supplied them.
func TestTimeFilterUnshiftedInAbsoluteMode(t *testing.T) {
	from := time.UnixMilli(testOrigin).UTC()
	to := time.UnixMilli(testOrigin + 60_000).UTC()

	got := interpolateWith(t, "SELECT * FROM t WHERE $__timeFilter(ts_ms)", from, to, 0)

	if !strings.Contains(got, "ts_ms >= 1785925833288") {
		t.Errorf("absolute lower bound was rewritten:\n%s", got)
	}
}

// $__timeFrom and $__timeTo share the same literal helper, so they must shift too --
// otherwise a query mixing them with $__timeFilter would compare two different
// origins and silently return the wrong window.
func TestTimeFromAndTimeToShiftConsistently(t *testing.T) {
	from := time.UnixMilli(1_000).UTC()
	to := time.UnixMilli(2_000).UTC()

	got := interpolateWith(t, "SELECT $__timeFrom(), $__timeTo()", from, to, testOrigin)

	if !strings.Contains(got, "1785925834288") || !strings.Contains(got, "1785925835288") {
		t.Errorf("timeFrom/timeTo did not shift by the origin:\n%s", got)
	}
}

// A native TIMESTAMP column has no integer to offset. Silently adding milliseconds to
// an ISO-8601 string would be meaningless, so the origin is ignored there.
func TestOriginIgnoredForNativeTimestampColumns(t *testing.T) {
	q := &sqlutil.Query{
		RefID: "A",
		TimeRange: backend.TimeRange{
			From: time.UnixMilli(0).UTC(),
			To:   time.UnixMilli(1_000).UTC(),
		},
	}
	out, err := interpolate("SELECT * FROM t WHERE $__timeFilter(ts)", q, TimeFormatTimestamp, testOrigin)
	if err != nil {
		t.Fatalf("interpolate: %v", err)
	}
	if !strings.Contains(out, "'1970-01-01T00:00:00Z'") {
		t.Errorf("timestamp literal should be unshifted:\n%s", out)
	}
}

func TestTimeModeNormalize(t *testing.T) {
	cases := map[TimeMode]TimeMode{
		"":          TimeModeAbsolute,
		"absolute":  TimeModeAbsolute,
		"relative":  TimeModeRelative,
		" relative": TimeModeRelative,
		"nonsense":  TimeModeAbsolute,
	}
	for in, want := range cases {
		if got := in.Normalize(); got != want {
			t.Errorf("%q normalised to %q, want %q", in, got, want)
		}
	}
}
