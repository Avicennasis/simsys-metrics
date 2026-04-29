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
  registry,
  registerNodeDefaultMetrics,
} from "../registry.js";
import {
  registerProcessCollector,
  restoreProcessCollector,
  type ProcessCollectorRollbackState,
} from "../process.js";
import {
  detectCommit,
  startedAtNow,
  registerBuildInfo,
  unregisterBuildInfoIfOwned,
  type BuildInfoLabels,
} from "../buildinfo.js";
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

// Strip trailing "/" characters without a regex. Avoids CodeQL's
// polynomial-redos false positive on `/\/+$/` (the `+` quantifier is
// linear here because `$` is anchored, but the static analyzer can't
// always prove it).
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) {
    end--;
  }
  return end === s.length ? s : s.slice(0, end);
}

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
    // The /metrics route is registered against the FIRST install's
    // metricsPath; subsequent re-installs with a different
    // metricsPath silently no-op without moving the route. Warn so
    // callers don't end up debugging a 404 on a path they thought
    // they'd configured.
    const priorMetricsPath = appProps.simsysMetricsPath;
    // The stored simsysMetricsPath is the ABSOLUTE path (basePath +
    // metricsPath) — compute the same shape for the new call so we
    // compare apples to apples.
    const honoBasePath =
      ((app as Record<string, unknown>)._basePath as string | undefined) ?? "";
    const newAbsoluteMetricsPath =
      honoBasePath && honoBasePath !== "/"
        ? stripTrailingSlashes(honoBasePath) + metricsPath
        : metricsPath;
    if (
      appProps.simsysService !== service ||
      appProps.simsysVersion !== version ||
      priorMetricsPath !== newAbsoluteMetricsPath
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `[simsys-metrics] install() called again on the same Hono app ` +
          `with different service/version/metricsPath ` +
          `(${String(appProps.simsysService)}/` +
          `${String(appProps.simsysVersion)}/${String(priorMetricsPath)} vs ` +
          `${service}/${version}/${newAbsoluteMetricsPath}); the new values ` +
          `are IGNORED. To re-init, drop ` +
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
  let buildInfoLabels: BuildInfoLabels | null = null;
  let buildInfoWasNew = false;
  let procCollectorState: ProcessCollectorRollbackState | null = null;

  try {
    setService(service);
    procCollectorState = registerProcessCollector(service);
    registerNodeDefaultMetrics(service);
    buildInfoLabels = {
      service,
      version,
      commit,
      started_at: startedAtNow(),
    };
    ({ wasNew: buildInfoWasNew } = registerBuildInfo(buildInfoLabels));

    // Expose the exempt-path set via a symbol-keyed property on the app
    // instance itself (Hono doesn't have per-app `locals`).
    appProps.simsysExemptPaths = buildExemptPaths(metricsPath);
    appProps.simsysService = service;
    appProps.simsysVersion = version;
    // Absolute URL path the metrics endpoint will respond on — Hono's
    // `app.basePath("/api")` prepends "/api" to every registered route,
    // including `app.get(metricsPath, ...)`. The middleware's
    // metrics-path exemption compares against `c.req.path`, which is
    // the raw incoming URL — so the exemption check needs the absolute
    // path, not the install-time `metricsPath` argument. Read
    // `_basePath` (Hono internal) to compute it once at install time;
    // basePath is fixed on the app instance (Hono's basePath() returns
    // a clone), so this is stable for the app's lifetime.
    const honoBasePath =
      ((app as Record<string, unknown>)._basePath as string | undefined) ?? "";
    const absoluteMetricsPath =
      honoBasePath && honoBasePath !== "/"
        ? stripTrailingSlashes(honoBasePath) + metricsPath
        : metricsPath;
    appProps.simsysMetricsPath = absoluteMetricsPath;

    // Hono offers no public API for removing a previously-registered
    // route or middleware. So instead of mutating-and-rolling-back, we
    // install the framework wiring AT MOST ONCE per app and gate every
    // recording action on the live `simsysMetricsInstalled` flag (set
    // LAST in this try block; cleared by the catch below). The handlers
    // also read service/metricsPath from appProps each request, so
    // stale closure values from a rolled-back partial install can't
    // pollute future metrics.
    //
    // Net effect: a partial install (e.g. app.get throws after app.use
    // already wired the middleware) leaves the wiring in place but
    // INERT — no metrics are recorded, /metrics returns 404. A retry
    // skips re-wiring (so middleware doesn't double-stack and routes
    // don't double-mount) and just re-arms the live flag.
    if (!appProps.simsysHonoMwInstalled) {
      app.use("*", async (c: HonoLike, next: () => Promise<void>) => {
        if (!appProps.simsysMetricsInstalled) {
          // Partial install rolled back — be inert until armed again.
          return next();
        }
        const livePath =
          (appProps.simsysMetricsPath as string | undefined) ?? "/metrics";
        if (c.req.path === livePath) {
          return next();
        }
        const start = process.hrtime.bigint();
        try {
          await next();
        } finally {
          const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
          const liveService =
            (appProps.simsysService as string | undefined) ?? service;
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
              service: liveService,
              method,
              route,
              status: statusBucket(status),
            })
            .inc();
          httpRequestDurationSeconds
            .labels({ service: liveService, method, route })
            .observe(elapsed);
        }
      });
      appProps.simsysHonoMwInstalled = true;
    }

    if (!appProps.simsysHonoRouteInstalled) {
      app.get(metricsPath, async (c: HonoLike) => {
        if (!appProps.simsysMetricsInstalled) {
          // Partial install rolled back — pretend the route doesn't exist
          // so a retry can re-arm without a stale handler answering.
          return c.notFound();
        }
        const body = await registry.metrics();
        return c.text(body, 200, { "Content-Type": registry.contentType });
      });
      appProps.simsysHonoRouteInstalled = true;
    }

    // Set the sentinel LAST — only after every framework-wiring step
    // succeeded. Until this is true, the wired middleware/route stay
    // inert per the gating checks above.
    appProps.simsysMetricsInstalled = true;
  } catch (err) {
    // Roll back app props + any process-wide prom-client mutations made
    // during this install attempt. Caller still sees the original error.
    //
    // Note: simsysHonoMwInstalled / simsysHonoRouteInstalled are
    // INTENTIONALLY left as-is. Hono can't unregister routes; clearing
    // the flags would cause a retry to install a SECOND middleware/route
    // on top of the inert one, producing the double-stack bug Codex's
    // F1 finding describes. The handlers are gated on
    // simsysMetricsInstalled, so they remain inert until a retry sets
    // that flag back to true.
    try {
      delete appProps.simsysExemptPaths;
      delete appProps.simsysService;
      delete appProps.simsysVersion;
      delete appProps.simsysMetricsPath;
      delete appProps.simsysMetricsInstalled;
    } catch {
      /* defensive */
    }
    if (buildInfoLabels !== null) {
      try {
        unregisterBuildInfoIfOwned(buildInfoLabels, buildInfoWasNew);
      } catch {
        /* defensive */
      }
    }
    if (procCollectorState !== null) {
      try {
        restoreProcessCollector(procCollectorState);
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
