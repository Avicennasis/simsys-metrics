# Changelog

All notable changes to `simsys-metrics` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] — 2026-04-25

Patch release addressing findings from a follow-up audit.

### Fixed
- **`@track_job` now correctly times async functions.** The previous
  decorator wrapped only sync callables: passing an async function
  worked at the type level but exited the timing span as soon as the
  coroutine OBJECT was returned (before it ran). Async exceptions were
  silently misrecorded as `outcome="success"`. The decorator now
  detects coroutine functions via `asyncio.iscoroutinefunction` and
  emits an async-aware wrapper that awaits the coroutine inside the
  span. Backed by `tests/test_track_job.py` (success + error cases).
- **FastAPI middleware migrated from function-style decorator to
  `BaseHTTPMiddleware`.** `@app.middleware("http")` is brittle under
  recent Starlette versions (0.51+) — the `TestClient` can deadlock
  on the call_next path. Switched to a `BaseHTTPMiddleware` subclass
  registered via `app.add_middleware()`, the canonical and testable
  pattern. No behavior change for the happy path; metrics still
  carry the same labels.

### Hardening
- pytest suite now runs under `pytest-timeout` with a 30-second
  per-test cap (`addopts = --timeout=30`), so a future hang fails
  fast instead of holding CI indefinitely.
- `pytest-timeout>=2.3` added to the `[test]` extra in
  `pyproject.toml`.

## [0.3.2] — 2026-04-25

Patch release closing a regression in v0.3.1's install-sentinel ordering
and adding regression-test coverage for two paths that were previously
implicit.

### Fixed
- **`install()` no longer phantom-installs on partial failure.** v0.3.1
  moved the sentinel ahead of the side-effecting registration calls; if
  any of them raised (e.g. transient `subprocess.TimeoutExpired` in
  `git rev-parse`), the sentinel was left set and subsequent retry calls
  returned early — silently dropping the install. The sentinel is now
  rolled back inside an `except` block so a retry can proceed cleanly.
  Backed by `tests/test_install_partial_failure.py` (FastAPI + Flask).

### Added (test coverage only)
- `test_flask_unhandled_exception_count_is_exactly_one` — symmetry with
  the double-count test for the no-handler 5xx path.
- `test_flask_before_request_exception_records_5xx` — verifies the
  exception-from-`before_request` path still records the route + 5xx.
- `test_flask_before_request_failure_before_simsys_skips_histogram` —
  pins the contract that when a user's `before_request` runs (and fails)
  ahead of `_simsys_before`, the counter still increments but the
  histogram observe is skipped (no 0.0-bucket pollution).

### Documentation
- `go/metrics.go` — `Install` godoc now warns that re-Install with a
  different Service on the same Registry produces inconsistent labels
  (build_info gauge gets the new Service; everything else keeps the
  original).
- `node/README.md` — Install snippet bumped from the stale
  `node-v0.1.0` tarball URL to `node-v0.3.2`.

## [0.3.1] — 2026-04-25

Patch release tightening `install()` semantics and Flask error-path
observability based on a follow-up code review.

### Fixed
- **Flask: uncaught exceptions are now counted as 5xx.** Previously, an
  unhandled exception escaped Flask's `after_request` hook entirely and
  the request silently produced no metric sample at all — a real
  observability gap on the error path. Now wired through
  `got_request_exception` so the counter increments and the histogram
  observes once-and-only-once even on the exception path.
- **`install()` warns on service/version mismatch.** A second `install()`
  on the same app with different `service=` / `version=` arguments
  previously no-op'd silently. Now logs a clear warning and keeps the
  original install — apps that legitimately want re-init must drop the
  sentinel first.
- **`install()` sets the sentinel before side effects.** A partial first
  install (e.g. transient subprocess timeout in `git rev-parse`) no
  longer leaves the registry in a half-populated state that a retry
  would re-poison.

### Documentation
- README: new "Multiprocess mode" section. Documents the
  `PROMETHEUS_MULTIPROC_DIR` env-var ordering requirement (must be set
  before `simsys_metrics` is imported, not from inside an app factory).

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

[0.3.3]: https://github.com/Avicennasis/simsys-metrics/releases/tag/v0.3.3
[0.3.2]: https://github.com/Avicennasis/simsys-metrics/releases/tag/v0.3.2
[0.3.1]: https://github.com/Avicennasis/simsys-metrics/releases/tag/v0.3.1
[0.3.0]: https://github.com/Avicennasis/simsys-metrics/releases/tag/v0.3.0
