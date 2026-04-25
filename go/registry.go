package simsysmetrics

import (
	"errors"
	"fmt"

	"github.com/prometheus/client_golang/prometheus"
)

// PREFIX is the required name prefix for every simsys metric.
const PREFIX = "simsys_"

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

// registerOrExisting registers c into reg. If reg already has an equivalent
// collector (same Desc), the existing one is returned instead — this makes
// repeated Install calls with the same Registry idempotent rather than
// panicking on duplicate-descriptor errors.
func registerOrExisting[T prometheus.Collector](reg *prometheus.Registry, c T) T {
	if err := reg.Register(c); err != nil {
		var alreadyErr prometheus.AlreadyRegisteredError
		if errors.As(err, &alreadyErr) {
			if existing, ok := alreadyErr.ExistingCollector.(T); ok {
				return existing
			}
		}
		panic(err)
	}
	return c
}

// MakeCounter creates a prefix-guarded CounterVec registered into m's
// registry. If a CounterVec with the same descriptor is already registered
// (Install called twice on the same Registry), the existing one is returned.
// Panics if name does not start with PREFIX.
func (m *Metrics) MakeCounter(name, help string, labels []string) *prometheus.CounterVec {
	c := prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: guardName(name), Help: help},
		labels,
	)
	return registerOrExisting(m.registry, c)
}

// MakeGauge creates a prefix-guarded GaugeVec registered into m's registry.
// Idempotent on the same registry. Panics if name does not start with PREFIX.
func (m *Metrics) MakeGauge(name, help string, labels []string) *prometheus.GaugeVec {
	g := prometheus.NewGaugeVec(
		prometheus.GaugeOpts{Name: guardName(name), Help: help},
		labels,
	)
	return registerOrExisting(m.registry, g)
}

// MakeHistogram creates a prefix-guarded HistogramVec registered into m's
// registry. If buckets is nil, prometheus default buckets are used.
// Idempotent on the same registry. Panics if name does not start with PREFIX.
func (m *Metrics) MakeHistogram(name, help string, labels []string, buckets []float64) *prometheus.HistogramVec {
	opts := prometheus.HistogramOpts{Name: guardName(name), Help: help}
	if buckets != nil {
		opts.Buckets = buckets
	}
	h := prometheus.NewHistogramVec(opts, labels)
	return registerOrExisting(m.registry, h)
}
