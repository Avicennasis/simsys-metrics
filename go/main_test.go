package simsysmetrics

import (
	"testing"

	"go.uber.org/goleak"
)

// TestMain wraps the test binary with goleak — any goroutine leaked by
// TrackQueue / TrackProgress that isn't cleaned up via Stop() or ctx
// cancellation will fail the suite.
func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m)
}
