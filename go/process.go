package simsysmetrics

import (
	"sync"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/procfs"
)

// simsysProcessCollector emits simsys_process_* metrics by reading /proc/self.
// Mirrors the Python SimsysProcessCollector at simsys_metrics/_process.py.
// Non-Linux platforms return zeros (procfs.Self() fails gracefully on macOS).
type simsysProcessCollector struct {
	service string

	descCPU *prometheus.Desc
	descMem *prometheus.Desc
	descFDs *prometheus.Desc

	mu   sync.Mutex
	proc procfs.Proc
	ok   bool
}

func newSimsysProcessCollector(service string) *simsysProcessCollector {
	c := &simsysProcessCollector{
		service: service,
		descCPU: prometheus.NewDesc(
			"simsys_process_cpu_seconds_total",
			"Process CPU time (user + system) in seconds.",
			[]string{"service"}, nil,
		),
		descMem: prometheus.NewDesc(
			"simsys_process_memory_bytes",
			"Process memory in bytes; type=rss (resident) or vms (virtual).",
			[]string{"service", "type"}, nil,
		),
		descFDs: prometheus.NewDesc(
			"simsys_process_open_fds",
			"Number of open file descriptors.",
			[]string{"service"}, nil,
		),
	}
	if proc, err := procfs.Self(); err == nil {
		c.proc = proc
		c.ok = true
	}
	return c
}

func (c *simsysProcessCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.descCPU
	ch <- c.descMem
	ch <- c.descFDs
}

func (c *simsysProcessCollector) Collect(ch chan<- prometheus.Metric) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Default values for non-Linux or procfs failure. Keep the series
	// present so Grafana dashboards don't show "no data" for the whole row.
	var cpuSeconds, rssBytes, vmsBytes float64
	var openFDs float64

	if c.ok {
		if stat, err := c.proc.Stat(); err == nil {
			cpuSeconds = stat.CPUTime()
			// ResidentMemory() is in bytes (already multiplied by page size).
			rssBytes = float64(stat.ResidentMemory())
			vmsBytes = float64(stat.VirtualMemory())
		}
		if fds, err := c.proc.FileDescriptorsLen(); err == nil {
			openFDs = float64(fds)
		}
	}

	ch <- prometheus.MustNewConstMetric(c.descCPU, prometheus.CounterValue, cpuSeconds, c.service)
	ch <- prometheus.MustNewConstMetric(c.descMem, prometheus.GaugeValue, rssBytes, c.service, "rss")
	ch <- prometheus.MustNewConstMetric(c.descMem, prometheus.GaugeValue, vmsBytes, c.service, "vms")
	ch <- prometheus.MustNewConstMetric(c.descFDs, prometheus.GaugeValue, openFDs, c.service)
}
