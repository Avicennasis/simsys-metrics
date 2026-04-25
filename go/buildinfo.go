package simsysmetrics

import (
	"context"
	"os"
	"os/exec"
	"runtime/debug"
	"strings"
	"time"
)

// detectCommit resolves the simsys_build_info.commit label.
// Fallback order:
//  1. SIMSYS_BUILD_COMMIT env var (for container builds — authoritative)
//  2. runtime/debug ReadBuildInfo() vcs.revision setting (populated when
//     `go build` runs inside a git tree — works in distroless images
//     without a git binary on PATH)
//  3. `git rev-parse --short HEAD` (2s timeout)
//  4. literal "unknown"
func detectCommit() string {
	if env := strings.TrimSpace(os.Getenv("SIMSYS_BUILD_COMMIT")); env != "" {
		return env
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		var revision string
		var modified bool
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				revision = s.Value
			case "vcs.modified":
				modified = s.Value == "true"
			}
		}
		if revision != "" {
			short := revision
			if len(short) > 7 {
				short = short[:7]
			}
			if modified {
				short += "-dirty"
			}
			return short
		}
	}

	// Last-resort git shell-out with a tight timeout. Works when running
	// tests or `go run` inside a git checkout.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "rev-parse", "--short", "HEAD").Output()
	if err == nil {
		if s := strings.TrimSpace(string(out)); s != "" {
			return s
		}
	}
	return "unknown"
}
