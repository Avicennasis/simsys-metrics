package simsysmetrics

import (
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

// TestInstallIdempotentOnSameRegistry asserts that calling Install twice with
// the same Registry does not panic and yields a working Metrics handle. The
// previous implementation panicked inside MustRegister with
// AlreadyRegisteredError, breaking app factories and test fixtures that
// re-imported initialisation code.
func TestInstallIdempotentOnSameRegistry(t *testing.T) {
	reg := prometheus.NewRegistry()
	opts := InstallOpts{
		Service:  "idem-test",
		Version:  "0.0.0",
		Commit:   "deadbeef",
		Registry: reg,
	}

	m1, err := Install(opts)
	if err != nil {
		t.Fatalf("first Install: %v", err)
	}
	m2, err := Install(opts)
	if err != nil {
		t.Fatalf("second Install (idempotent): %v", err)
	}

	if m1 == nil || m2 == nil {
		t.Fatal("expected non-nil Metrics handles from both Install calls")
	}

	// Both handles share the registry; collectors registered once.
	body := scrapeMetrics(t, m2)
	count := strings.Count(body, "# HELP simsys_build_info ")
	if count != 1 {
		t.Errorf("expected exactly one simsys_build_info HELP line, got %d:\n%s", count, body)
	}

	// Build-info gauge must still report value 1 with the right labels.
	if !strings.Contains(body, `service="idem-test"`) {
		t.Errorf("expected service=\"idem-test\" in metrics body:\n%s", body)
	}
}

// TestInstallIdempotentProcCollectorReused asserts that the simsysProcessCollector
// is correctly preserved across repeat Install calls on the same Registry —
// the second call must NOT orphan a freshly-built collector and the
// simsys_process_* metrics must continue to scrape after the second Install.
//
// Regression test for the v0.3.1 procCollector orphan: the previous
// implementation absorbed AlreadyRegisteredError but discarded
// alreadyErr.ExistingCollector, leaving the second-call collector
// unreachable on the heap. The v0.3.2 fix routes registration through the
// generic registerOrExisting helper.
func TestInstallIdempotentProcCollectorReused(t *testing.T) {
	reg := prometheus.NewRegistry()
	opts := InstallOpts{
		Service:  "proc-idem",
		Version:  "0.0.0",
		Commit:   "abc",
		Registry: reg,
	}

	if _, err := Install(opts); err != nil {
		t.Fatalf("first Install: %v", err)
	}
	m2, err := Install(opts)
	if err != nil {
		t.Fatalf("second Install: %v", err)
	}

	body := scrapeMetrics(t, m2)

	// Exactly one simsys_process_cpu_seconds_total HELP line — the second
	// Install must not have registered a duplicate collector.
	cpuHelpCount := strings.Count(body, "# HELP simsys_process_cpu_seconds_total ")
	if cpuHelpCount != 1 {
		t.Errorf("expected exactly one simsys_process_cpu_seconds_total HELP line "+
			"after two Install calls on the same Registry, got %d:\n%s", cpuHelpCount, body)
	}

	// Process collector is still emitting samples — not orphaned.
	for _, want := range []string{
		`simsys_process_cpu_seconds_total{service="proc-idem"}`,
		`simsys_process_memory_bytes{service="proc-idem",type="rss"}`,
		`simsys_process_open_fds{service="proc-idem"}`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("expected %q in scraped /metrics body after re-Install:\n%s", want, body)
		}
	}
}
