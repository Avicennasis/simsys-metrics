import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setService,
  trackProgress,
  registry,
} from "../src/index.js";
import { _resetForTests as _resetBase } from "../src/baseline.js";
import { _resetProgressForTests } from "../src/progress.js";

async function getValue(
  name: string,
  labels: Record<string, string>,
): Promise<number | null> {
  const text = await registry.metrics();
  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
  // Match "name{...labels...} value" lines.
  const re = new RegExp(`^${name}\\{${labelStr}(?:,[^}]*)?\\}\\s+(\\S+)`, "m");
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

async function waitForValue(
  name: string,
  labels: Record<string, string>,
  expected: (v: number | null) => boolean,
  timeoutMs = 2000,
): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await getValue(name, labels);
    if (expected(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return getValue(name, labels);
}

describe("trackProgress", () => {
  beforeEach(() => {
    registry.resetMetrics();
    _resetBase();
    _resetProgressForTests();
  });
  afterEach(() => {
    _resetProgressForTests();
  });

  it("seeds gauges immediately on construction", async () => {
    setService("prog_test_seed");
    const t = trackProgress({
      operation: "scan-seed",
      total: 100,
      intervalMs: 50,
    });
    try {
      const remaining = await getValue("simsys_progress_remaining", {
        service: "prog_test_seed",
        operation: "scan-seed",
      });
      const rate = await getValue("simsys_progress_rate_per_second", {
        service: "prog_test_seed",
        operation: "scan-seed",
      });
      const eta = await getValue("simsys_progress_estimated_completion_timestamp", {
        service: "prog_test_seed",
        operation: "scan-seed",
      });
      expect(remaining).toBe(100);
      expect(rate).toBe(0);
      expect(eta).toBe(0);
    } finally {
      t.stop();
    }
  });

  it("inc() bumps the counter and refreshes remaining on tick", async () => {
    setService("prog_test_inc");
    const t = trackProgress({
      operation: "scan-inc",
      total: 10,
      intervalMs: 50,
    });
    try {
      t.inc(3);
      t.inc(2);
      // Counter is immediate.
      const processed = await getValue("simsys_progress_processed_total", {
        service: "prog_test_inc",
        operation: "scan-inc",
      });
      expect(processed).toBe(5);

      const remaining = await waitForValue(
        "simsys_progress_remaining",
        { service: "prog_test_inc", operation: "scan-inc" },
        (v) => v === 5,
      );
      expect(remaining).toBe(5);
    } finally {
      t.stop();
    }
  });

  it("rate and ETA become non-zero after sustained work", async () => {
    setService("prog_test_rate");
    const t = trackProgress({
      operation: "scan-rate",
      total: 1000,
      windowMs: 100,
      intervalMs: 50,
    });
    try {
      for (let i = 0; i < 20; i++) {
        t.inc(5);
        await new Promise((r) => setTimeout(r, 20));
      }
      const rate = await waitForValue(
        "simsys_progress_rate_per_second",
        { service: "prog_test_rate", operation: "scan-rate" },
        (v) => v !== null && v > 0,
      );
      expect(rate).toBeGreaterThan(0);

      const eta = await getValue(
        "simsys_progress_estimated_completion_timestamp",
        { service: "prog_test_rate", operation: "scan-rate" },
      );
      expect(eta).toBeGreaterThan(Date.now() / 1000);
    } finally {
      t.stop();
    }
  });

  it("setTotal updates the denominator", async () => {
    setService("prog_test_settotal");
    const t = trackProgress({
      operation: "scan-settotal",
      total: 100,
      intervalMs: 50,
    });
    try {
      t.inc(10);
      t.setTotal(500);
      const remaining = await waitForValue(
        "simsys_progress_remaining",
        { service: "prog_test_settotal", operation: "scan-settotal" },
        (v) => v === 490,
      );
      expect(remaining).toBe(490);
    } finally {
      t.stop();
    }
  });

  it("stop() is idempotent", () => {
    setService("prog_test_stop");
    const t = trackProgress({
      operation: "scan-stop",
      total: 10,
      intervalMs: 50,
    });
    t.stop();
    expect(() => t.stop()).not.toThrow();
  });

  it("requires install/setService first", () => {
    expect(() =>
      trackProgress({ operation: "x", total: 1 }),
    ).toThrow(/no service set/);
  });

  it("rejects bad opts", () => {
    setService("prog_test_bad");
    expect(() =>
      trackProgress({ operation: "", total: 1 }),
    ).toThrow(/operation/);
    expect(() =>
      trackProgress({ operation: "x", total: -1 }),
    ).toThrow(/total/);
    expect(() =>
      trackProgress({ operation: "x", total: 1, windowMs: 0 }),
    ).toThrow(/windowMs|intervalMs/);
    expect(() =>
      trackProgress({ operation: "x", total: 1, intervalMs: 0 }),
    ).toThrow(/windowMs|intervalMs/);
  });

  it("inc() rejects negative n", () => {
    setService("prog_test_neg");
    const t = trackProgress({ operation: "x", total: 10, intervalMs: 50 });
    try {
      expect(() => t.inc(-1)).toThrow(/n must/);
    } finally {
      t.stop();
    }
  });

  it("rejects NaN / Infinity / -Infinity intervals", () => {
    // NaN passes `<= 0` vacuously; Node's setInterval clamps Infinity
    // down to a 1ms timer with TimeoutOverflowWarning, recreating the
    // hot-loop bug intervalMs validation was supposed to prevent.
    setService("prog_test_nonfinite");
    expect(() =>
      trackProgress({ operation: "x", total: 1, intervalMs: NaN }),
    ).toThrow(/positive finite number/);
    expect(() =>
      trackProgress({ operation: "x", total: 1, intervalMs: Infinity }),
    ).toThrow(/positive finite number/);
    expect(() =>
      trackProgress({ operation: "x", total: 1, intervalMs: -Infinity }),
    ).toThrow(/positive finite number/);
    expect(() =>
      trackProgress({ operation: "x", total: 1, windowMs: NaN }),
    ).toThrow(/positive finite number/);
    expect(() =>
      trackProgress({ operation: "x", total: 1, windowMs: Infinity }),
    ).toThrow(/positive finite number/);
  });
});
