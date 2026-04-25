package simsysmetrics

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestTrackJobSuccess(t *testing.T) {
	m := mustInstallForTest(t, "job-success")
	done := m.TrackJob("process")
	time.Sleep(5 * time.Millisecond)
	done()

	body := scrapeMetrics(t, m)
	if !strings.Contains(body, `simsys_jobs_total{job="process"`) {
		t.Fatalf("jobs_total missing; body:\n%s", body)
	}
	if !strings.Contains(body, `outcome="success"`) {
		t.Fatalf("expected outcome=success; body:\n%s", body)
	}
}

func TestTrackJobSpanRecordsError(t *testing.T) {
	m := mustInstallForTest(t, "job-error")
	finish := m.TrackJobSpan("risky")
	finish(errors.New("boom"))

	body := scrapeMetrics(t, m)
	if !strings.Contains(body, `outcome="error"`) {
		t.Fatalf("expected outcome=error; body:\n%s", body)
	}
}

func TestTrackJobSpanIsOnce(t *testing.T) {
	m := mustInstallForTest(t, "job-once")
	finish := m.TrackJobSpan("idempotent")
	finish(nil) // success
	finish(errors.New("late error — must be ignored"))

	body := scrapeMetrics(t, m)
	// Only the first call records; we expect outcome=success exactly once.
	if !strings.Contains(body, `outcome="success"`) {
		t.Fatalf("expected outcome=success; body:\n%s", body)
	}
	if strings.Contains(body, `outcome="error"`) {
		t.Fatalf("second finish() must not record an error; body:\n%s", body)
	}
}

func TestTrackQueueUpdatesGauge(t *testing.T) {
	m := mustInstallForTest(t, "queue-updates")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var depth atomic.Int64
	stop := m.TrackQueue(ctx, "inference", 20*time.Millisecond, func() int { return int(depth.Load()) })
	defer stop()

	// First tick fires synchronously — gauge should be 0 initially.
	time.Sleep(40 * time.Millisecond)
	depth.Store(42)
	// Wait for the ticker to pick it up.
	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		body := scrapeMetrics(t, m)
		if strings.Contains(body, `simsys_queue_depth{queue="inference"`) &&
			strings.Contains(body, "} 42") {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("queue_depth never reached 42; body:\n%s", scrapeMetrics(t, m))
}

func TestTrackQueueStopIsIdempotent(t *testing.T) {
	m := mustInstallForTest(t, "queue-stop")
	stop := m.TrackQueue(context.Background(), "x", 100*time.Millisecond, func() int { return 0 })
	stop()
	stop() // must not deadlock / panic
}

func TestTrackQueueCtxCancelStopsGoroutine(t *testing.T) {
	m := mustInstallForTest(t, "queue-ctx")
	ctx, cancel := context.WithCancel(context.Background())
	stop := m.TrackQueue(ctx, "x", 30*time.Millisecond, func() int { return 0 })
	defer stop()
	cancel()
	// Give the goroutine time to wake and exit.
	time.Sleep(80 * time.Millisecond)
	// If the goroutine leaked, goleak in TestMain will flag it.
}
