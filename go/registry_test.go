package simsysmetrics

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestMakeCounterEnforcesPrefix(t *testing.T) {
	m := mustInstallForTest(t, "reg-test-counter")
	// Good name — no panic.
	_ = m.MakeCounter("simsys_things_total", "help", []string{"service", "a"})

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

// TestMakeCounterWarnsWhenServiceLabelMissing asserts the v0.3.7 warning:
// custom metrics created without `service` in labels emit a one-time
// slog.Warn at registration time.
func TestMakeCounterWarnsWhenServiceLabelMissing(t *testing.T) {
	m := mustInstallForTest(t, "reg-warn-svc")

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	defer slog.SetDefault(prev)

	// Reset the warned-set so this test is hermetic if other tests
	// already warned in the same process.
	warnedMissingServiceMu.Lock()
	delete(warnedMissingService, "simsys_no_service_label_test")
	warnedMissingServiceMu.Unlock()

	_ = m.MakeCounter(
		"simsys_no_service_label_test",
		"missing service label",
		[]string{"ticker"},
	)
	out := buf.String()
	if !strings.Contains(out, "service") || !strings.Contains(out, "level=WARN") {
		t.Errorf("expected service-label WARN in slog output, got:\n%s", out)
	}
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
