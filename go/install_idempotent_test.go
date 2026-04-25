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
