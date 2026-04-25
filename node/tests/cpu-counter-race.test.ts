/**
 * Regression test for concurrent /metrics scrapes double-counting CPU.
 *
 * prom-client's Registry.metrics() walks collectors via Promise.all, so
 * two concurrent scrapes (e.g. Prometheus + a sidecar push monitor) can
 * race the cpu collector's read-and-update sequence. Pre-fix:
 *
 *   - scrape A reads lastCpuSeconds=0, sees total=10, inc by 10
 *   - scrape B reads lastCpuSeconds=0 (A hasn't written yet), sees
 *     total=10.001, inc by 10.001
 *   - lastCpuSeconds ends up at 10.001, but counter advanced by 20.001
 *
 * Post-fix: cpuCollectMutex serializes the read-update-inc sequence so
 * the second scrape sees the first scrape's lastCpuSeconds and inc's
 * by the correct ~zero delta.
 *
 * The test exercises this by forcing many concurrent metrics() calls
 * and asserting the counter value never exceeds plausible bounds for
 * the actual elapsed CPU (process.cpuUsage() is bounded by wall time).
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { install, registry } from "../src/index.js";
import { _resetForTests as _resetProc } from "../src/process.js";
import { _resetForTests as _resetBase } from "../src/baseline.js";

describe("cpu counter concurrent-scrape race", () => {
  beforeEach(() => {
    _resetProc();
    _resetBase();
    registry.resetMetrics();
  });

  it("parallel registry.metrics() does not double-count CPU", async () => {
    const app = express();
    install(app, { service: "cpu-race", version: "0.0.0" });

    // Burn a tiny amount of CPU so cpuUsage() returns non-zero.
    const burnUntil = Date.now() + 10;
    while (Date.now() < burnUntil) {
      // Busy loop to ensure cpuUsage() ticks above zero on this thread.
    }

    // Fire 16 parallel scrapes. Without serialization the cpu counter
    // would advance by ~16× the actual delta on every concurrent batch.
    const scrapes = await Promise.all(
      Array.from({ length: 16 }, () => registry.metrics()),
    );

    // Parse the cpu counter value from each scrape.
    const cpuValues = scrapes.map((body) => {
      const match = body
        .split("\n")
        .find(
          (l) =>
            l.startsWith("simsys_process_cpu_seconds_total") &&
            l.includes('service="cpu-race"'),
        );
      if (!match) return 0;
      const num = Number(match.split(" ").pop());
      return Number.isFinite(num) ? num : 0;
    });

    // Each scrape's reading must be monotonic (counter never decreases).
    for (let i = 1; i < cpuValues.length; i++) {
      expect(cpuValues[i]).toBeGreaterThanOrEqual(cpuValues[i - 1]);
    }

    // Final value: must be a reasonable fraction of wall-clock seconds.
    // process.cpuUsage() can't legitimately exceed wall-clock × cores; for
    // a ~50ms test on any sane machine that means well under 1 cpu-second.
    // Pre-fix bug would have inflated the counter by ~16× (= ~hundreds of
    // ms) on the first concurrent batch, easily exceeding 1.
    const finalValue = cpuValues[cpuValues.length - 1];
    expect(finalValue).toBeLessThan(1);
  });

  it("sequential scrapes converge on cumulative cpuUsage", async () => {
    const app = express();
    install(app, { service: "cpu-seq", version: "0.0.0" });

    const burnUntil = Date.now() + 5;
    while (Date.now() < burnUntil) {
      // tiny burn
    }

    // Sequential scrapes: each should add only the delta since the
    // previous one. The total counter value after N sequential scrapes
    // must equal cpuUsage() at the time of the final scrape.
    const body1 = await registry.metrics();
    const body2 = await registry.metrics();
    const body3 = await registry.metrics();

    const parseCpu = (body: string): number => {
      const line = body
        .split("\n")
        .find(
          (l) =>
            l.startsWith("simsys_process_cpu_seconds_total") &&
            l.includes('service="cpu-seq"'),
        );
      return line ? Number(line.split(" ").pop()) : 0;
    };

    const v1 = parseCpu(body1);
    const v2 = parseCpu(body2);
    const v3 = parseCpu(body3);

    // Monotonic.
    expect(v2).toBeGreaterThanOrEqual(v1);
    expect(v3).toBeGreaterThanOrEqual(v2);
    // No scrape should have inflated by more than 100ms of cpu time
    // (conservative upper bound for any test machine on a 5ms burn).
    expect(v3 - v1).toBeLessThan(0.1);
  });
});
