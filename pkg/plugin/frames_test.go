package plugin

import (
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/data"
)

func ts(seconds ...int) *data.Field {
	times := make([]time.Time, len(seconds))
	for i, s := range seconds {
		times[i] = time.Unix(int64(s), 0).UTC()
	}
	return data.NewField("time", nil, times)
}

func meta() *data.FrameMeta {
	return &data.FrameMeta{ExecutedQueryString: "SELECT 1"}
}

// A GROUP BY on a tag returns time, tag, value -- one row per (time, tag). Grafana draws
// that as a single line named after the value column, which is what "split by" looked
// like: one plot, "value" in the legend, no per-series colour (sc-74547).
func TestShapeTimeSeriesPivotsLongToWide(t *testing.T) {
	frame := data.NewFrame("A",
		ts(0, 0, 1, 1),
		data.NewField("route", nil, []string{"r1", "r2", "r1", "r2"}),
		data.NewField("value", nil, []float64{1, 10, 2, 20}),
	)
	frame.Meta = meta()

	got := shapeTimeSeries(frame)

	if got.Meta.Type != data.FrameTypeTimeSeriesWide {
		t.Fatalf("frame type = %q, want wide", got.Meta.Type)
	}
	// One time field plus one value field per distinct route.
	if len(got.Fields) != 3 {
		t.Fatalf("got %d fields, want 3 (time + one per route)", len(got.Fields))
	}

	routes := map[string]bool{}
	for _, f := range got.Fields[1:] {
		if f.Labels == nil {
			t.Fatalf("field %q carries no labels, so the legend cannot name the series", f.Name)
		}
		routes[f.Labels["route"]] = true
	}
	for _, want := range []string{"r1", "r2"} {
		if !routes[want] {
			t.Errorf("no series labelled route=%q; got %v", want, routes)
		}
	}
}

// With a single value column every series carries the same field name, so the tag is the
// only thing telling them apart. Grafana would render "value {route=r1}"; naming the
// series after the tag alone is what the InfluxQL editor does and what was asked for --
// the legend read "value" and gave no clue which route was which.
func TestShapeTimeSeriesNamesSeriesAfterTheTag(t *testing.T) {
	frame := data.NewFrame("A",
		ts(0, 0, 1, 1),
		data.NewField("route", nil, []string{"r1", "r2", "r1", "r2"}),
		data.NewField("value", nil, []float64{1, 10, 2, 20}),
	)
	frame.Meta = meta()

	got := shapeTimeSeries(frame)

	names := map[string]bool{}
	for _, f := range got.Fields[1:] {
		if f.Config == nil {
			t.Fatalf("field %q has no config, so the legend falls back to the column name", f.Name)
		}
		names[f.Config.DisplayNameFromDS] = true
	}
	for _, want := range []string{"r1", "r2"} {
		if !names[want] {
			t.Errorf("no series displayed as %q; got %v", want, names)
		}
	}
}

// `split by route, sender_node` must give one series per COMBINATION that occurs, not one
// per column. Combinations that never appear in the data get no series.
func TestShapeTimeSeriesSeriesPerLabelCombination(t *testing.T) {
	frame := data.NewFrame("A",
		ts(0, 0, 0, 1, 1, 1),
		data.NewField("route", nil, []string{"r1", "r1", "r2", "r1", "r1", "r2"}),
		data.NewField("sender_node", nil, []string{"n1", "n2", "n1", "n1", "n2", "n1"}),
		data.NewField("value", nil, []float64{1, 10, 100, 2, 20, 200}),
	)
	frame.Meta = meta()

	got := shapeTimeSeries(frame)

	// time + (r1,n1) + (r1,n2) + (r2,n1). (r2,n2) never occurs, so it gets no series.
	if len(got.Fields) != 4 {
		t.Fatalf("got %d fields, want 4 (time + one per observed combination)", len(got.Fields))
	}

	displayed := map[string]bool{}
	for _, f := range got.Fields[1:] {
		if len(f.Labels) != 2 {
			t.Errorf("series %q carries %d labels, want both split columns", f.Name, len(f.Labels))
		}
		displayed[f.Config.DisplayNameFromDS] = true
	}
	// Labels are joined in sorted key order -- route before sender_node -- so every
	// series reads the same way instead of following Go's randomised map order.
	for _, want := range []string{"r1 n1", "r1 n2", "r2 n1"} {
		if !displayed[want] {
			t.Errorf("no series displayed as %q; got %v", want, displayed)
		}
	}
}

