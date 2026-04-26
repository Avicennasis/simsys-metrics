/**
 * Regression coverage for the v0.3.10 self-audit findings (Node side):
 *
 *   F8 (process collector swap reset / collect race): Pre-fix, the swap
 *       path zeroed lastCpuSeconds AND called cpuTotal.reset(). Combined
 *       with the .reset()-on-rollback, Prometheus would see a counter
 *       reset followed by a spike to the full process-cumulative CPU.
 *       Fix replaces .reset() with .remove({service: priorService}) and
 *       preserves lastCpuSeconds, keeping the live counter monotonic.
 *
 *   F9 (Hono basePath()): Pre-fix, the metrics-path exemption check
 *       compared c.req.path === livePath where livePath was the
 *       install-time `metricsPath` argument. With app.basePath("/api"),
 *       requests arrive at /api/metrics and the exemption fails.
 *       Fix derives the absolute metrics URL from app._basePath at
 *       install time and stores it as simsysMetricsPath.
 *
 *   F11 (counter-reset artifact, paired with F8): same root cause as F8;
 *        verified by the same test suite below.
 *
 *   F12 (Hono idempotency warning): Pre-fix, only service/version
 *        triggered the warning on second-install mismatch. Now
 *        metricsPath is also part of the comparison.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { install, registry } from "../src/index.js";
import {
  _resetForTests as _resetProc,
  registerProcessCollector,
} from "../src/process.js";
import { _resetForTests as _resetBase } from "../src/baseline.js";
import { _resetBuildInfoOwnershipForTests } from "../src/buildinfo.js";

describe("v0.3.10 self-audit regressions", () => {
  beforeEach(() => {
    _resetProc();
    _resetBase();
    _resetBuildInfoOwnershipForTests();
    registry.resetMetrics();
  });

  it("F8/F11: service-swap removes prior labelset without resetting the counter", async () => {
    // Register service A; its CPU counter accumulates a delta.
    registerProcessCollector("counter_a");
    let text = await registry.metrics();
    // Counter exists for service A.
    expect(text).toMatch(
      /simsys_process_cpu_seconds_total\{service="counter_a"\}/,
    );

    // Capture the counter's value for service A.
    const beforeSwap = parseFloat(
      text
        .split("\n")
        .find((l) =>
          l.startsWith('simsys_process_cpu_seconds_total{service="counter_a"}'),
        )!
        .trim()
        .split(/\s+/)
        .pop()!,
    );
    expect(beforeSwap).toBeGreaterThan(0);

    // Service-swap to B. Pre-fix: cpuTotal.reset() zeros every
    // labelset; lastCpuSeconds = 0 means the next collect inc()s by
    // full cumulative. Post-fix: only A's labelset is removed, B
    // starts with a small delta.
    registerProcessCollector("counter_b");
    text = await registry.metrics();

    // A's labelset must be gone (we explicitly .remove'd it).
    expect(text).not.toMatch(
      /simsys_process_cpu_seconds_total\{service="counter_a"\}/,
    );

    // B's counter should be SMALL (just the delta since the swap),
    // not roughly equal to the process's cumulative CPU. Pre-fix
    // (.reset() + lastCpuSeconds=0), B would show ~beforeSwap.
    const bLine = text
      .split("\n")
      .find((l) =>
        l.startsWith('simsys_process_cpu_seconds_total{service="counter_b"}'),
      );
    expect(bLine).toBeDefined();
    const bValue = parseFloat(bLine!.trim().split(/\s+/).pop()!);
    // B's value should be much less than A's pre-swap value (which
    // is the full cumulative CPU at swap time). A spike would put B
    // near beforeSwap.
    expect(bValue).toBeLessThan(beforeSwap);
  });

  it("F9: Hono basePath() — metrics-path exemption compares against the absolute URL", async () => {
    const app = new Hono().basePath("/api");
    install(app, {
      service: "basepath-test",
      version: "0.0.1",
      metricsPath: "/metrics",
    });

    // Register a normal handler under the basePath.
    app.get("/hello", (c) => c.text("hi"));

    // Hit /api/hello once.
    const helloRes = await app.fetch(new Request("http://l/api/hello"));
    expect(helloRes.status).toBe(200);

    // Hit /api/metrics — this MUST be excluded from request counting,
    // not counted as an instrumented request. Pre-fix, c.req.path was
    // "/api/metrics" but livePath was "/metrics", so the exemption
    // failed and /api/metrics got recorded against
    // route="__unmatched__" or similar.
    const metricsRes = await app.fetch(new Request("http://l/api/metrics"));
    expect(metricsRes.status).toBe(200);
    const body = await metricsRes.text();

    // No request-counter line should mention the metrics route.
    const metricsLines = body
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("simsys_http_requests_total{") &&
          (l.includes('route="/metrics"') ||
            l.includes('route="/api/metrics"')),
      );
    expect(metricsLines).toHaveLength(0);

    // The /hello counter should be exactly 1. Hono with basePath
    // sets c.req.routePath to the routing-relative path, which may be
    // either "/hello" or "/api/hello" depending on Hono version —
    // accept either.
    const allRequestLines = body
      .split("\n")
      .filter((l) => l.startsWith("simsys_http_requests_total{"));
    const helloCounter = allRequestLines.filter(
      (l) => l.includes('route="/hello"') || l.includes('route="/api/hello"'),
    );
    expect(
      helloCounter.length,
      `expected one /hello counter line; got ${helloCounter.length}. all request lines:\n${allRequestLines.join("\n")}`,
    ).toBe(1);
    expect(parseFloat(helloCounter[0].trim().split(/\s+/).pop()!)).toBe(1);
  });

  it("F12: Hono idempotency warning fires on metricsPath mismatch", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = new Hono();
      install(app, {
        service: "idem-mp",
        version: "1.0",
        metricsPath: "/m1",
      });
      // Same service/version but different metricsPath — must warn.
      install(app, {
        service: "idem-mp",
        version: "1.0",
        metricsPath: "/m2",
      });
      expect(warnSpy).toHaveBeenCalled();
      // The warning message should mention metricsPath.
      const warnArg = warnSpy.mock.calls[0]?.[0] as string | undefined;
      expect(warnArg).toContain("metricsPath");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("F12: Hono idempotency warning still SILENT when all params match", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const app = new Hono();
      install(app, {
        service: "idem-ok",
        version: "1.0",
        metricsPath: "/m",
      });
      install(app, {
        service: "idem-ok",
        version: "1.0",
        metricsPath: "/m",
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
