/**
 * trackQueue must reject non-positive intervalMs values loudly.
 *
 * setInterval(fn, 0) creates a hot loop that pegs the event loop. Pre-fix
 * the value was passed through unchecked, so a misconfigured consumer
 * could silently melt their worker. v0.3.6 adds an explicit guard.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { trackQueue, setService } from "../src/baseline.js";
import { _resetForTests as _resetBase } from "../src/baseline.js";
import { registry } from "../src/registry.js";

describe("trackQueue intervalMs validation", () => {
  beforeEach(() => {
    _resetBase();
    registry.resetMetrics();
    setService("queue-interval-test");
  });

  it("rejects intervalMs = 0", () => {
    expect(() =>
      trackQueue("q0", { depthFn: () => 1, intervalMs: 0 }),
    ).toThrow(/positive finite number/);
  });

  it("rejects negative intervalMs", () => {
    expect(() =>
      trackQueue("qNeg", { depthFn: () => 1, intervalMs: -100 }),
    ).toThrow(/positive finite number/);
  });

  it("rejects NaN / Infinity", () => {
    expect(() =>
      trackQueue("qNaN", { depthFn: () => 1, intervalMs: NaN }),
    ).toThrow(/positive finite number/);
    expect(() =>
      trackQueue("qInf", { depthFn: () => 1, intervalMs: Infinity }),
    ).toThrow(/positive finite number/);
  });

  it("accepts a normal positive intervalMs", () => {
    // Should NOT throw — and we capture the timer so we can clean up.
    const timer = trackQueue("qOk", { depthFn: () => 1, intervalMs: 1000 });
    clearInterval(timer);
  });
});
