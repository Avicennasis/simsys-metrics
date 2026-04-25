import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { install, registry } from "../src/index.js";
import { _resetForTests as _resetProc } from "../src/process.js";
import { _resetForTests as _resetBase } from "../src/baseline.js";

describe("express adapter", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  it("mounts /metrics and serves Prometheus text-format", async () => {
    _resetProc();
    _resetBase();
    const app = express();
    install(app, { service: "test-express", version: "0.0.0" });

    app.get("/hello", (_req, res) => {
      res.status(200).send("hi");
    });

    // Drive one request so http metrics are populated.
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
        const res = await fetch(`${base}/metrics`);

        expect(res.status).toBe(200);
        const ct = res.headers.get("content-type") || "";
        expect(ct).toMatch(/text\/plain/);
        const body = await res.text();
        expect(body).toContain("simsys_build_info");
        expect(body).toContain('service="test-express"');
        expect(body).toContain("simsys_http_requests_total");
        // /metrics itself should NOT be recorded as an HTTP request.
        expect(body).not.toMatch(/route="\/metrics"/);

        server.close();
        resolve();
      });
    });
  });

  it("refuses non-simsys metric names at registration", async () => {
    const { makeCounter } = await import("../src/registry.js");
    expect(() => makeCounter("bad_name", "nope")).toThrow(/simsys_/);
  });
});
