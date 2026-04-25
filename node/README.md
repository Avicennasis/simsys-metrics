# @simsys/metrics

> A drop-in Prometheus `/metrics` template for Node.js web apps — the Node.js sibling of [`simsys-metrics`](../) (Python), shipped from the same repo. One `install()` call; consistent metric catalogue; zero-per-app dashboard work.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node 18+](https://img.shields.io/badge/node-18+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5-000000.svg?logo=express&logoColor=white)](https://expressjs.com/)
[![Hono](https://img.shields.io/badge/Hono-4-E36002.svg?logo=hono&logoColor=white)](https://hono.dev/)

---

A drop-in Prometheus instrumentation layer for Node.js web apps — the
same metric catalogue and `service`-label conventions as the sibling
Python and Go packages, so a single generic Grafana dashboard works
across runtimes.

- **Supported stacks:** Express 5 on Node, Hono 4 on Bun.
- **Baseline metrics** (zero extra code): HTTP request count + latency,
  process CPU / RSS / uptime / open FDs, build info, Node runtime defaults.
- **Opt-in helpers:** queue depth gauge, job counter + histogram.
- **Cardinality discipline** enforced: route templates, status classes, an
  allow-listed `safeLabel` helper. Every simsys metric name must start with
  `simsys_` — the registry refuses anything else.

## Table of contents

- [Install](#install)
- [Usage](#usage)
  - [Express 5](#express-5)
  - [Bun + Hono](#bun--hono)
  - [Queue depth](#queue-depth)
  - [Job timing](#job-timing)
  - [`safeLabel` — cardinality helper](#safelabel--cardinality-helper)
- [Metric catalogue](#metric-catalogue)
- [Cardinality rules](#cardinality-rules)
- [`commit` detection](#commit-detection)
- [`/metrics` endpoint behaviour](#metrics-endpoint-behaviour)
- [Development](#development)
- [License](#license)

## Install

The Node package ships as a tarball attached to each `node-v*` GitHub Release. Pin to a release in `package.json`:

```json
{
  "dependencies": {
    "@simsys/metrics": "https://github.com/Avicennasis/simsys-metrics/releases/download/node-v0.1.0/simsys-metrics-0.1.0.tgz"
  }
}
```

Why a tarball URL instead of `git+https://.../simsys-metrics.git`? npm's git-install doesn't support subdirectories, and the Node package lives at [`node/`](.) inside a shared monorepo with the Python package. The tarball URL is the standard way to install a subdirectory package from git hosting — it's the same mechanism npm uses internally.

### Releasing (maintainers)

```bash
cd node
npm ci
npm run build
npm pack                              # produces simsys-metrics-<version>.tgz
cd ..
git tag node-v<version>
git push origin node-v<version>
gh release create node-v<version> node/simsys-metrics-<version>.tgz \
  --title "@simsys/metrics <version>" \
  --notes-file node/CHANGELOG.md
```

No SSH agent or auth token required in Docker builds. Bumping a consumer means
re-pointing this URL at a newer tag.

## Usage

### Express 5

```ts
import express from "express";
import { install, trackJob, trackQueue } from "@simsys/metrics";

const app = express();
install(app, { service: "my-api", version: "1.2.3" });

app.get("/render/:id", (req, res) => {
  res.json({ id: req.params.id });
});

// Opt-in queue gauge (polled every 5 s):
trackQueue("render", { depthFn: () => jobQueue.length });

// Opt-in per-job timer:
const runRender = trackJob("render")(async (job) => {
  /* ... */
});

app.listen(8080);
```

### Bun + Hono

```ts
import { Hono } from "hono";
import { install, trackJob } from "@simsys/metrics";

const app = new Hono();
install(app, { service: "my-worker", version: "0.4.1" });

app.get("/items/:id", (c) => c.json({ id: c.req.param("id") }));

// Ad-hoc async span — no wrapping needed:
app.post("/render", async (c) => {
  const result = await trackJob("render").run(async () => {
    return await renderWidget(await c.req.json());
  });
  return c.json(result);
});

export default app;
// `bun run` this file — Bun serves `export default app` automatically.
```

`install()` auto-detects the framework via duck-typing (Express: `.handle()`
+ `.use()`; Hono: `.fetch()` + `.route()`). Pass `metricsPath: "/internal/metrics"`
to override the default `/metrics`.

### Queue depth

```ts
import { trackQueue } from "@simsys/metrics";

trackQueue("inference", {
  depthFn: () => queue.size(),   // called every 5 s
  intervalMs: 5000,              // optional, defaults to 5000
});
```

The `depthFn` can return a number or a `Promise<number>`. Failures are
swallowed (the gauge stays at its last successful value or 0).

### Job timing

Two shapes for `trackJob` — pick whichever fits the call site:

```ts
// 1. Function wrapper (works for sync or async):
const runInference = trackJob("inference")(async (input) => { /* ... */ });
await runInference(input);

// 2. Ad-hoc async span (no wrapping):
await trackJob("inference").run(async () => {
  // ...do the work...
});
```

Both emit `simsys_jobs_total` + `simsys_job_duration_seconds` with
`outcome="success"` or `outcome="error"` depending on whether the callable
threw.

### `safeLabel` — cardinality helper

Coerce any user-facing label value into a bounded allow-list:

```ts
import { safeLabel } from "@simsys/metrics";

const ticker = safeLabel(req.query.ticker, new Set(["AAPL", "GOOG", "NVDA"]));
// -> "AAPL" if in the set, else "other"
```

Use this for anything an external caller controls (tickers, tenant names,
device IDs, free-form search terms) before it ends up as a Prometheus label.

## Metric catalogue

Every simsys metric uses the `simsys_` prefix and a `service` label, so
cross-service PromQL like `sum by (service) (rate(simsys_http_requests_total[5m]))`
works unmodified across every app.

| Metric | Type | Labels | Source |
|---|---|---|---|
| `simsys_http_requests_total` | Counter | `service, method, route, status` | baseline |
| `simsys_http_request_duration_seconds` | Histogram | `service, method, route` | baseline |
| `simsys_process_cpu_seconds_total` | Counter | `service` | baseline |
| `simsys_process_memory_bytes` | Gauge | `service, type` (`rss`, `heapUsed`, `heapTotal`, `external`) | baseline |
| `simsys_process_open_fds` | Gauge | `service` (Linux only; 0 elsewhere) | baseline |
| `simsys_process_uptime_seconds` | Gauge | `service` | baseline |
| `simsys_build_info` | Gauge = 1 | `service, version, commit, started_at` | baseline |
| `simsys_queue_depth` | Gauge | `service, queue` | opt-in (`trackQueue`) |
| `simsys_jobs_total` | Counter | `service, job, outcome` | opt-in (`trackJob`) |
| `simsys_job_duration_seconds` | Histogram | `service, job, outcome` | opt-in (`trackJob`) |

Alongside the `simsys_*` set, the registry serves prom-client's Node.js default
metrics (`nodejs_*`, `process_*` — GC stats, event-loop lag, heap spaces) so
runtime health for the Node process is visible without extra wiring. Those
carry the `service` default label.

## Cardinality rules

- `route` is the route **template** (`/items/:id` in Hono, `/items/:id`
  via `req.route.path` in Express), never the actual path. Unmatched paths
  (404s, scanner traffic) collapse to a single `route="__unmatched__"`
  bucket so they cannot blow out the label space.
- `status` is bucketed to class strings (`2xx`, `3xx`, `4xx`, `5xx`, `1xx`),
  never the raw numeric code.
- `outcome` on the job metrics is exactly one of `success` or `error`.
- Any user-derived label value should pass through
  `safeLabel(value, allowed)` before being attached to a metric.
- The package **refuses** at registration time to register any `simsys_*`
  metric whose name does not start with the prefix. Throws an `Error`.

## `commit` detection

`simsys_build_info.commit` is resolved in this order:

1. `SIMSYS_BUILD_COMMIT` environment variable (if set and non-empty).
2. `git rev-parse --short HEAD` in the process's current working directory.
3. Literal string `"unknown"` if neither is available.

In container images, set `SIMSYS_BUILD_COMMIT` at build time:

```dockerfile
ARG GIT_COMMIT=unknown
ENV SIMSYS_BUILD_COMMIT=${GIT_COMMIT}
```

and build with `docker build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) .`.

## `/metrics` endpoint behaviour

- Auto-mounted at `/metrics` on the same port as the app. No separate metrics
  port.
- Designed for direct scraping on a localhost or VPC interface — the package
  itself adds no auth on the endpoint; gate it at the reverse proxy / network
  layer if exposed publicly.
- Express: the recommended auth-exempt path set is exposed as
  `app.locals.simsysExemptPaths` (a `ReadonlySet<string>`).
- Hono: the same set is attached as `app.simsysExemptPaths`.
- `/metrics` is exempt from the HTTP request metrics recording so the scrape
  endpoint doesn't pollute its own counts.

## Development

The Node package lives under `node/` in the unified
[`simsys-metrics`](https://github.com/Avicennasis/simsys-metrics) monorepo
(shared with the Python and Go siblings).

```bash
git clone https://github.com/Avicennasis/simsys-metrics.git
cd simsys-metrics/node
npm install

npm run build    # tsc -> dist/
npm test         # vitest run
```

### Release flow

1. Bump `version` in `node/package.json` and `node/CHANGELOG.md`.
2. `npm run build && npm test` — both must be green.
3. `git tag node-vX.Y.Z` (node-prefixed tag scheme; the Python sibling uses
   bare `vX.Y.Z` and the Go sibling uses `go/vX.Y.Z`).
4. `npm pack` to build the tarball, then attach it to a GitHub Release on
   the `node-vX.Y.Z` tag — that's the install URL consumers pin to.

## License

[MIT](LICENSE). Use it anywhere, no attribution required, no warranty.

## See also

- **Python sibling:** [`simsys-metrics`](https://github.com/Avicennasis/simsys-metrics) (FastAPI + Flask).
- **Upstream dependency:** [`prom-client`](https://github.com/siimon/prom-client).
- **Grafana dashboard template:** any dashboard that templates over the
  `service` label will work; build it from the metric catalogue above.
