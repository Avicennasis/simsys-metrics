package simsysmetrics

import (
	"strings"
	"testing"
)

func TestMakeCounterEnforcesPrefix(t *testing.T) {
	m := mustInstallForTest(t, "reg-test-counter")
	// Good name — no panic.
	_ = m.MakeCounter("simsys_things_total", "help", []string{"a"})

	// Bad name — must panic with a helpful message.
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic for non-simsys_ name")
		}
		if !strings.Contains(r.(string), "must start with") {
			t.Fatalf("panic message didn't mention the prefix rule, got: %v", r)
		}
	}()
	_ = m.MakeCounter("things_total", "help", nil)
}

func TestMakeGaugeEnforcesPrefix(t *testing.T) {
	m := mustInstallForTest(t, "reg-test-gauge")
	_ = m.MakeGauge("simsys_depth", "help", nil)
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic")
		}
	}()
	_ = m.MakeGauge("depth", "help", nil)
}

func TestMakeHistogramEnforcesPrefix(t *testing.T) {
	m := mustInstallForTest(t, "reg-test-hist")
	_ = m.MakeHistogram("simsys_latency_seconds", "help", []string{"op"}, []float64{0.1, 1, 10})
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic")
		}
	}()
	_ = m.MakeHistogram("latency_seconds", "help", nil, nil)
}
