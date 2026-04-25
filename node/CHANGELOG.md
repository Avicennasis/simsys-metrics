# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.7]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.7
[0.3.6]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.6
[0.3.5]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.5
[0.3.4]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.4
[0.3.3]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.3
[0.3.2]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.2
[0.3.1]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.1
[0.3.0]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.0
