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

// recordRequest emits one HTTP-request observation. Extracted so the
// happy path and the panic-recovery path can share the labelling logic
// without subtle drift.
func recordRequest(m *Metrics, r *http.Request, extractor RouteExtractor, status int, start time.Time) {
	elapsed := time.Since(start).Seconds()
	route := UnmatchedRouteLabel
	if extractor != nil {
		if tmpl := extractor(r); tmpl != "" {
			route = tmpl
		}
	}
	m.httpRequestsTotal.WithLabelValues(
		m.service, r.Method, route, StatusBucket(status),
	).Inc()
	m.httpRequestDurationSeconds.WithLabelValues(
		m.service, r.Method, route,
	).Observe(elapsed)
}

// Middleware returns an http.Handler wrapper that records
// simsys_http_requests_total + simsys_http_request_duration_seconds
// on every request.
//
// Panic recovery: handler panics are recorded as status="5xx" (the
// metric is emitted before the panic re-propagates), then re-panicked
// so net/http's default recovery (log + close connection) still runs.
// If the handler had explicitly written a status code before
// panicking, that status is preserved.
//
// Hijack-then-panic edge case: if a handler calls
// http.NewResponseController(w).Hijack() and then panics, the metric
// records 5xx as expected, but the re-panic propagates to a connection
// that is no longer http-managed — net/http cannot write a 500 body,
// it just closes the underlying socket. The client sees an abrupt
// connection close. This is the correct outcome (the protocol may
// already be mid-upgrade) but worth knowing for websocket-heavy apps.
//
// Usage:
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
				// Panic recovery: if next.ServeHTTP panicked before
				// writing a status, the default 200 in statusRecorder
				// would mislabel the request as 2xx. Mark it as 5xx,
				// emit the metric, then re-panic so net/http's default
				// recover-and-log + connection-close logic still runs.
				if rec := recover(); rec != nil {
					if !wrapped.written {
						wrapped.status = http.StatusInternalServerError
					}
					recordRequest(m, r, opts.Extractor, wrapped.status, start)
					panic(rec)
				}
				recordRequest(m, r, opts.Extractor, wrapped.status, start)
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
