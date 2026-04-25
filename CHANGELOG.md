# Changelog

All notable changes to `simsys-metrics` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.6] — 2026-04-25

Patch release closing six findings from a follow-up Codex audit (two
HIGH, three MEDIUM, one LOW).

### Fixed
- **HTTP method label is now bounded** (HIGH). Pre-fix, the raw
  `request.method` string was passed straight through, so a hostile
  client sending arbitrary methods (`X_AUDIT_1`, `ASDF`, etc.) forced
  one new `simsys_http_requests_total` series per distinct value —
  defeating the package's stated cardinality discipline. Both FastAPI
  and Flask now route the method through `normalize_method()` which
  returns the upper-cased value if it's in the RFC 9110 + PATCH
  allow-list, else `"OTHER"`. Backed by
  `tests/test_method_normalization.py` (FastAPI + Flask end-to-end).
- **`install()` rollback now covers the full framework-wiring phase**
  (HIGH). Pre-fix the try/except only wrapped the registry/build-info
  setup, so a late install (after the app started serving) where
  FastAPI's `app.add_middleware` or Flask's `before_request` /
  `add_url_rule` raised would leave the sentinel set without metrics
  actually wired — and the idempotent guard would silently swallow
  every retry. The framework wiring is now inside the protected block;
  failures roll back the sentinel cleanly. Backed by two new
  regression tests using `monkeypatch` to force late-install errors.
- **Custom `metrics_path` now appears in the exempt-paths set** (MED).
  When a user passed `metrics_path="/internal/metrics"`, the exposed
  set (`app.state.simsys_exempt_paths` / `app.extensions[...]`) still
  said `/metrics`, so auth middleware reading it would still
  auth-block the actual scrape route. The set is now built per-install
  to include the user's path.
- **`track_queue` now rejects non-positive intervals** (MED). Pre-fix,
  `interval=0` would create a busy-loop in an unstoppable daemon
  thread (the daemon dies with the interpreter, but burns CPU until
  then). Raises `ValueError` at call time instead.

### Documentation
- Multiprocess mode README section now clearly marks itself as
  **FastAPI only** and documents that Flask under gunicorn does NOT
  have automatic multiproc handling — the previous wording implied
  framework parity. Native Flask multiproc support is tracked for a
  future minor release.

## [0.3.5] — 2026-04-25

Patch release addressing nine findings from a follow-up audit (four
≥80-confidence + five below-threshold once validated).

### Fixed
- **`track_job` async detection now handles `functools.partial` and
  callable instances.** v0.3.3 used `asyncio.iscoroutinefunction` which
  is also being deprecated in 3.12. Switched to
  `inspect.iscoroutinefunction` (which correctly detects partial-wrapped
  coroutines via `__wrapped__`), plus a fall-through that inspects
  `__call__` for callable-instance wrappers (those return False from the
  top-level check). Backed by two regression tests in
  `tests/test_track_job.py`: partial-wrapped async raising → `error=1`,
  async-callable instance raising → `error=1`.
- **Removed dead `_QUEUE_THREADS` module-level list.** Every
  `track_queue()` call appended to it; the list was only ever read by
  `_reset_for_tests()` for `clear()`. Unbounded leak source for apps
  that re-init queue trackers in factories. Daemon threads continue to
  die with the interpreter as before — no behavioural change.
- **Removed dead `Optional[Response] = None`** in the FastAPI
  middleware dispatch — the variable was assigned but never read after
  the `try` block.

### Added
- `tests/test_fastapi_install_multiproc.py` now drives a real
  `/items/{id}` route through the BaseHTTPMiddleware under multiproc
  mode and asserts `simsys_http_requests_total` records the dispatch.
  Closes a coverage gap from v0.3.3.

### Documentation
- Added a "Cross-runtime caveat" section to all three READMEs
  (`README.md`, `node/README.md`, `go/README.md`) documenting that
  `simsys_process_memory_bytes.type` label values are intentionally
  runtime-specific (Python+Go: `rss`/`vms`; Node:
  `rss`/`heapUsed`/`heapTotal`/`external`). A `$service`-templated
  dashboard panel filtering `type="vms"` will return empty for Node
  services. The `rss` value is the only label-value common to all
  three runtimes.
- `node/README.md` metric catalogue now lists the four
  `simsys_progress_*` rows (was missing despite being defined in code).
- `node/CHANGELOG.md` and `go/CHANGELOG.md` heading-separator
  standardised on em-dash to match the root file (was hyphen).

## [0.3.4] — 2026-04-25

Documentation-only release. No code changes.

### Documentation
- Root `README.md` now describes the monorepo as **three** packages
  (Python + Node + Go), with a Go badge and a Go row in the layout
  table. Previously read "two packages" with no Go mention.
- Python install snippets in `README.md` bumped from the stale `v0.3.0`
  pin to the current `v0.3.4` (was missing every fix from v0.3.1
  through v0.3.3 — install idempotency, async track_job, partial-
  failure rollback, etc.).
- `go/README.md` install snippet bumped from `go/v0.2.0` to `v0.2.4`,
  and a note added clarifying the `go get` version-arg syntax (drops
  the `go/` tag prefix because the module path already ends in `/go`).

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

[0.3.6]: https://github.com/Avicennasis/simsys-metrics/releases/tag/v0.3.6
[0.3.5]: https://github.com/Avicennasis/simsys-metrics/releases/tag/v0.3.5
[0.3.4]: https://github.com/Avicennasis/simsys-metrics/releases/tag/v0.3.4
[0.3.3]: https://github.com/Avicennasis/simsys-metrics/releases/tag/v0.3.3
[0.3.2]: https://github.com/Avicennasis/simsys-metrics/releases/tag/v0.3.2
[0.3.1]: https://github.com/Avicennasis/simsys-metrics/releases/tag/v0.3.1
[0.3.0]: https://github.com/Avicennasis/simsys-metrics/releases/tag/v0.3.0
