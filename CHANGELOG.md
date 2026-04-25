# Changelog

All notable changes to `simsys-metrics` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-04-25

First public release.

### Added
- **Python package** (`simsys-metrics`) — FastAPI and Flask install paths.
  - `install()` auto-detects framework, mounts `/metrics`, registers HTTP
    request count + duration, process CPU/memory/FDs, and `simsys_build_info`.
  - Opt-in helpers: `track_queue` (poller thread + gauge), `track_job`
    (decorator + context manager), `track_progress` (batch progress with EWMA
    rate + ETA gauges).
  - Prefix-guarded registry: every metric name must start with `simsys_`.
  - Cardinality discipline: route templates only, status-class bucketing
    (`2xx` / `3xx` / …), `safe_label()` allow-list helper.
  - Multiprocess mode: when `PROMETHEUS_MULTIPROC_DIR` is set, `/metrics`
    aggregates samples from every process via `MultiProcessCollector`.
- **Node package** (`@simsys/metrics`) — Express 5 + Hono (Bun/Node) adapters.
  Same metric catalogue and label conventions as Python; ESM-only,
  TypeScript types included, requires Node ≥ 18.
- **Go package** (`github.com/Avicennasis/simsys-metrics/go`) — net/http
  middleware. Same catalogue, prefix-guarded registry, idiomatic
  `*Metrics` handle.
- Unmatched routes (404 / scanner traffic) collapse to one
  `route="__unmatched__"` bucket so they cannot blow out cardinality.
- `install()` / `Install()` are idempotent: a second call on the same app
  is a no-op rather than doubling middleware or panicking on duplicate
  metric registrations.
- Go middleware preserves `http.Hijacker` / `http.Pusher` / `http.Flusher`
  via `Unwrap()` and `http.NewResponseController`, supporting websocket
  upgrades and HTTP/2 server push.

### Tooling
- CI: pytest matrix on Python 3.10–3.13; vitest on Node; `go test -race`
  on Go 1.23 + 1.24; staticcheck pinned to a tagged release.
- Dependabot covers `pip`, `npm`, `gomod`, and `github-actions`.
- pre-commit with ruff (lint + format).
- OpenSSF Scorecard, build provenance attestation on Go releases.

[0.3.0]: https://github.com/Avicennasis/simsys-metrics/releases/tag/v0.3.0
