package simsysmetrics

import (
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// Unique service names across tests (collector registrations are global
// within the registry we create per-test, so this only matters when a
// test reuses a registry — defense-in-depth).
var testServiceCounter int64

func uniqueService(base string) string {
	n := atomic.AddInt64(&testServiceCounter, 1)
	return fmt.Sprintf("%s-%d", base, n)
}

// mustInstallForTest creates a fresh Metrics with a unique service label.
// Fails the test (not the goroutine) on install error.
func mustInstallForTest(t *testing.T, base string) *Metrics {
	t.Helper()
	m, err := Install(InstallOpts{
		Service: uniqueService(base),
		Version: "0.0.0-test",
		Commit:  "testcommit",
	})
	if err != nil {
		t.Fatalf("Install failed: %v", err)
	}
	return m
}

// scrapeMetrics fetches the exposition text via the Metrics handler.
func scrapeMetrics(t *testing.T, m *Metrics) string {
	t.Helper()
	srv := httptest.NewServer(m.MetricsHandler())
	defer srv.Close()
	resp, err := srv.Client().Get(srv.URL)
	if err != nil {
		t.Fatalf("scrape failed: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(body)
}

// hasLine returns true if body contains a non-comment line starting with name.
func hasLine(body, name string) bool {
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, name) {
			return true
		}
	}
	return false
}
