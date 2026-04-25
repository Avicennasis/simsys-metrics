package simsysmetrics

import (
	"os"
	"testing"
)

func TestDetectCommitEnvWins(t *testing.T) {
	t.Setenv("SIMSYS_BUILD_COMMIT", "fromenv")
	if got := detectCommit(); got != "fromenv" {
		t.Errorf("detectCommit = %q; want fromenv", got)
	}
}

func TestDetectCommitTrimsEnv(t *testing.T) {
	t.Setenv("SIMSYS_BUILD_COMMIT", "  abcd123  ")
	if got := detectCommit(); got != "abcd123" {
		t.Errorf("detectCommit = %q; want abcd123", got)
	}
}

func TestDetectCommitFallsBack(t *testing.T) {
	// Explicitly unset the env var. What we get depends on whether the test
	// binary has vcs.revision embedded (go test typically embeds it when
	// the working dir is a git tree). Either way we must NOT get "" —
	// the contract is to return a non-empty string.
	_ = os.Unsetenv("SIMSYS_BUILD_COMMIT")
	got := detectCommit()
	if got == "" {
		t.Fatalf("detectCommit returned empty string")
	}
}
