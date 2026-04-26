/**
 * Next.js adapter.
 *
 * Next.js standalone has no Express-style middleware chain to plug into,
 * so installNext() patches `http.Server.prototype.emit` to capture every
 * request finish — same trick OpenTelemetry's Next instrumentation uses.
 * Combined with `instrumentation.ts` (server-startup hook) for baseline
 * registration and an `app/api/metrics/route.ts` re-export for the
 * scrape endpoint, this gives the full Express-equivalent surface.
 *
 * Cardinality discipline: route labels go through bucketRoute() which
 * strips query strings, normalizes numeric segments to `:id`, UUIDs to
 * `:uuid`, and collapses anything > 5 segments to `/<a>/<b>/__deep__`.
 * Consumers can pass `routeTemplates` for high-fidelity overrides.
 */

import http from "node:http";

import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
  normalizeMethod,
  statusBucket,
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

export interface RouteTemplate {
  pattern: RegExp;
  template: string;
}

export interface NextInstallOpts {
  service: string;
  version: string;
  commit?: string;
  /** Path served by the user's `app/api/metrics/route.ts`. Default `/api/metrics`. */
  metricsPath?: string;
  /** Optional regex→template overrides for high-fidelity route labels. */
  routeTemplates?: RouteTemplate[];
}

const NUMERIC_RE = /^\d+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure function: turn a raw URL path into a bounded-cardinality route label.
 * Exported for testing + consumer introspection.
 */
export function bucketRoute(
  url: string,
  templates: readonly RouteTemplate[] = [],
): string {
  // Strip query string + fragment.
  const qsIdx = url.indexOf("?");
  let path = qsIdx >= 0 ? url.slice(0, qsIdx) : url;
  const hashIdx = path.indexOf("#");
  if (hashIdx >= 0) path = path.slice(0, hashIdx);

  if (path === "" || path === "/") return "/";

  // Custom templates win over default bucketing.
  for (const t of templates) {
    if (t.pattern.test(path)) return t.template;
  }

  // Split + normalize.
  const parts = path.split("/").slice(1);
  if (parts.length > 5) {
    return `/${parts[0] ?? ""}/${parts[1] ?? ""}/__deep__`;
  }
  const normalized = parts.map((p) => {
    if (NUMERIC_RE.test(p)) return ":id";
    if (UUID_RE.test(p)) return ":uuid";
    return p;
  });
  return "/" + normalized.join("/");
}

declare global {
  // eslint-disable-next-line no-var
  var __simsysNextInstalled: boolean | undefined;
  // eslint-disable-next-line no-var
  var __simsysNextOrigEmit:
    | ((this: http.Server, event: string | symbol, ...args: unknown[]) => boolean)
    | undefined;
}

/**
 * Install simsys baseline metrics + per-request HTTP instrumentation for a
 * Next.js standalone server.
 *
 * Call from `instrumentation.ts` at the project root:
 *
 *   export async function register() {
 *     if (process.env.NEXT_RUNTIME !== "nodejs") return;
 *     const { installNext } = await import("@simsys/metrics");
 *     installNext({ service: "leadership", version: pkg.version });
 *   }
 *
 * Then mount `app/api/metrics/route.ts`:
 *
 *   export { GET } from "@simsys/metrics/next/route";
 *   export const dynamic = "force-dynamic";
 */
export function installNext(opts: NextInstallOpts): void {
  if (!opts || typeof opts !== "object") {
    throw new Error("installNext(): opts { service, version } required.");
  }
  if (!opts.service || typeof opts.service !== "string") {
    throw new Error("installNext(): opts.service must be a non-empty string.");
  }
  if (!opts.version || typeof opts.version !== "string") {
    throw new Error("installNext(): opts.version must be a non-empty string.");
  }

  // Idempotent guard. instrumentation.ts is called once per server start in
  // production; Next dev mode hot-reloads it, so the sentinel keeps repeated
  // calls from double-patching emit.
  if (globalThis.__simsysNextInstalled) {
    return;
  }

  const { service, version } = opts;
  const commit = opts.commit ?? detectCommit();
  const metricsPath = opts.metricsPath ?? "/api/metrics";
  const routeTemplates = opts.routeTemplates ?? [];

  // Snapshot every piece of state install is about to mutate, so partial
  // failure rolls back cleanly. Mirrors Express adapter discipline.
  const preService = _peekService();
  const origEmit = http.Server.prototype.emit;
  let buildInfoLabels: BuildInfoLabels | null = null;
  let buildInfoWasNew = false;
  let procCollectorState: ProcessCollectorRollbackState | null = null;
  let emitPatched = false;

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

    http.Server.prototype.emit = function (
      this: http.Server,
      event: string | symbol,
      ...args: unknown[]
    ): boolean {
      if (event !== "request") {
        return origEmit.apply(this, [event, ...args] as Parameters<
          http.Server["emit"]
        >);
      }
      const req = args[0] as http.IncomingMessage | undefined;
      const res = args[1] as http.ServerResponse | undefined;
      if (!req || !res) {
        return origEmit.apply(this, [event, ...args] as Parameters<
          http.Server["emit"]
        >);
      }

      const url = req.url ?? "/";
      const qsIdx = url.indexOf("?");
      const pathOnly = qsIdx >= 0 ? url.slice(0, qsIdx) : url;
      if (pathOnly === metricsPath) {
        return origEmit.apply(this, [event, ...args] as Parameters<
          http.Server["emit"]
        >);
      }

      const start = process.hrtime.bigint();
      const finalize = () => {
        res.removeListener("finish", finalize);
        res.removeListener("close", finalize);
        const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
        const route = bucketRoute(url, routeTemplates);
        const method = normalizeMethod(req.method);
        const status = res.statusCode ?? 500;
        try {
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
        } catch {
          /* defensive: bad labels must not crash request finalize */
        }
      };
      res.on("finish", finalize);
      res.on("close", finalize);

      return origEmit.apply(this, [event, ...args] as Parameters<
        http.Server["emit"]
      >);
    };
    emitPatched = true;

    // Sentinels set LAST — only after every wiring step succeeded.
    globalThis.__simsysNextInstalled = true;
    globalThis.__simsysNextOrigEmit = origEmit as typeof globalThis.__simsysNextOrigEmit;
  } catch (err) {
    if (emitPatched) {
      try {
        http.Server.prototype.emit = origEmit;
      } catch {
        /* defensive */
      }
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
}
