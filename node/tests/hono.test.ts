import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { install, registry, trackJob, safeLabel } from "../src/index.js";
import { _resetForTests as _resetProc } from "../src/process.js";
import { _resetForTests as _resetBase } from "../src/baseline.js";

describe("hono adapter", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  it("mounts /metrics via app.fetch() and includes simsys_build_info", async () => {
    _resetProc();
    _resetBase();
    const app = new Hono();
    install(app, { service: "test-hono", version: "0.0.0" });

    app.get("/hello", (c) => c.text("hi", 200));

    // Drive one request so http metrics are populated.
    const helloRes = await app.fetch(new Request("http://localhost/hello"));
    expect(helloRes.status).toBe(200);

    const metricsRes = await app.fetch(new Request("http://localhost/metrics"));
    expect(metricsRes.status).toBe(200);
    const ct = metricsRes.headers.get("content-type") || "";
    expect(ct).toMatch(/text\/plain/);
    const body = await metricsRes.text();

    expect(body).toContain("simsys_build_info");
    expect(body).toContain('service="test-hono"');
    expect(body).toContain("simsys_http_requests_total");
    expect(body).not.toMatch(/route="\/metrics"/);
  });

  it("trackJob records success and error outcomes (async)", async () => {
    _resetProc();
    _resetBase();
    const app = new Hono();
    install(app, { service: "job-hono", version: "0.0.0" });

    const ok = trackJob("demo")(async () => 42);
    const v = await ok();
    expect(v).toBe(42);

    const fail = trackJob("demo")(async () => {
      throw new Error("boom");
    });
    await expect(fail()).rejects.toThrow("boom");

    const body = await registry.metrics();
    expect(body).toMatch(/simsys_jobs_total\{[^}]*outcome="success"/);
    expect(body).toMatch(/simsys_jobs_total\{[^}]*outcome="error"/);
  });

  it("safeLabel collapses unknown values to 'other'", () => {
    expect(safeLabel("AAPL", new Set(["AAPL", "GOOG"]))).toBe("AAPL");
    expect(safeLabel("XYZ", new Set(["AAPL", "GOOG"]))).toBe("other");
    expect(safeLabel(null, new Set(["AAPL"]))).toBe("other");
    expect(safeLabel(undefined, ["AAPL"])).toBe("other");
  });
});
