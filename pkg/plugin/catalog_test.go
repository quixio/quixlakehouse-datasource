package plugin

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/quix/quixlakehouse/pkg/models"
)

// newTestClient points a RESTClient at a stub server. It bypasses
// NewRESTClient because that needs a backend.DataSourceInstanceSettings and
// Grafana's httpclient provider, neither of which adds anything to these tests.
func newTestClient(baseURL, token string) *RESTClient {
	return &RESTClient{
		http:    http.DefaultClient,
		baseURL: baseURL,
		settings: &models.PluginSettings{
			Secrets: &models.SecretPluginSettings{Token: token},
		},
	}
}

func TestPartitionValues(t *testing.T) {
	var gotPath, gotQuery, gotAuth, gotAccept string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		gotAccept = r.Header.Get("Accept")
		w.Header().Set("Content-Type", ctJSON)
		_, _ = w.Write([]byte(`{"table":"rawdata","column":"rotorID","values":["a","b"],"count":2}`))
	}))
	defer srv.Close()

	c := newTestClient(srv.URL, "tok-123")
	got, err := c.PartitionValues(context.Background(), "rawdata", "rotorID", map[string]string{
		"year":  "2026",
		"month": "02",
		"empty": "", // dropped: an empty filter would match nothing rather than everything
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Errorf("values = %v, want [a b]", got)
	}
	if gotPath != pathPartitionValues {
		t.Errorf("path = %q, want %q", gotPath, pathPartitionValues)
	}
	// Sorted filter keys, so the URL is deterministic and cacheable.
	if want := "column=rotorID&month=02&table=rawdata&year=2026"; gotQuery != want {
		t.Errorf("query = %q, want %q", gotQuery, want)
	}
	if gotAuth != "Bearer tok-123" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if gotAccept != ctJSON {
		t.Errorf("Accept = %q, want %q", gotAccept, ctJSON)
	}
}

// A filter must never be able to overwrite the table or column it was scoped to.
func TestPartitionValuesFiltersCannotShadowReservedParams(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{"values":[]}`))
	}))
	defer srv.Close()

	c := newTestClient(srv.URL, "")
	_, err := c.PartitionValues(context.Background(), "rawdata", "rotorID", map[string]string{
		"table":  "other",
		"column": "somethingElse",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if want := "column=rotorID&table=rawdata"; gotQuery != want {
		t.Errorf("query = %q, want %q", gotQuery, want)
	}
}

func TestPartitionValuesRequiresTableAndColumn(t *testing.T) {
	c := newTestClient("http://unused", "")
	if _, err := c.PartitionValues(context.Background(), "", "rotorID", nil); err == nil {
		t.Error("expected an error for an empty table")
	}
	if _, err := c.PartitionValues(context.Background(), "rawdata", "  ", nil); err == nil {
		t.Error("expected an error for a blank column")
	}
}

// 501 is the API's documented signal that the catalog predates the endpoint, and it
// must stay distinguishable so a /partitions fallback can branch on it rather than
// string-matching an error message.
func TestPartitionValuesNotImplementedIsDistinct(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = w.Write([]byte(`{"error":"not supported by the connected catalog"}`))
	}))
	defer srv.Close()

	c := newTestClient(srv.URL, "")
	_, err := c.PartitionValues(context.Background(), "rawdata", "rotorID", nil)
	if !errors.Is(err, ErrCatalogUnsupported) {
		t.Fatalf("err = %v, want ErrCatalogUnsupported", err)
	}
}

func TestPartitionValuesPropagatesAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"Access Forbidden"}`))
	}))
	defer srv.Close()

	c := newTestClient(srv.URL, "")
	_, err := c.PartitionValues(context.Background(), "rawdata", "rotorID", nil)

	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %T (%v), want *APIError", err, err)
	}
	if apiErr.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", apiErr.StatusCode)
	}
}

// An HTML error page from a proxy must not be mistaken for a result. This is a real
// shape: the ingress returns "Bad Gateway" as text/html when it cuts a request off.
func TestPartitionValuesRejectsNonJSONBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("Bad Gateway"))
	}))
	defer srv.Close()

	c := newTestClient(srv.URL, "")
	if _, err := c.PartitionValues(context.Background(), "rawdata", "rotorID", nil); err == nil {
		t.Error("expected an error for a non-JSON 200 body")
	}
}
