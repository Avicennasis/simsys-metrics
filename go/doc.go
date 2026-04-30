// Package simsysmetrics is the Go sibling of the Python simsys-metrics and
// Node @simsys/metrics packages — a drop-in Prometheus /metrics template
// for Go web apps.
//
// One Install call registers the baseline metrics (build info, HTTP
// requests + duration, process CPU/memory/FDs), mounts the /metrics
// handler, and returns a *Metrics handle that consumers use to access
// prefix-guarded metric factories (MakeCounter/Gauge/Histogram) and
// opt-in helpers (TrackJob, TrackQueue, TrackProgress).
//
// Every metric name is forced to start with the simsys_ prefix at
// registration time, and every simsys metric carries a service label
// set once at Install time so cross-service PromQL like
// `sum by (service) (rate(simsys_http_requests_total[5m]))` works
// unmodified across every app.
//
// See https://github.com/Simmons-Systems/simsys-metrics for the full
// metric catalogue and cardinality rules.
package simsysmetrics