// Two value columns need their own names back, or avg(speed) and avg(rpm) both read
// "r1" and the legend becomes ambiguous.
func TestShapeTimeSeriesKeepsColumnNamesWhenSeveralValues(t *testing.T) {
	frame := data.NewFrame("A",
		ts(0, 0, 1, 1),
		data.NewField("route", nil, []string{"r1", "r2", "r1", "r2"}),
		data.NewField("speed", nil, []float64{1, 10, 2, 20}),
		data.NewField("rpm", nil, []float64{3, 30, 4, 40}),
	)
	frame.Meta = meta()

	got := shapeTimeSeries(frame)

	for _, f := range got.Fields[1:] {
		if f.Config != nil && f.Config.DisplayNameFromDS != "" {
			t.Errorf("field %q was renamed to %q, hiding which measure it is", f.Name, f.Config.DisplayNameFromDS)
		}
	}
}

// Query Inspector shows the executed SQL from here, and the pivot builds a new frame.
func TestShapeTimeSeriesKeepsExecutedQuery(t *testing.T) {
	frame := data.NewFrame("A",
		ts(0, 1),
		data.NewField("route", nil, []string{"r1", "r1"}),
		data.NewField("value", nil, []float64{1, 2}),
	)
	frame.Meta = meta()

	got := shapeTimeSeries(frame)

	if got.Meta.ExecutedQueryString != "SELECT 1" {
		t.Errorf("executed query = %q, want it preserved through the pivot", got.Meta.ExecutedQueryString)
	}
}

func TestShapeTimeSeriesLeavesWideAlone(t *testing.T) {
	frame := data.NewFrame("A", ts(0, 1), data.NewField("value", nil, []float64{1, 2}))
	frame.Meta = meta()

	got := shapeTimeSeries(frame)

	if got.Meta.Type != data.FrameTypeTimeSeriesWide {
		t.Errorf("frame type = %q, want wide", got.Meta.Type)
	}
	if len(got.Fields) != 2 {
		t.Errorf("got %d fields, want the frame untouched", len(got.Fields))
	}
}

// LongToWide needs the rows ordered by time. Ordering is the query author's job, and a
// panel that renders as a table beats one that errors.
func TestShapeTimeSeriesFallsBackWhenUnsorted(t *testing.T) {
	frame := data.NewFrame("A",
		ts(5, 1),
		data.NewField("route", nil, []string{"r1", "r1"}),
		data.NewField("value", nil, []float64{1, 2}),
	)
	frame.Meta = meta()

	got := shapeTimeSeries(frame)

	if len(got.Fields) != 3 {
		t.Errorf("got %d fields, want the long frame returned unchanged", len(got.Fields))
	}
	if got.Meta.Type == data.FrameTypeTimeSeriesWide {
		t.Error("unsorted long frame was announced as wide, which it is not")
	}
}

// No numeric field means there is no series to draw; claiming a type Grafana cannot
// honour is worse than claiming none.
func TestShapeTimeSeriesLeavesNonSeriesUnclaimed(t *testing.T) {
	frame := data.NewFrame("A", ts(0, 1), data.NewField("route", nil, []string{"r1", "r2"}))
	frame.Meta = meta()

	got := shapeTimeSeries(frame)

	if got.Meta.Type == data.FrameTypeTimeSeriesWide {
		t.Error("a frame with no numeric field was announced as a wide time series")
	}
}
