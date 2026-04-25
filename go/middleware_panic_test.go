package simsysmetrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestMiddlewareRecordsHandlerPanicAs5xx asserts that a handler panic
// before WriteHeader runs is correctly attributed to status="5xx" rather
// than the default status=200 captured by statusRecorder.
//
// Pre-v0.3.3 the deferred labeller saw wrapped.status == 200 because
// nothing had written a status before the panic, and the panic propagated
// past the labeller — counted as a successful 2xx request. The fix adds
// a recover() that sets status=500, records the metric, and re-panics so
// the net/http server's default recovery (log + close connection) still
// runs.
func TestMiddlewareRecordsHandlerPanicAs5xx(t *testing.T) {
	m := mustInstallForTest(t, "mw-panic")

	handler := m.Middleware(MiddlewareOpts{
		Extractor: func(r *http.Request) string {
			if r.URL.Path == "/explode" {
				return "/explode"
			}
			return ""
		},
	})(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		panic("kaboom")
	}))

	srv := httptest.NewServer(handler)
	defer srv.Close()

	// httptest's server installs the default net/http panic recovery,
	// so the client sees a connection close (or 500) — the handler
	// panic does NOT crash the test process.
	resp, err := srv.Client().Get(srv.URL + "/explode")
	if err == nil {
		// Some Go versions still send a 500 before closing — drain
		// and discard.
		resp.Body.Close()
	}

	body := scrapeMetrics(t, m)
	svc := m.Service()

	// Must record a 5xx counter sample for /explode.
	want5xx := `simsys_http_requests_total{method="GET",route="/explode",service="` + svc + `",status="5xx"}`
	if !strings.Contains(body, want5xx) {
		t.Errorf("expected status=5xx counter for panic on /explode, got:\n%s", body)
	}
	// Must NOT record a 2xx sample for the same request.
	want2xx := `simsys_http_requests_total{method="GET",route="/explode",service="` + svc + `",status="2xx"}`
	if strings.Contains(body, want2xx) {
		t.Errorf("panic must not be recorded as 2xx, got:\n%s", body)
	}
}

// TestMiddlewarePanicAfterPartialWriteKeepsWrittenStatus asserts that if
// a handler writes a status code BEFORE panicking, that explicit status
// is preserved (not overwritten with 500).
func TestMiddlewarePanicAfterPartialWriteKeepsWrittenStatus(t *testing.T) {
	m := mustInstallForTest(t, "mw-panic-partial")

	handler := m.Middleware(MiddlewareOpts{
		Extractor: func(*http.Request) string { return "/partial" },
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest) // 400
		_, _ = w.Write([]byte("partial body before crash"))
		panic("after partial write")
	}))

	srv := httptest.NewServer(handler)
	defer srv.Close()
	resp, err := srv.Client().Get(srv.URL + "/partial")
	if err == nil {
		resp.Body.Close()
	}

	body := scrapeMetrics(t, m)
	svc := m.Service()

	// The handler explicitly wrote 400 before panicking; that 4xx
	// classification must survive the panic-recovery path.
	want4xx := `simsys_http_requests_total{method="GET",route="/partial",service="` + svc + `",status="4xx"}`
	if !strings.Contains(body, want4xx) {
		t.Errorf("expected status=4xx (handler wrote 400 before panic), got:\n%s", body)
	}
}
