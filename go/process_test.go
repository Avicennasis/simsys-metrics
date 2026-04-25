package simsysmetrics

import (
	"strings"
	"testing"
)

func TestSimsysProcessCollectorEmitsBaseline(t *testing.T) {
	m := mustInstallForTest(t, "proc")
	body := scrapeMetrics(t, m)

	for _, required := range []string{
		"simsys_process_cpu_seconds_total",
		`simsys_process_memory_bytes{service=`,
		`type="rss"`,
		`type="vms"`,
		"simsys_process_open_fds",
	} {
		if !strings.Contains(body, required) {
			t.Errorf("missing %q in /metrics body:\n%s", required, body)
		}
	}
}
