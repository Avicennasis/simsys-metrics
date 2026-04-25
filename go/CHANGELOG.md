# Changelog

All notable changes to `simsys-metrics-go` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [go/v0.2.5] — 2026-04-25

### Documentation
- `Middleware` godoc gained a note covering the hijack-then-panic edge
  case: a handler that calls `http.NewResponseController(w).Hijack()`
  and then panics still records `status="5xx"` correctly, but the
  re-panic propagates to a connection that is no longer http-managed —
  net/http closes the underlying socket without writing a 500 body.
  Correct behavior for mid-upgrade websockets; documented so it
  doesn't surprise consumers.
- README install snippet bumped from `v0.2.4` to `v0.2.5`.
- README gained a "Cross-runtime caveat" section explaining the
  `simsys_process_memory_bytes.type` label-value divergence between
  Python+Go (`rss`/`vms`) and Node
  (`rss`/`heapUsed`/`heapTotal`/`external`).
- CHANGELOG heading separators standardized on em-dash to match the
  root file (was hyphen).

## [go/v0.2.4] — 2026-04-25

### Documentation
- README install snippet bumped from `go/v0.2.0` to `v0.2.4`. Added a
  note clarifying that the `go get` version arg drops the `go/` tag
  prefix (the module path already ends in `/go`, so the Go module
  resolver expects `@v0.2.4` not `@go/v0.2.4`).

No code changes.

## [go/v0.2.3] — 2026-04-25

### Fixed
- **Handler panics are now correctly recorded as 5xx.** Previously, if
  a handler panicked before calling `WriteHeader`, the `statusRecorder`
  default of `http.StatusOK` (200) was emitted as the metric label,
  the panic bypassed the deferred labeller, and the request was
  counted as a successful 2xx. The middleware now `recover()`s the
  panic, sets `wrapped.status` to `500` if no status was written,
  emits the metric with `status="5xx"`, and re-panics so net/http's
  default recovery (log + close connection) still runs. If the
  handler had already written an explicit status (e.g. 400) before
  panicking, that status is preserved. Backed by
  `go/middleware_panic_test.go`.
- Refactored shared labelling logic into `recordRequest()` so the
  happy path and the panic-recovery path can't drift apart.

## [go/v0.2.2] — 2026-04-25

### Added
- Test coverage: `TestInstallIdempotentProcCollectorReused` directly
  asserts that the simsysProcessCollector survives a second `Install`
  with the same Registry and continues to emit `simsys_process_*` on
  scrape — closing a coverage gap from v0.2.1's orphan fix.

### Documentation
- `Install` godoc now explicitly warns that re-Install with a different
  `Service` on the same Registry produces inconsistent labels (the
  build_info gauge gets the new Service value, but the existing
  collectors keep emitting the original one). Use one Service per
  Registry; allocate a fresh Registry to legitimately re-init under a
  new identity.

## [go/v0.2.1] — 2026-04-25

### Fixed
- **`Install()` no longer orphans a process collector on second call.**
  When the same `*prometheus.Registry` was passed to `Install` twice, the
  second-call `simsysProcessCollector` was built but its registration
  silently absorbed an `AlreadyRegisteredError` and the freshly-built
  collector was never wired up — leaving an unreferenced object on the
  heap. Now routed through the same `registerOrExisting` generic helper
  used by `MakeCounter`/`MakeGauge`/`MakeHistogram`, so the existing
  registered collector is reused. No user-visible behaviour change for
  first-call installs.

## [go/v0.2.0] — 2026-04-25

First public release of the Go sibling package. See the
[root CHANGELOG](../CHANGELOG.md) for the full feature set; Go-specific
notes:

- `Install(InstallOpts)` returns `*Metrics` with a private
  `*prometheus.Registry` to avoid default-registry collisions, and is
  idempotent on repeated calls with the same Registry.
- Middleware preserves `http.Hijacker`, `http.Pusher`, and `http.Flusher`
  via `Unwrap()` so handlers can call `http.NewResponseController(w)` after
  the metric wrapper. Required for websocket upgrades, HTTP/2 server push,
  and SSE flushing.
- Adapter entry points: `MetricsHandler()` for `/metrics`,
  `Middleware(MiddlewareOpts)` with a `RouteExtractor` callback for
  bounded-cardinality request instrumentation. When the extractor returns
  an empty string (or no extractor is supplied), the route label is the
  literal `UnmatchedRouteLabel` (`"__unmatched__"`) — scanner traffic
  cannot blow out cardinality.
- Goroutine-leak safety: `TrackQueue` and `TrackProgress` accept
  `context.Context` for cancellation and return idempotent stop funcs.
  Enforced in tests via `go.uber.org/goleak` in `TestMain`.
- `TrackQueue` panic recovery: a `depthFn` panic logs the first occurrence
  via `slog` and silently absorbs subsequent panics to avoid log floods.

[go/v0.2.5]: https://github.com/Avicennasis/simsys-metrics/releases/tag/go/v0.2.5
[go/v0.2.4]: https://github.com/Avicennasis/simsys-metrics/releases/tag/go/v0.2.4
[go/v0.2.3]: https://github.com/Avicennasis/simsys-metrics/releases/tag/go/v0.2.3
[go/v0.2.2]: https://github.com/Avicennasis/simsys-metrics/releases/tag/go/v0.2.2
[go/v0.2.1]: https://github.com/Avicennasis/simsys-metrics/releases/tag/go/v0.2.1
[go/v0.2.0]: https://github.com/Avicennasis/simsys-metrics/releases/tag/go/v0.2.0
