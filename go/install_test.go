package simsysmetrics

import (
	"errors"
	"strings"
	"testing"
)

func TestInstallRequiresServiceAndVersion(t *testing.T) {
	if _, err := Install(InstallOpts{}); !errors.Is(err, ErrInvalidInstallOpts) {
		t.Fatalf("want ErrInvalidInstallOpts, got %v", err)
	}
	if _, err := Install(InstallOpts{Service: "x"}); !errors.Is(err, ErrInvalidInstallOpts) {
		t.Fatalf("missing version: want ErrInvalidInstallOpts, got %v", err)
	}
	if _, err := Install(InstallOpts{Version: "1.0.0"}); !errors.Is(err, ErrInvalidInstallOpts) {
		t.Fatalf("missing service: want ErrInvalidInstallOpts, got %v", err)
	}
}

func TestInstallExposesBaselineOnMetricsHandler(t *testing.T) {
	m := mustInstallForTest(t, "install-baseline")
	body := scrapeMetrics(t, m)

	// prometheus/client_golang only emits HELP/TYPE + samples for metrics that
	// have at least one observed label set. Install sets build_info and the
	// process collector always emits, so those are what we can assert
	// unconditionally. HTTP/queue/job/progress HELP lines appear only after
	// their first observation — covered by their dedicated tests.
	required := []string{
		"simsys_build_info",
		"simsys_process_cpu_seconds_total",
		"simsys_process_memory_bytes",
		"simsys_process_open_fds",
	}
	for _, name := range required {
		if !strings.Contains(body, name) {
			t.Errorf("expected %q in /metrics body; got:\n%s", name, body)
		}
	}
}

func TestInstallBuildInfoCarriesLabels(t *testing.T) {
	m, err := Install(InstallOpts{
		Service: "build-info-test",
		Version: "1.2.3",
		Commit:  "deadbee",
	})
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	body := scrapeMetrics(t, m)
	for _, want := range []string{
		`service="build-info-test"`,
		`version="1.2.3"`,
		`commit="deadbee"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("simsys_build_info missing label %q; body:\n%s", want, body)
		}
	}
}

func TestInstallCommitFallbackDetects(t *testing.T) {
	m, err := Install(InstallOpts{
		Service: "commit-detect",
		Version: "1.0.0",
		// Commit left blank to exercise detectCommit fallback.
	})
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	body := scrapeMetrics(t, m)
	// Some commit label must be present (env, debug.ReadBuildInfo, git, or "unknown").
	if !strings.Contains(body, `commit="`) {
		t.Fatalf("no commit= label in build_info; body:\n%s", body)
	}
}
