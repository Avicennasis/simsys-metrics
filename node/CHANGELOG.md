# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] - 2026-04-25

### Documentation
- README install snippet bumped from `node-v0.3.3` to `node-v0.3.4`.

No code changes; version bump keeps the three sibling packages on a
matched semver line. See the [root CHANGELOG](../CHANGELOG.md) for the
v0.3.4 documentation cleanup that prompted this release.

## [0.3.3] - 2026-04-25

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

## [0.3.2] - 2026-04-25

### Documentation
- README install snippet bumped to the v0.3.2 tarball URL (was stale
  `node-v0.1.0`).

No code changes in the Node package; version bumped to keep the three
sibling packages on a matched semver line. See the
[root CHANGELOG](../CHANGELOG.md) for v0.3.2 fixes (Python-only).

## [0.3.1] - 2026-04-25

No code changes in the Node package — version bumped to keep all three
sibling packages on a matched semver line. See the
[root CHANGELOG](../CHANGELOG.md) for the v0.3.1 fixes (Python-only).

The Development section of `node/README.md` was rewritten to reference
the unified monorepo layout (was a stale pre-merge URL).

## [0.3.0] - 2026-04-25

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

[0.3.4]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.4
[0.3.3]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.3
[0.3.2]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.2
[0.3.1]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.1
[0.3.0]: https://github.com/Avicennasis/simsys-metrics/releases/tag/node-v0.3.0
