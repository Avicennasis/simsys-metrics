package simsysmetrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestNormalizeMethod unit-tests the allow-list helper directly.
func TestNormalizeMethod(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"GET", "GET"},
		{"get", "GET"},
		{"Post", "POST"},
		{"PATCH", "PATCH"},
		{"OPTIONS", "OPTIONS"},
		{"X_AUDIT_1", "OTHER"},
		{"ASDF", "OTHER"},
		{"", "OTHER"},
		{"BREW", "OTHER"},
		{"PROPFIND", "OTHER"},
	}
	for _, c := range cases {
		if got := NormalizeMethod(c.input); got != c.want {
			t.Errorf("NormalizeMethod(%q) = %q; want %q", c.input, got, c.want)
		}
	}
}

// TestMiddlewareGarbageMethodsCollapseToOTHER is the regression test for
// the v0.3.5 cardinality leak: arbitrary client-supplied HTTP methods
// like "X_AUDIT_1", "ASDF" produced one new label series per distinct
// method value. Now they all collapse to method="OTHER".
func TestMiddlewareGarbageMethodsCollapseToOTHER(t *testing.T) {
	m := mustInstallForTest(t, "method-norm")
	handler := m.Middleware(MiddlewareOpts{
		Extractor: func(*http.Request) string { return "/x" },
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
	}))

	srv := httptest.NewServer(handler)
	defer srv.Close()

	// Send several non-standard methods. The Go client accepts arbitrary
	// HTTP tokens.
	for _, garbage := range []string{"X_AUDIT_1", "ASDF", "BREW"} {
		req, err := http.NewRequest(garbage, srv.URL+"/x", nil)
		if err != nil {
			t.Fatalf("NewRequest %s: %v", garbage, err)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("Do %s: %v", garbage, err)
		}
		resp.Body.Close()
	}

	body := scrapeMetrics(t, m)

	// Raw garbage method names must NOT appear as label values.
	for _, garbage := range []string{"X_AUDIT_1", "ASDF", "BREW"} {
		needle := `method="` + garbage + `"`
		if strings.Contains(body, needle) {
			t.Errorf("garbage method %q leaked as label value:\n%s", garbage, body)
		}
	}
	// All three must collapse into method="OTHER".
	if !strings.Contains(body, `method="OTHER"`) {
		t.Errorf("expected method=\"OTHER\" bucket; got:\n%s", body)
	}
}
