/**
 * Prefix-guarded metric definitions and the shared prom-client registry.
 *
 * Every simsys metric is forced to start with `simsys_` — the guards make it
 * impossible to accidentally ship a metric under a bare name when using this
 * package. Matches `simsys_metrics._registry` (Python).
 */

import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export const PREFIX = "simsys_";

/**
 * The simsys-owned Prometheus registry. We do NOT use prom-client's default
 * global registry so consumer apps can host their own metrics side-by-side
 * without collisions, and so tests can reset cleanly.
 */
export const registry = new Registry();

function guardName(name: string): string {
  if (typeof name !== "string" || !name.startsWith(PREFIX)) {
    throw new Error(
      `simsys-metrics refuses to register metric '${name}': all metric names must start with '${PREFIX}'.`,
    );
  }
  return name;
}

export function makeCounter(
  name: string,
  help: string,
  labelNames: readonly string[] = [],
): Counter {
  return new Counter({
    name: guardName(name),
    help,
    labelNames: [...labelNames],
    registers: [registry],
  });
}

export function makeGauge(
  name: string,
  help: string,
  labelNames: readonly string[] = [],
): Gauge {
  return new Gauge({
    name: guardName(name),
    help,
    labelNames: [...labelNames],
    registers: [registry],
  });
}

export function makeHistogram(
  name: string,
  help: string,
  labelNames: readonly string[] = [],
  buckets?: readonly number[],
): Histogram {
  return new Histogram({
    name: guardName(name),
    help,
    labelNames: [...labelNames],
    registers: [registry],
    ...(buckets ? { buckets: [...buckets] } : {}),
  });
}

// -------- HTTP metrics (baseline) --------

export const httpRequestsTotal = makeCounter(
  "simsys_http_requests_total",
  "Total HTTP requests handled, bucketed by status class.",
  ["service", "method", "route", "status"],
);

export const httpRequestDurationSeconds = makeHistogram(
  "simsys_http_request_duration_seconds",
  "HTTP request duration in seconds, labelled by route template.",
  ["service", "method", "route"],
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
);

export function statusBucket(statusCode: number | string): string {
  const code = typeof statusCode === "number" ? statusCode : Number(statusCode);
  if (!Number.isFinite(code)) return "5xx";
  if (code >= 100 && code < 200) return "1xx";
  if (code >= 200 && code < 300) return "2xx";
  if (code >= 300 && code < 400) return "3xx";
  if (code >= 400 && code < 500) return "4xx";
  return "5xx";
}

// -------- Build info --------

export const buildInfo = makeGauge(
  "simsys_build_info",
  "Service build information. Always equal to 1; read labels for actual data.",
  ["service", "version", "commit", "started_at"],
);

// -------- Queue + job (opt-in) --------

export const queueDepth = makeGauge(
  "simsys_queue_depth",
  "Current depth of an application-owned queue.",
  ["service", "queue"],
);

export const jobsTotal = makeCounter(
  "simsys_jobs_total",
  "Jobs completed, labelled by name and outcome (success/error).",
  ["service", "job", "outcome"],
);

export const jobDurationSeconds = makeHistogram(
  "simsys_job_duration_seconds",
  "Job duration in seconds.",
  ["service", "job", "outcome"],
  [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
);

// -------- Progress tracking (opt-in) --------

export const progressProcessedTotal = makeCounter(
  "simsys_progress_processed_total",
  "Items completed in a batch operation (monotonic counter).",
  ["service", "operation"],
);

export const progressRemaining = makeGauge(
  "simsys_progress_remaining",
  "Items not yet completed in a batch operation.",
  ["service", "operation"],
);

export const progressRatePerSecond = makeGauge(
  "simsys_progress_rate_per_second",
  "EWMA-smoothed processing rate in items per second.",
  ["service", "operation"],
);

export const progressEstimatedCompletionTimestamp = makeGauge(
  "simsys_progress_estimated_completion_timestamp",
  "Estimated completion time as a Unix timestamp (0 when unknown).",
  ["service", "operation"],
);

// -------- Default runtime metrics (opt-in wrapper) --------

let defaultMetricsRegistered = false;
export function registerNodeDefaultMetrics(service: string): void {
  if (defaultMetricsRegistered) return;
  defaultMetricsRegistered = true;
  // prom-client's default metrics cover GC, event loop lag, and heap details
  // with the `nodejs_` / `process_` prefixes. We register them to OUR registry
  // so they're served by the same /metrics endpoint. They won't carry the
  // `service` label but they're useful enough to include. A per-service static
  // label is applied via `registry.setDefaultLabels`.
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
}
