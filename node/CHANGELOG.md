# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.10] — 2026-04-26

Patch release closing four Node-side findings from a v0.3.9 self-audit:

### Fixed
- **F8 / F11 — Service-swap no longer creates a Prometheus
  counter-reset artifact** (HIGH/MED). v0.3.9's swap path called
  `cpuTotal.reset()` (zeroing every labelset, observed by Prometheus
  as a counter reset) and zeroed `lastCpuSeconds` (making the next
  collect inc by full process-cumulative CPU — visible counter
  spike). Replaced with `metric.remove({service: priorService})`
  which drops ONLY the swapped-out labelset and leaves the live
  service's accumulator monotonic. `lastCpuSeconds` is now
  preserved so the new service's first collect inc by a small
  delta-since-prior-collect. The rollback path uses the same
  per-labelset remove for symmetry.
- **F9 — Hono `app.basePath()` now respected** (MED). Pre-fix, the
  metrics-path exemption compared `c.req.path === livePath` where
  `livePath` was the install-time `metricsPath` argument
  ("/metrics"). With `new Hono().basePath("/api")`, requests
  arrive at `/api/metrics` and the equality failed — `/metrics`
  scrapes were counted as instrumented requests. Fix reads
  `app._basePath` at install time and stores the absolute URL
  ("/api/metrics") in `appProps.simsysMetricsPath`; the runtime
  exemption check now matches Hono's actual routing.
