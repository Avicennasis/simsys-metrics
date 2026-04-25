package simsysmetrics

import (
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"

	"github.com/prometheus/client_golang/prometheus"
)

// PREFIX is the required name prefix for every simsys metric.
const PREFIX = "simsys_"

// warnedMissingService tracks metric names we've already warned about,
// so a misuse logs once per process rather than spamming on every
// register call.
var (
	warnedMissingService    = map[string]struct{}{}
	warnedMissingServiceMu  sync.Mutex
)

// guardName returns name if it starts with PREFIX, else panics.
// Matches the Python _registry._guard_name and Node registry.guardName
// behaviour — registration-time enforcement is a programmer-error check,
// and panicking on misuse is idiomatic Go for init-time declarations.
func guardName(name string) string {
	if len(name) < len(PREFIX) || name[:len(PREFIX)] != PREFIX {
		panic(fmt.Sprintf(
			"simsys-metrics refuses to register metric %q: all metric names must start with %q",
			name, PREFIX,
		))
	}
	return name
}

// warnIfMissingService logs a warning when a custom metric's labels
// omit "service". The shared $service-templated Grafana dashboards
// filter on the service label; metrics without it can't participate
// in the cross-service contract. Doesn't error — consumer code that
// legitimately doesn't need `service` shouldn't be broken — but does
// make the deviation visible.
func warnIfMissingService(name string, labels []string) {
	if slices.Contains(labels, "service") {
		return
	}
	warnedMissingServiceMu.Lock()
	defer warnedMissingServiceMu.Unlock()
	if _, ok := warnedMissingService[name]; ok {
		return
	}
	warnedMissingService[name] = struct{}{}
	slog.Warn(
		"simsys-metrics: metric registered without 'service' in labels — "+
			"it will NOT participate in $service-templated dashboards. "+
			"Add 'service' to labels if you want cross-service queries to "+
			"work for this metric.",
		"name", name, "labels", labels,
	)
}

// registerOrExisting registers c into reg. If reg already has an equivalent
// collector (same Desc), the existing one is returned instead — this makes
// repeated Install calls with the same Registry idempotent rather than
// panicking on duplicate-descriptor errors.
func registerOrExisting[T prometheus.Collector](reg *prometheus.Registry, c T) T {
	out, _ := registerOrExistingWithStatus(reg, c)
	return out
}

// registerOrExistingWithStatus is the same as registerOrExisting but also
// reports whether the registered collector is the freshly-built one (true)
// or an already-registered equivalent that was reused (false). Install
// uses this signal to decide whether to (re-)write build_info — the
// freshly-built case writes the Set(1); the reused case skips the write
// to avoid leaving multiple build_info label-sets when the same Service
// is installed twice on the same Registry across a second boundary.
func registerOrExistingWithStatus[T prometheus.Collector](reg *prometheus.Registry, c T) (T, bool) {
	if err := reg.Register(c); err != nil {
		var alreadyErr prometheus.AlreadyRegisteredError
		if errors.As(err, &alreadyErr) {
			if existing, ok := alreadyErr.ExistingCollector.(T); ok {
				return existing, false
			}
		}
		panic(err)
	}
	return c, true
}

// MakeCounter creates a prefix-guarded CounterVec registered into m's
// registry. If a CounterVec with the same descriptor is already registered
// (Install called twice on the same Registry), the existing one is returned.
// Panics if name does not start with PREFIX. Warns at registration time
// if `service` is missing from labels (the metric won't participate in
// cross-service dashboards).
func (m *Metrics) MakeCounter(name, help string, labels []string) *prometheus.CounterVec {
	warnIfMissingService(name, labels)
	c := prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: guardName(name), Help: help},
		labels,
	)
	return registerOrExisting(m.registry, c)
}

// MakeGauge creates a prefix-guarded GaugeVec registered into m's registry.
// Idempotent on the same registry. Panics if name does not start with PREFIX.
// Warns if `service` is missing from labels.
func (m *Metrics) MakeGauge(name, help string, labels []string) *prometheus.GaugeVec {
	warnIfMissingService(name, labels)
	g := prometheus.NewGaugeVec(
		prometheus.GaugeOpts{Name: guardName(name), Help: help},
		labels,
	)
	return registerOrExisting(m.registry, g)
}

// MakeHistogram creates a prefix-guarded HistogramVec registered into m's
// registry. If buckets is nil, prometheus default buckets are used.
// Idempotent on the same registry. Panics if name does not start with PREFIX.
// Warns if `service` is missing from labels.
func (m *Metrics) MakeHistogram(name, help string, labels []string, buckets []float64) *prometheus.HistogramVec {
	warnIfMissingService(name, labels)
	opts := prometheus.HistogramOpts{Name: guardName(name), Help: help}
	if buckets != nil {
		opts.Buckets = buckets
	}
	h := prometheus.NewHistogramVec(opts, labels)
	return registerOrExisting(m.registry, h)
}
