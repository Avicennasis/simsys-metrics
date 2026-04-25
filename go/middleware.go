package simsysmetrics

import (
	"net/http"
	"time"
)

// RouteExtractor maps an incoming request to its route template — the
// bounded-cardinality label we want on simsys_http_requests_total.
// Returning "" makes the request fall into the "__unmatched__" bucket, which
// is the right behaviour for 404s and other unrouted traffic. Callers with a
// real router should always supply an extractor.
//
// For Go 1.22+ stdlib net/http.ServeMux, use:
//
//	func(r *http.Request) string { return r.Pattern }
type RouteExtractor func(*http.Request) string

// UnmatchedRouteLabel is the route-label value used when no template was
// resolved (404, OPTIONS pre-flight, exception path, nil/empty extractor
// return). Collapsing all unmatched requests into one bucket keeps scanner
// traffic (/wp-admin, /.env, etc.) from blowing out cardinality.
const UnmatchedRouteLabel = "__unmatched__"

// MiddlewareOpts configures Middleware.
type MiddlewareOpts struct {
	// Extractor resolves a route template per request. If nil, every request
	// is labeled with UnmatchedRouteLabel — almost never what you want; supply
	// an extractor.
	Extractor RouteExtractor

	// MetricsPath is skipped to avoid /metrics self-instrumentation
	// polluting the very data it emits. Default: "/metrics".
	MetricsPath string
}

// Middleware returns an http.Handler wrapper that records
// simsys_http_requests_total + simsys_http_request_duration_seconds
// on every request. Usage:
//
//	mux := http.NewServeMux()
//	mux.Handle("/", app)
//	mux.Handle("/metrics", m.MetricsHandler())
//	handler := m.Middleware(MiddlewareOpts{Extractor: routeFn})(mux)
//	http.ListenAndServe(":8080", handler)
func (m *Metrics) Middleware(opts MiddlewareOpts) func(http.Handler) http.Handler {
	metricsPath := opts.MetricsPath
	if metricsPath == "" {
		metricsPath = "/metrics"
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == metricsPath {
				next.ServeHTTP(w, r)
				return
			}
			start := time.Now()
			wrapped := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			defer func() {
				elapsed := time.Since(start).Seconds()
				route := UnmatchedRouteLabel
				if opts.Extractor != nil {
					if tmpl := opts.Extractor(r); tmpl != "" {
						route = tmpl
					}
				}
				m.httpRequestsTotal.WithLabelValues(
					m.service, r.Method, route, StatusBucket(wrapped.status),
				).Inc()
				m.httpRequestDurationSeconds.WithLabelValues(
					m.service, r.Method, route,
				).Observe(elapsed)
			}()
			next.ServeHTTP(wrapped, r)
		})
	}
}

// statusRecorder wraps http.ResponseWriter to capture the status code.
//
// It exposes Unwrap() so handlers can reach Flusher/Hijacker/Pusher on the
// underlying writer via http.NewResponseController (Go 1.20+). This is the
// canonical Go middleware pattern and avoids dropping interfaces that
// websocket upgrades, HTTP/2 server push, and SSE flushing depend on.
type statusRecorder struct {
	http.ResponseWriter
	status  int
	written bool
}

func (sr *statusRecorder) WriteHeader(code int) {
	if !sr.written {
		sr.status = code
		sr.written = true
	}
	sr.ResponseWriter.WriteHeader(code)
}

func (sr *statusRecorder) Write(b []byte) (int, error) {
	sr.written = true
	return sr.ResponseWriter.Write(b)
}

// Unwrap returns the underlying ResponseWriter so http.NewResponseController
// can locate Flusher / Hijacker / Pusher / SetReadDeadline / SetWriteDeadline.
func (sr *statusRecorder) Unwrap() http.ResponseWriter {
	return sr.ResponseWriter
}
