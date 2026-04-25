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
  normalizeMethod,
  statusBucket,
  buildInfo,
  registry,
  registerNodeDefaultMetrics,
} from "../registry.js";
import { registerProcessCollector } from "../process.js";
import { detectCommit, startedAtNow } from "../buildinfo.js";
import { setService, _peekService } from "../baseline.js";

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

// Default exempt paths. The actual per-install set built below also
// includes the user-supplied metricsPath if it differs from /metrics.
const DEFAULT_HEALTH_PATHS: readonly string[] = ["/health", "/ready", "/healthz"];

export const EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/metrics",
  ...DEFAULT_HEALTH_PATHS,
]);

function buildExemptPaths(metricsPath: string): ReadonlySet<string> {
  return new Set([metricsPath, ...DEFAULT_HEALTH_PATHS]);
}

export function installHono(app: HonoLike, opts: HonoInstallOpts): HonoLike {
  const { service, version } = opts;
  const metricsPath = opts.metricsPath ?? "/metrics";
  const commit = opts.commit ?? detectCommit();

  // Idempotent: a second install() on the same Hono app is a no-op.
  // Without this guard a second install would add a second wildcard
  // middleware (request counted twice) plus a second /metrics route
  // (Hono returns the LAST handler that matched, so the second one
  // would shadow the first — but the duplicate middleware is the real
  // cardinality bug).
  const appProps = app as Record<string | symbol, unknown>;
  if (appProps.simsysMetricsInstalled) {
    if (
      appProps.simsysService !== service ||
      appProps.simsysVersion !== version
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `[simsys-metrics] install() called again on the same Hono app ` +
          `with different service/version (${String(appProps.simsysService)}/` +
          `${String(appProps.simsysVersion)} vs ${service}/${version}); the ` +
          `new values are IGNORED. To re-init, drop ` +
          `app.simsysMetricsInstalled first.`,
      );
    }
    return app;
  }

  // Snapshot every piece of state install is about to mutate so the
  // rollback can undo each one on partial failure (e.g. app.use or
  // app.get throwing because Hono is being misused). Without this, the
  // sentinel below could be set true before framework wiring completes,
  // leaving the app half-installed and retries no-opping.
  const preService = _peekService();
  let buildInfoLabels: { service: string; version: string; commit: string; started_at: string } | null = null;

  try {
    setService(service);
    registerProcessCollector(service);
    registerNodeDefaultMetrics(service);
    buildInfoLabels = {
      service,
      version,
      commit,
      started_at: startedAtNow(),
    };
    buildInfo.labels(buildInfoLabels).set(1);

    // Expose the exempt-path set via a symbol-keyed property on the app
    // instance itself (Hono doesn't have per-app `locals`).
    appProps.simsysExemptPaths = buildExemptPaths(metricsPath);
    appProps.simsysService = service;
    appProps.simsysVersion = version;

    // Middleware for HTTP request metrics — registered BEFORE the
    // /metrics handler so ordering is mw -> [route handlers, including
    // /metrics]. Short-circuits the metrics path so the scrape endpoint
    // isn't recorded.
    app.use("*", async (c: HonoLike, next: () => Promise<void>) => {
      if (c.req.path === metricsPath) {
        return next();
      }
      const start = process.hrtime.bigint();
      try {
        await next();
      } finally {
        const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
        const method = normalizeMethod(c.req.method);
        // Hono 4+: routePath is the template ("/items/:id"). When no
        // real route handler matched, Hono reports the *middleware's
        // own* pattern ("/*" or "*") as the routePath — those values
        // must collapse into the unmatched bucket so 404 scanner
        // traffic doesn't blow out cardinality.
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

    // Set the sentinel LAST — only after every framework-wiring step
    // succeeded.
    appProps.simsysMetricsInstalled = true;
  } catch (err) {
    // Roll back app props + any process-wide prom-client mutations made
    // during this install attempt. Caller still sees the original error.
    try {
      delete appProps.simsysExemptPaths;
      delete appProps.simsysService;
      delete appProps.simsysVersion;
      delete appProps.simsysMetricsInstalled;
    } catch {
      /* defensive */
    }
    if (buildInfoLabels !== null) {
      try {
        buildInfo.remove(buildInfoLabels);
      } catch {
        /* defensive */
      }
    }
    setService(preService);
    throw err;
  }

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
