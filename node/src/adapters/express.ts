/**
 * Express 5 adapter.
 *
 * Wires request count + latency histograms, mounts GET /metrics, and emits
 * simsys_build_info + simsys_process_*. Route template resolution is done by
 * reading req.route.path after middleware runs; falls back to the literal
 * "__unmatched__" label when no route matched, so 404 scanner traffic
 * (/wp-admin, /.env, etc.) doesn't blow out cardinality.
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
import { setService } from "../baseline.js";

// We intentionally keep the Express type loose — consumers bring their own
// dependency. `unknown` + duck-type checks is enough here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExpressLike = any;

export interface ExpressInstallOpts {
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

export function installExpress(
  app: ExpressLike,
  opts: ExpressInstallOpts,
): ExpressLike {
  const { service, version } = opts;
  const metricsPath = opts.metricsPath ?? "/metrics";
  const commit = opts.commit ?? detectCommit();

  // Idempotent: a second install() on the same app is a no-op so tests,
  // plugins, and lazy app factories can call install() repeatedly without
  // doubling middleware (which would double-count every request) or
  // mounting two /metrics routes.
  app.locals = app.locals ?? {};
  if (app.locals.simsysMetricsInstalled) {
    if (
      app.locals.simsysService !== service ||
      app.locals.simsysVersion !== version
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `[simsys-metrics] install() called again on the same Express app ` +
          `with different service/version (${app.locals.simsysService}/` +
          `${app.locals.simsysVersion} vs ${service}/${version}); the new ` +
          `values are IGNORED. To re-init, drop ` +
          `app.locals.simsysMetricsInstalled first.`,
      );
    }
    return app;
  }

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

  // Expose the exempt-path set so upstream auth middleware can skip them
  // without hard-coding the list. Includes the user-supplied metricsPath
  // when it differs from the default /metrics.
  app.locals.simsysExemptPaths = buildExemptPaths(metricsPath);
  app.locals.simsysService = service;
  app.locals.simsysVersion = version;
  app.locals.simsysMetricsInstalled = true;

  // Metrics endpoint. Register FIRST so it wins over any catch-all middleware
  // installed later; the HTTP-recording middleware below checks the path and
  // recurses past /metrics so it doesn't pollute its own request counts.
  app.get(metricsPath, async (_req: unknown, res: ExpressLike) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  app.use((req: ExpressLike, res: ExpressLike, next: () => void) => {
    if (req.path === metricsPath) {
      return next();
    }
    const start = process.hrtime.bigint();

    const finalize = () => {
      res.removeListener("finish", finalize);
      res.removeListener("close", finalize);
      const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
      const method = normalizeMethod(req.method);
      // In Express 5, req.route is populated after a matching route handler
      // runs. For middleware-only paths or 404s it's undefined; we collapse
      // those into a single "__unmatched__" bucket to keep cardinality bounded.
      const matchedRoutePath =
        req.route && typeof req.route.path === "string" ? req.route.path : null;
      // Prefix req.baseUrl when the route is matched inside a Router:
      const route = matchedRoutePath
        ? req.baseUrl
          ? `${req.baseUrl}${matchedRoutePath}`
          : matchedRoutePath
        : "__unmatched__";
      const status = res.statusCode ?? 500;
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
    };

    res.on("finish", finalize);
    res.on("close", finalize);
    next();
  });

  return app;
}

export function isExpressApp(app: unknown): boolean {
  if (!app || (typeof app !== "object" && typeof app !== "function")) {
    return false;
  }
  const a = app as Record<string, unknown>;
  return (
    typeof a.use === "function" &&
    typeof a.get === "function" &&
    // Express app instances expose `handle(req, res, next)` and `listen()`.
    typeof a.handle === "function" &&
    typeof a.listen === "function"
  );
}
