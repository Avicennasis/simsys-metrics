/**
 * Batch-job progress tracking.
 *
 * Usage::
 *
 *   import { install, trackProgress } from "@simsys/metrics";
 *
 *   install(app, { service: "scanner", version: "1.0.0" });
 *
 *   const tracker = trackProgress({ operation: "scan", total: inputCount });
 *   for (const item of work) {
 *     await process(item);
 *     tracker.inc();
 *   }
 *   tracker.stop();
 *
 * Emits four metrics, all keyed on ``{service, operation}``:
 *
 *   - simsys_progress_processed_total          (counter)
 *   - simsys_progress_remaining                (gauge)
 *   - simsys_progress_rate_per_second          (gauge, EWMA)
 *   - simsys_progress_estimated_completion_timestamp (gauge, unix seconds)
 *
 * Matches `simsys_metrics.progress` (Python).
 */

import { getService } from "./baseline.js";
import {
  progressProcessedTotal,
  progressRemaining,
  progressRatePerSecond,
  progressEstimatedCompletionTimestamp,
} from "./registry.js";

export interface ProgressOpts {
  operation: string;
  total: number;
  /** EWMA smoothing window (ms). Default 5000. */
  windowMs?: number;
  /** Gauge update cadence (ms). Default 5000. */
  intervalMs?: number;
}

export interface ProgressTracker {
  /** Record n items completed (default 1). */
  inc(n?: number): void;
  /** Update the denominator — useful when work grows mid-run. */
  setTotal(total: number): void;
  /** Flush final state and stop the background timer. Idempotent. */
  stop(): void;
}

const _progressTimers: NodeJS.Timeout[] = [];

export function trackProgress(opts: ProgressOpts): ProgressTracker {
  if (!opts.operation || typeof opts.operation !== "string") {
    throw new Error("trackProgress: opts.operation must be a non-empty string");
  }
  if (!Number.isFinite(opts.total) || opts.total < 0) {
    throw new Error(
      `trackProgress: opts.total must be a non-negative number, got ${opts.total}`,
    );
  }
  const windowMs = opts.windowMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 5000;
  // Reject NaN / +Infinity / -Infinity / non-numeric:
  // - NaN passes `<= 0` vacuously and would propagate into rate math
  // - Infinity is clamped by Node's setInterval to a 1ms hot loop
  //   (with TimeoutOverflowWarning) — recreating the bug intervalMs
  //   validation was supposed to prevent.
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(
      `trackProgress: opts.windowMs must be a positive finite number of milliseconds, got ${String(windowMs)}`,
    );
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(
      `trackProgress: opts.intervalMs must be a positive finite number of milliseconds, got ${String(intervalMs)}`,
    );
  }

  const service = getService();
  const { operation } = opts;
  const labels = { service, operation };

  let processed = 0;
  let total = opts.total;
  let rateEwma: number | null = null;
  let lastProcessed = 0;
  let lastTickNs = process.hrtime.bigint();
  let stopped = false;

  // Seed gauges so the series exists before the first inc().
  progressRemaining.labels(labels).set(total);
  progressRatePerSecond.labels(labels).set(0);
  progressEstimatedCompletionTimestamp.labels(labels).set(0);

  const tick = (): void => {
    const now = process.hrtime.bigint();
    const elapsedSec = Number(now - lastTickNs) / 1e9;
    if (elapsedSec > 0) {
      const delta = processed - lastProcessed;
      const instantRate = delta / elapsedSec;
      // alpha = elapsedSec / windowSec, capped at 1.
      const alpha = Math.min(1, elapsedSec / (windowMs / 1000));
      rateEwma =
        rateEwma === null ? instantRate : alpha * instantRate + (1 - alpha) * rateEwma;
    }
    lastProcessed = processed;
    lastTickNs = now;

    const remaining = Math.max(0, total - processed);
    progressRemaining.labels(labels).set(remaining);

    const rate = rateEwma ?? 0;
    progressRatePerSecond.labels(labels).set(rate);

    let completionTs = 0;
    if (rate > 0 && remaining > 0) {
      const etaSec = remaining / rate;
      completionTs = Date.now() / 1000 + etaSec;
    }
    progressEstimatedCompletionTimestamp.labels(labels).set(completionTs);
  };

  const timer = setInterval(() => {
    try {
      tick();
    } catch {
      /* swallow — don't let metric updates kill the loop */
    }
  }, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  _progressTimers.push(timer);

  return {
    inc(n = 1): void {
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`trackProgress.inc: n must be >= 0, got ${n}`);
      }
      if (n === 0) return;
      processed += n;
      progressProcessedTotal.labels(labels).inc(n);
    },
    setTotal(newTotal: number): void {
      if (!Number.isFinite(newTotal) || newTotal < 0) {
        throw new Error(
          `trackProgress.setTotal: must be >= 0, got ${newTotal}`,
        );
      }
      total = newTotal;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const idx = _progressTimers.indexOf(timer);
      if (idx >= 0) _progressTimers.splice(idx, 1);
      try {
        tick();
      } catch {
        /* swallow */
      }
    },
  };
}

export function _resetProgressForTests(): void {
  while (_progressTimers.length) {
    const t = _progressTimers.pop();
    if (t) clearInterval(t);
  }
}
