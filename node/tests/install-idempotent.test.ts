/**
 * install() must be idempotent across both Express and Hono adapters.
 *
 * v0.3.2 and earlier added a second middleware AND a second /metrics
 * route on every install() call — meaning a single request was
 * counted TWICE on second-install, and N+1 times on Nth install. This
 * test pins the contract that a second install() is a no-op and one
 * request produces exactly count=1.
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { Hono } from "hono";
import { install, registry } from "../src/index.js";
import { _resetForTests as _resetProc } from "../src/process.js";
import { _resetForTests as _resetBase } from "../src/baseline.js";

describe("install idempotency", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  it("express: second install does not double-count requests", async () => {
    _resetProc();
    _resetBase();

    const app = express();
    install(app, { service: "express-idem", version: "0.0.0" });
    // Second install on the same app — must be a no-op.
    install(app, { service: "express-idem", version: "0.0.0" });

    app.get("/hello", (_req, res) => {
      res.status(200).send("hi");
    });

    await new Promise<void>((resolve) => {
      const server = app.listen(0, async () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          server.close();
          resolve();
          return;
        }
        const base = `http://127.0.0.1:${addr.port}`;

        await fetch(`${base}/hello`);
        const body = await (await fetch(`${base}/metrics`)).text();

        const matches = body
          .split("\n")
          .filter(
            (l) =>
              l.startsWith("simsys_http_requests_total") &&
              l.includes('route="/hello"') &&
              l.includes('service="express-idem"'),
          );
        expect(matches.length).toBe(1);
        // Counter value must be exactly 1, not 2 (which would mean the
        // request was recorded by both middleware copies).
        const value = Number(matches[0].split(" ").pop());
        expect(value).toBe(1);

        server.close();
        resolve();
      });
    });
  });

  it("express: install() flag set + version stored", () => {
    _resetProc();
    _resetBase();

    const app = express();
    install(app, { service: "flag-test", version: "1.2.3" });

    expect(app.locals.simsysMetricsInstalled).toBe(true);
    expect(app.locals.simsysService).toBe("flag-test");
    expect(app.locals.simsysVersion).toBe("1.2.3");
  });

  it("express: install() with different service warns", () => {
    _resetProc();
    _resetBase();

    const warnings: string[] = [];
    const origWarn = console.warn;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console.warn = (...args: any[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const app = express();
      install(app, { service: "first", version: "1.0.0" });
      install(app, { service: "second", version: "2.0.0" });

      expect(warnings.some((w) => w.includes("different service/version"))).toBe(
        true,
      );
      // Original install wins.
      expect(app.locals.simsysService).toBe("first");
    } finally {
      console.warn = origWarn;
    }
  });

  it("hono: second install does not double-count requests", async () => {
    _resetProc();
    _resetBase();

    const app = new Hono();
    install(app, { service: "hono-idem", version: "0.0.0" });
    install(app, { service: "hono-idem", version: "0.0.0" });

    app.get("/hello", (c) => c.text("hi"));

    await app.fetch(new Request("http://l/hello"));
    const body = await (await app.fetch(new Request("http://l/metrics"))).text();

    const matches = body
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("simsys_http_requests_total") &&
          l.includes('route="/hello"') &&
          l.includes('service="hono-idem"'),
      );
    expect(matches.length).toBe(1);
    const value = Number(matches[0].split(" ").pop());
    expect(value).toBe(1);
  });

  it("hono: install() flag set + version stored", () => {
    _resetProc();
    _resetBase();

    const app = new Hono();
    install(app, { service: "hono-flag", version: "9.9.9" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = app as any;
    expect(props.simsysMetricsInstalled).toBe(true);
    expect(props.simsysService).toBe("hono-flag");
    expect(props.simsysVersion).toBe("9.9.9");
  });
});
