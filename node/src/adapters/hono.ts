/**
 * Bun + Hono adapter.
 *
 * Uses Hono's `app.use('*', mw)` for request timing and `app.get('/metrics')`
 * for the scrape endpoint. Route template resolution pulls from
 * `c.req.routePath` (Hono >= 4) which is the template string ("/items/:id").
 */

import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
  statusBucket,
  buildInfo,
  registry,
  registerNodeDefaultMetrics,
} from "../registry.js";
import { registerProcessCollector } from "../process.js";
import { detectCommit, startedAtNow } from "../buildinfo.js";
import { setService } from "../baseline.js";

// Keep Hono loose-typed — we don't import `hono` at runtime here; the consumer
// brings it. TypeScript users get inference via the generic in `install()`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HonoLike = any;

export interface HonoInstallOpts {
  service: string;
  version: string;
  commit?: string;
  metricsPath?: string;
}

export const EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/metrics",
  "/health",
  "/ready",
  "/healthz",
]);

export function installHono(app: HonoLike, opts: HonoInstallOpts): HonoLike {
  const { service, version } = opts;
  const metricsPath = opts.metricsPath ?? "/metrics";
  const commit = opts.commit ?? detectCommit();

  setService(service);
  registerProcessCollector(service);
  registerNodeDefaultMetrics(service);
  buildInfo
    .labels({
      service,
      version,
      commit,
      started_at: startedAtNow(),
    })
    .set(1);

  // Expose the exempt-path set via app.get('X-Simsys-Exempt-Paths')? Hono
  // doesn't have per-app `locals`, but it does have context.set on each
  // request. For discovery we attach it to a symbol-keyed property on the app
  // instance itself.
  (app as Record<string | symbol, unknown>).simsysExemptPaths = EXEMPT_PATHS;
  (app as Record<string | symbol, unknown>).simsysService = service;

  // Middleware for HTTP request metrics — registered BEFORE the /metrics
  // handler so ordering is: mw -> [route handlers, including /metrics].
  // We short-circuit the metrics path so the scrape endpoint isn't recorded.
  app.use("*", async (c: HonoLike, next: () => Promise<void>) => {
    if (c.req.path === metricsPath) {
      return next();
    }
    const start = process.hrtime.bigint();
    try {
      await next();
    } finally {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
      const method = c.req.method;
      // Hono 4+: routePath is the template ("/items/:id"). When no real route
      // handler matched, Hono reports the *middleware's own* pattern ("/*" or
      // "*") as the routePath — those values must collapse into the unmatched
      // bucket so 404 scanner traffic doesn't blow out cardinality.
      const rawRoute =
        typeof c.req.routePath === "string" ? c.req.routePath : "";
      const route: string =
        rawRoute && rawRoute !== "/*" && rawRoute !== "*"
          ? rawRoute
          : "__unmatched__";
      const status = c.res?.status ?? 500;
      httpRequestsTotal
        .labels({
          service,
          method,
          route,
          status: statusBucket(status),
        })
        .inc();
      httpRequestDurationSeconds
        .labels({ service, method, route })
        .observe(elapsed);
    }
  });

  app.get(metricsPath, async (c: HonoLike) => {
    const body = await registry.metrics();
    return c.text(body, 200, { "Content-Type": registry.contentType });
  });

  return app;
}

export function isHonoApp(app: unknown): boolean {
  if (!app || (typeof app !== "object" && typeof app !== "function")) {
    return false;
  }
  const a = app as Record<string, unknown>;
  return (
    typeof a.route === "function" &&
    // `fetch` is the WHATWG fetch handler Hono exposes; Express apps do not
    // have `.fetch()`. This is the strongest disambiguator.
    typeof a.fetch === "function" &&
    typeof a.get === "function"
  );
}
