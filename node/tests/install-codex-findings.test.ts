/**
 * Regression coverage for the v0.3.9 Codex audit findings:
 *
 *   F1 (Hono):    Partial install double-stacked the wildcard middleware on
 *                 retry — Codex repro showed simsys_http_requests_total{route="/hello"} == 2
 *                 after force-fail-then-retry. Fix gates handlers on
 *                 simsysMetricsInstalled and only wires app.use/app.get once.
 *
 *   F2 (Express): Pre-fix snapshot read app._router?.stack which is undefined
 *                 in Express 5; rollback no-opped, leaking a /metrics route
 *                 layer. Codex repro showed stack ["/metrics"] after fail
 *                 then ["/metrics", "/metrics", "mw"] after retry.
 *
 *   F3 (build_info): Two installs of the same service+version+commit started
 *                    in the same wall-clock second share a labelset
 *                    (started_at is second-precision). Pre-fix, install B's
 *                    rollback unconditionally called build_info.remove(...)
 *                    and silently deleted install A's still-live sample.
 *
 *   F4 (process collector): Pre-fix, a service-swap (install A=foo, install
 *                           B=bar) followed by B failing left the registry
 *                           with NO process collector at all — A's
 *                           simsys_process_* lines disappeared. Fix captures
 *                           the prior collector and re-registers it on
 *                           rollback.
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { Hono } from "hono";
import { install, registry } from "../src/index.js";
import {
  _resetForTests as _resetProc,
  registerProcessCollector,
  restoreProcessCollector,
} from "../src/process.js";
import { _resetForTests as _resetBase } from "../src/baseline.js";
import {
  registerBuildInfo,
  unregisterBuildInfoIfOwned,
  _resetBuildInfoOwnershipForTests,
} from "../src/buildinfo.js";

describe("Codex audit regressions (v0.3.9)", () => {
  beforeEach(() => {
    _resetProc();
    _resetBase();
    _resetBuildInfoOwnershipForTests();
    registry.resetMetrics();
  });

  it("F1: Hono retry after app.get failure does NOT double-stack middleware", async () => {
    const app = new Hono();

    // Patch app.get to throw exactly once — on install's internal
    // app.get(metricsPath) call. The retry's app.get(metricsPath) and
    // the post-install app.get("/hello", ...) both pass through.
    const realGet = app.get.bind(app);
    let getCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.get = ((...args: any[]) => {
      getCalls += 1;
      if (getCalls === 1) {
        throw new Error("forced hono get failure (codex F1 regression)");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realGet as any)(...args);
    }) as typeof app.get;

    expect(() =>
      install(app, { service: "hono-mw-dbl", version: "0.0.1" }),
    ).toThrow(/forced hono get failure/);

    // Sentinel must have rolled back so retry isn't no-opped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((app as any).simsysMetricsInstalled).toBeUndefined();

    install(app, { service: "hono-mw-dbl", version: "0.0.1" });

    // Register /hello AFTER install so the metrics middleware (registered
    // by install's app.use("*", ...)) precedes /hello's handler in
    // registration order — Hono runs handlers in registration order, so
    // a route registered before middleware would short-circuit before
    // the middleware could observe it.
    app.get("/hello", (c) => c.text("hi"));

    // Hit /hello exactly once.
    const helloRes = await app.fetch(new Request("http://l/hello"));
    expect(helloRes.status).toBe(200);

    // Scrape /metrics and verify the request-counter for /hello is 1, not 2.
    const res = await app.fetch(new Request("http://l/metrics"));
    expect(res.status).toBe(200);
    const body = await res.text();
    const counterLines = body
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("simsys_http_requests_total{") &&
          line.includes('route="/hello"') &&
          line.includes('service="hono-mw-dbl"'),
      );
    expect(counterLines).toHaveLength(1);
    const value = Number(counterLines[0].trim().split(/\s+/).pop());
    expect(value).toBe(1);
  });

  it("F2: Express 5 rollback after app.use failure truncates the router stack", async () => {
    const app = express();

    const realUse = app.use.bind(app);
    let useCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use = ((...args: any[]) => {
      useCalls += 1;
      if (useCalls === 1) {
        throw new Error("forced express use failure (codex F2 regression)");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realUse as any)(...args);
    }) as typeof app.use;

    expect(() =>
      install(app, { service: "express-stack", version: "0.0.1" }),
    ).toThrow(/forced express use failure/);

    // Express 5 stores the router at app.router; Express 4 lazily creates
    // app._router. Read whichever exists.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getStack = (a: any): any[] | undefined =>
      (a.router?.stack as any[] | undefined) ??
      (a._router?.stack as any[] | undefined);

    const stackAfterFail = getStack(app);
    if (stackAfterFail) {
      const leakedMetrics = stackAfterFail.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (layer: any) => layer?.route?.path === "/metrics",
      );
      expect(
        leakedMetrics,
        "F2: rollback did not truncate Express 5 router stack",
      ).toHaveLength(0);
    }

    // Retry succeeds; exactly one /metrics route registered.
    install(app, { service: "express-stack", version: "0.0.1" });
    const stack2 = getStack(app);
    expect(stack2).toBeDefined();
    const metricsLayers = stack2!.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (layer: any) => layer?.route?.path === "/metrics",
    );
    expect(metricsLayers).toHaveLength(1);

    // End-to-end smoke: /metrics returns the expected content.
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, async () => {
        try {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            server.close();
            resolve();
            return;
          }
          const fetchRes = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
          expect(fetchRes.status).toBe(200);
          const body = await fetchRes.text();
          expect(body).toContain('service="express-stack"');
          server.close();
          resolve();
        } catch (e) {
          server.close();
          reject(e);
        }
      });
    });
  });

  it("F3: rollback of a same-second build_info install does NOT delete prior install's sample", async () => {
    const labelsA = {
      service: "collide_svc",
      version: "1.0",
      commit: "abc",
      started_at: "2026-01-01T00:00:00Z",
    };
    const a = registerBuildInfo(labelsA);
    expect(a.wasNew).toBe(true);

    // Install B in the same second produces an identical labelset.
    const b = registerBuildInfo({ ...labelsA });
    expect(b.wasNew).toBe(false);

    // B's rollback runs unregisterBuildInfoIfOwned with wasNew=false →
    // must be a no-op so A's sample survives.
    unregisterBuildInfoIfOwned(b.labels, b.wasNew);

    const text = await registry.metrics();
    const liveLines = text
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("simsys_build_info{") &&
          line.includes('service="collide_svc"'),
      );
    expect(liveLines).toHaveLength(1);

    // A's rollback (wasNew=true) DOES remove it.
    unregisterBuildInfoIfOwned(a.labels, a.wasNew);
    const text2 = await registry.metrics();
    const liveLines2 = text2
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("simsys_build_info{") &&
          line.includes('service="collide_svc"'),
      );
    expect(liveLines2).toHaveLength(0);
  });

  it("F4: process collector swap-then-fail restores prior service's metrics", async () => {
    // Install A registers fresh.
    const stateA = registerProcessCollector("svc_a_proc");
    expect(stateA.action).toBe("registered");

    // After A, scraping must show service="svc_a_proc".
    let text = await registry.metrics();
    expect(text).toMatch(
      /simsys_process_uptime_seconds\{service="svc_a_proc"\}/,
    );

    // Install B service-swaps the singleton.
    const stateB = registerProcessCollector("svc_b_proc");
    expect(stateB.action).toBe("service-swap");
    if (stateB.action === "service-swap") {
      expect(stateB.priorService).toBe("svc_a_proc");
    }

    // After swap, samples carry service="svc_b_proc"; svc_a_proc gone.
    text = await registry.metrics();
    expect(text).toMatch(
      /simsys_process_uptime_seconds\{service="svc_b_proc"\}/,
    );
    expect(text).not.toMatch(
      /simsys_process_uptime_seconds\{service="svc_a_proc"\}/,
    );

    // Roll back B (simulates B's install_install failing post-swap).
    restoreProcessCollector(stateB);

    // Now A's process metrics must flow again; B's must be gone.
    text = await registry.metrics();
    expect(text).toMatch(
      /simsys_process_uptime_seconds\{service="svc_a_proc"\}/,
    );
    expect(text).not.toMatch(
      /simsys_process_uptime_seconds\{service="svc_b_proc"\}/,
    );
  });
});
