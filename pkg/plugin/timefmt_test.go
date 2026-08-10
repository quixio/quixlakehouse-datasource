package plugin

import "testing"

// Regression: can_signals.t_rel is a DOUBLE, and DuckDB's epoch_ms/make_timestamp are
// declared over BIGINT, so $__timeGroup(t_rel, ...) failed at bind time with
// "No function matches the given name and argument types 'epoch_ms(DOUBLE)'".
// A bind error is not something the user can fix from the query editor, so every
// epoch conversion casts first.
func TestEpochToTimestampExprCastsForNonIntegerColumns(t *testing.T) {
	cases := []struct {
		format TimeFormat
		want   string
	}{
		{TimeFormatEpochMillis, "epoch_ms(CAST(t_rel AS BIGINT))"},
		{TimeFormatEpochMicros, "make_timestamp(CAST(t_rel AS BIGINT))"},
		{TimeFormatEpochNanos, "make_timestamp(CAST(t_rel AS BIGINT) // 1000)"},
		// to_timestamp is declared over DOUBLE, so casting to BIGINT here would throw
		// away sub-second precision that the column legitimately carries.
		{TimeFormatEpochSecs, "to_timestamp(CAST(t_rel AS DOUBLE))"},
		// Already a timestamp: no epoch conversion, just the type assertion.
		{TimeFormatTimestamp, "CAST(t_rel AS TIMESTAMP)"},
	}

	for _, c := range cases {
		if got := c.format.EpochToTimestampExpr("t_rel"); got != c.want {
			t.Errorf("%s: got %q, want %q", c.format, got, c.want)
		}
	}
}

// An unrecognised format must fall back to epoch milliseconds, which is how the sink
// writes time-series data -- and it must still cast.
func TestEpochToTimestampExprUnknownFormatFallsBackToMillis(t *testing.T) {
	if got := TimeFormat("nonsense").EpochToTimestampExpr("ts"); got != "epoch_ms(CAST(ts AS BIGINT))" {
		t.Errorf("got %q", got)
	}
}
