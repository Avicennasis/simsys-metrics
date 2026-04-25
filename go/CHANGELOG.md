# Changelog

All notable changes to `simsys-metrics-go` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [go/v0.2.1] - 2026-04-25

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

## [go/v0.2.0] - 2026-04-25

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

[go/v0.2.1]: https://github.com/Avicennasis/simsys-metrics/releases/tag/go/v0.2.1
[go/v0.2.0]: https://github.com/Avicennasis/simsys-metrics/releases/tag/go/v0.2.0