- **F12 — Idempotency warning includes `metricsPath` mismatch**
  (LOW). Pre-fix, second-install with a different metricsPath but
  same service/version was a silent no-op (route is stuck at the
  first install's path). The warning now compares all three.

### Changed
- `registerProcessCollector(svc)` swap path now uses
  `metric.remove({service: priorService, ...})` instead of
  `metric.reset()`. No counter-reset artifact in Prometheus.
- `installHono(app, opts)` now reads `app._basePath` (Hono
  internal) at install time and stores the absolute metrics URL.
  No API change for callers — the published interface is
  unchanged.

### Tests
- 4 new vitest cases in `tests/install-self-audit-v0310.test.ts`
  (F8/F11 counter monotonicity across swap, F9 basePath
  exemption, F12 metricsPath-mismatch warning, F12
  silent-when-all-match).

## [0.3.9] — 2026-04-26

Patch release closing four Node-side findings from a follow-up Codex
audit (one MED/HIGH, three MED). All four regressed pre-fix on Codex's
exact reproductions; v0.3.9 ships regression coverage for each in
`tests/install-codex-findings.test.ts`.

### Fixed
- **F1 — Hono partial install double-stacks middleware on retry**
  (MED/HIGH). Pre-fix, when `app.get(metricsPath, ...)` threw during
  install, rollback cleared app props but left the wildcard middleware
  (`app.use("*", ...)`) wired. A retry then added a SECOND middleware
  on top, so every subsequent request was counted twice (Codex repro:
  `simsys_http_requests_total{route="/hello"} = 2` after fail-then-retry).
  Hono offers no public API to remove a previously-registered route or
  middleware, so the fix wires both AT MOST ONCE per app and gates them
  on the live `simsysMetricsInstalled` flag. A failed install leaves
  the wiring in place but INERT — the recording middleware short-
  circuits and the `/metrics` route returns 404 — until a retry sets
  `simsysMetricsInstalled = true` again. Handlers also read service /
  metrics-path from `appProps` at request time, so a retry with
  same-shape values (the only retry case the idempotent guard
  permits) re-arms cleanly without stale closure references.
- **F2 — Express 5 rollback snapshots the wrong router stack** (MED).
  Express 5 exposes the router at `app.router`, not `app._router`.
  Pre-fix snapshot read `app._router?.stack?.length` (always undefined
  in Express 5) so rollback no-opped — leaving a `/metrics` route layer
  in the stack on failure. Codex repro: stack `["/metrics"]` after
  fail, `["/metrics", "/metrics", "mw"]` after retry. Fix prefers
  `app.router.stack` and falls back to `app._router.stack` so both
  Express 4 (lazy `_router`) and Express 5 (`router`) truncate cleanly.
- **F3 — `build_info` rollback could delete a pre-existing sample it
  did not own** (MED). `started_at` is second-precision, so two
  installs of the same `service+version+commit` started in the same
  wall-clock second produce identical labelsets. Pre-fix, install B's
  rollback unconditionally called `buildInfo.remove(labels)` and
  silently deleted install A's still-live sample. Fix: new
  `registerBuildInfo(labels)` helper returns `{labels, wasNew}` tracked
  via a module-scoped ownership set; rollback uses
  `unregisterBuildInfoIfOwned(labels, wasNew)` which is a no-op when
  `wasNew = false`.
- **F4 — Process-collector rollback did not restore the prior
  service** (MED). Pre-fix, `registerProcessCollector(svc)` mutated
  the static `service` global in place during a swap; adapter rollback
  only restored the baseline `_SERVICE` global, leaving the process
  collector tagging samples with the failed install's service. Fix:
  `registerProcessCollector` now returns a `ProcessCollectorRollbackState`
  capturing the action (`reused` / `registered` / `service-swap`) plus
  the prior service label; rollback's new `restoreProcessCollector(state)`
  flips the label back. The swap path also `.reset()`s every collector
  metric so the swapped-out service's stale gauge samples don't linger
  between scrapes — prom-client otherwise retains per-labelset entries
  indefinitely after the labels stop being written.

### Changed
- `registerProcessCollector(svc)` now returns
  `ProcessCollectorRollbackState` (was `void`). Adapter install code
  pairs it with the new `restoreProcessCollector(state)` to undo
  cleanly on partial install.
- New helpers: `registerBuildInfo(labels)`,
  `unregisterBuildInfoIfOwned(labels, wasNew)`,
  `_resetBuildInfoOwnershipForTests()` exported from `buildinfo.ts`.

### Tests
- 4 new vitest cases in `tests/install-codex-findings.test.ts`
  reproducing each Codex finding pre-fix, then verifying the fix.
- All 38 tests pass; `tsc` clean; `npm pack --dry-run` 43 files;
  `npm audit --omit=dev --audit-level=moderate` zero vulns.

## [0.3.8] — 2026-04-25

### Fixed
- **install() partial-failure rollback** (MED). Pre-fix, the sentinel
  `app.locals.simsysMetricsInstalled` (Express) /
  `app.simsysMetricsInstalled` (Hono) was set BEFORE the framework
  wiring (`app.get(metricsPath, ...)`, `app.use(...)`). If any of
  those threw, the sentinel stayed `true` and a retry no-op'd via
  the idempotent guard — leaving `/metrics` and the HTTP middleware
  unwired. The sentinel is now set LAST, inside a try/catch that
  also drops the `simsys_build_info` label-set, restores the
  pre-install service global, and clears the discovery
  attributes (`simsysExemptPaths` / `simsysService` /
  `simsysVersion`) on failure. Backed by
  `node/tests/install-partial-failure.test.ts` (Express + Hono).

## [0.3.7] — 2026-04-25

### Fixed
- **`trackProgress` rejects NaN / Infinity / -Infinity intervals**
  (MED). The previous `intervalMs <= 0` check let `NaN` through
  vacuously, and `setInterval(fn, Infinity)` was clamped by Node to
  a 1ms hot loop with `TimeoutOverflowWarning`. Both windowMs and
  intervalMs now use `Number.isFinite` checks.

### Changed
- `makeCounter` / `makeGauge` / `makeHistogram` now `console.warn`
  (don't throw) at registration time when `'service'` is missing
  from `labelNames`. Once-per-metric-name. Custom metrics without a
  `service` label can't participate in cross-service `$service`
  Grafana dashboards; the warning makes the omission visible
  instead of letting the metric silently break the contract.
  Backed by `node/tests/registry-service-warning.test.ts`.

## [0.3.6] — 2026-04-25

### Fixed
- **HTTP method label allow-list** (HIGH). `req.method` (Express) and
  `c.req.method` (Hono) were passed straight into the
  `simsys_http_requests_total` label, so a hostile client sending
  arbitrary methods (`X_AUDIT_1`, `BREW`, `MKCALENDAR`, …) forced one
  new series per distinct value. Both adapters now run the method
  through `normalizeMethod()` which collapses anything outside the RFC
  9110 + PATCH allow-list to `"OTHER"`. Backed by
  `node/tests/method-normalization.test.ts`.
- **`trackQueue` rejects non-positive `intervalMs`** (MED). Pre-fix,
  `intervalMs: 0` created a hot `setInterval` loop that pegged the
  event loop. Now throws at call time with a clear error.

### Changed
- Auth-exempt path set returned by `app.locals.simsysExemptPaths`
  (Express) / `app.simsysExemptPaths` (Hono) now includes the
  user-supplied `metricsPath` — previously the static set with
  `/metrics` was always returned regardless of what `install()` was
  called with.

## [0.3.5] — 2026-04-25

### Fixed
- **CPU counter concurrent-scrape race.** prom-client's `Registry.metrics()`
  walks collectors via `Promise.all` with no per-registry mutex, so two
  concurrent /metrics scrapes (e.g. Prometheus + a sidecar push monitor)
  could both observe the same `lastCpuSeconds` value and inc the
  counter by ~2× the actual CPU delta. The cpu collect callback now
  serializes via a module-scoped `cpuCollectMutex: Promise<void>` chain
  so only one read-update-inc sequence runs at a time. Backed by
  `node/tests/cpu-counter-race.test.ts` (16 parallel scrapes assert
  monotonic + bounded counter values).

### Documentation
- README install snippet bumped from `node-v0.3.4` to `node-v0.3.5`.
- README metric catalogue now lists the four `simsys_progress_*` rows
  (was missing despite being defined in code).
- README gained a "Cross-runtime caveat" section explaining that
  `simsys_process_memory_bytes.type` label values are runtime-specific
  (`rss`/`heapUsed`/`heapTotal`/`external` in Node vs `rss`/`vms` in
  Python/Go). The `rss` value is the only common label across all
  three sibling packages.
- CHANGELOG heading separators standardized on em-dash to match the
  root file (was hyphen).

## [0.3.4] — 2026-04-25

### Documentation
- README install snippet bumped from `node-v0.3.3` to `node-v0.3.4`.

No code changes; version bump keeps the three sibling packages on a
matched semver line. See the [root CHANGELOG](../CHANGELOG.md) for the
v0.3.4 documentation cleanup that prompted this release.

## [0.3.3] — 2026-04-25

### Fixed
- **`install()` is now idempotent.** A second call on the same Express
  or Hono app previously added a SECOND middleware AND a SECOND
  `/metrics` route, causing every request to be counted twice on the
  second-install (and N+1 times on the Nth install). The new behaviour
  matches the Python and Go siblings: a sentinel on `app.locals`
  (Express) / app instance (Hono) short-circuits subsequent calls,
  with a `console.warn` when service/version differs from the
  original. Backed by `node/tests/install-idempotent.test.ts`.

### Tooling
- New CI workflow `.github/workflows/test-node.yml` runs `npm ci +
  build + vitest + npm pack --dry-run` on Node 20 / 22 / 24 (vitest@4
  requires Node ≥ 20). A separate `build-node18` job verifies the
  TypeScript build still succeeds on the declared `engines: node>=18`
  floor.

### Packaging
- `node/LICENSE` is now a real file (was previously listed in
  `package.json#files` but missing from the directory, so it was
  silently dropped from the published tarball).
- `node/package-lock.json` regenerated; was stuck reporting
  `version: 0.1.0` despite `package.json` having advanced through
  several releases. `npm ci` now succeeds against the lockfile.
- README install snippet bumped to `node-v0.3.3` tarball URL.

## [0.3.2] — 2026-04-25

### Documentation
- README install snippet bumped to the v0.3.2 tarball URL (was stale
  `node-v0.1.0`).

No code changes in the Node package; version bumped to keep the three
sibling packages on a matched semver line. See the
[root CHANGELOG](../CHANGELOG.md) for v0.3.2 fixes (Python-only).

## [0.3.1] — 2026-04-25

No code changes in the Node package — version bumped to keep all three
sibling packages on a matched semver line. See the
[root CHANGELOG](../CHANGELOG.md) for the v0.3.1 fixes (Python-only).

The Development section of `node/README.md` was rewritten to reference
the unified monorepo layout (was a stale pre-merge URL).

## [0.3.0] — 2026-04-25

First public release of the Node sibling package. See the
[root CHANGELOG](../CHANGELOG.md) for the full feature set; Node-specific
notes:

- Express 5 + Hono 4 adapters share a single metric catalogue.
- `process.cpuUsage()` is exposed as a monotonic counter using delta-based
  increments — preserves prom-client's reset-detection (no reset()+inc()
  pattern that would break `rate()` over scrape boundaries).
- Hono adapter detects the wildcard middleware path (`/*`) as unmatched so
  unrouted requests collapse to `route="__unmatched__"` rather than leaking
  the wildcard pattern.
- ESM-only, requires Node ≥ 18 (declared via `engines`).
- Tarball distribution via GitHub Releases; install URL is the
  `simsys-metrics-0.3.0.tgz` asset attached to the `node-v0.3.0` release.

[0.3.8]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.8
[0.3.7]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.7
[0.3.6]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.6
[0.3.5]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.5
[0.3.4]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.4
[0.3.3]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.3
[0.3.2]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.2
[0.3.1]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.1
[0.3.0]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.0
