package simsysmetrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMiddlewareRecordsHTTPMetrics(t *testing.T) {
	m := mustInstallForTest(t, "mw-records")

	extractor := func(r *http.Request) string {
		// Simple fake extractor — bucket by first path segment.
		if strings.HasPrefix(r.URL.Path, "/hello") {
			return "/hello"
		}
		return "unknown"
	}

	handler := m.Middleware(MiddlewareOpts{Extractor: extractor})(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(200)
			_, _ = w.Write([]byte("hi"))
		}),
	)

	srv := httptest.NewServer(handler)
	defer srv.Close()

	resp, err := srv.Client().Get(srv.URL + "/hello")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	resp.Body.Close()

	body := scrapeMetrics(t, m)
	if !strings.Contains(body, `simsys_http_requests_total{method="GET",route="/hello",service="`) {
		t.Errorf("expected http_requests_total for /hello; got:\n%s", body)
	}
	if !strings.Contains(body, `status="2xx"`) {
		t.Errorf("expected status=\"2xx\" bucket; got:\n%s", body)
	}
}

func TestMiddlewareSkipsMetricsPath(t *testing.T) {
	m := mustInstallForTest(t, "mw-skip")

	mux := http.NewServeMux()
	mux.Handle("/metrics", m.MetricsHandler())
	mux.HandleFunc("/app", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
	})

	extractor := func(r *http.Request) string {
		// Trivial extractor — keeps /app routed instead of collapsing to
		// __unmatched__, so the assertion below verifies /metrics-skip
		// behavior, not the cardinality-fallback behavior.
		if r.URL.Path == "/app" {
			return "/app"
		}
		return ""
	}
	handler := m.Middleware(MiddlewareOpts{MetricsPath: "/metrics", Extractor: extractor})(mux)
	srv := httptest.NewServer(handler)
	defer srv.Close()

	// Two /app calls to get a non-trivial counter value.
	for i := 0; i < 2; i++ {
		resp, err := srv.Client().Get(srv.URL + "/app")
		if err != nil {
			t.Fatalf("app GET: %v", err)
		}
		resp.Body.Close()
	}

	// Hit /metrics through the middleware-wrapped handler — it must NOT
	// count as a recorded request.
	for i := 0; i < 3; i++ {
		resp, err := srv.Client().Get(srv.URL + "/metrics")
		if err != nil {
			t.Fatalf("metrics GET: %v", err)
		}
		resp.Body.Close()
	}

	body := scrapeMetrics(t, m)
	// route="/app" count should be 2 (not 2 + /metrics calls).
	if !strings.Contains(body, `simsys_http_requests_total{method="GET",route="/app"`) {
		t.Errorf("expected /app in http_requests_total body:\n%s", body)
	}
	if strings.Contains(body, `route="/metrics"`) {
		t.Errorf("/metrics should be skipped, but it shows up in body:\n%s", body)
	}
}

func TestMiddlewareCapturesErrorStatus(t *testing.T) {
	m := mustInstallForTest(t, "mw-errstatus")
	handler := m.Middleware(MiddlewareOpts{})(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(503)
		}),
	)
	srv := httptest.NewServer(handler)
	defer srv.Close()
	resp, err := srv.Client().Get(srv.URL + "/broken")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	body := scrapeMetrics(t, m)
	if !strings.Contains(body, `status="5xx"`) {
		t.Errorf("expected status=5xx bucket; got:\n%s", body)
	}
}
