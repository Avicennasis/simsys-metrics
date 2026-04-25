/**
 * HTTP method label must collapse to a bounded allow-list.
 *
 * Pre-fix the raw `req.method` / `c.req.method` was passed straight
 * through, so a hostile client sending arbitrary methods like
 * `X_AUDIT_1`, `ASDF`, etc. would force one new
 * simsys_http_requests_total series per unique method value.
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { Hono } from "hono";
import { install, registry } from "../src/index.js";
import { normalizeMethod } from "../src/registry.js";
import { _resetForTests as _resetProc } from "../src/process.js";
import { _resetForTests as _resetBase } from "../src/baseline.js";

describe("HTTP method normalization", () => {
  beforeEach(() => {
    _resetProc();
    _resetBase();
    registry.resetMetrics();
  });

  it("normalizeMethod unit cases", () => {
    expect(normalizeMethod("GET")).toBe("GET");
    expect(normalizeMethod("get")).toBe("GET");
    expect(normalizeMethod("Post")).toBe("POST");
    expect(normalizeMethod("PATCH")).toBe("PATCH");
    expect(normalizeMethod("OPTIONS")).toBe("OPTIONS");
    expect(normalizeMethod("X_AUDIT_1")).toBe("OTHER");
    expect(normalizeMethod("ASDF")).toBe("OTHER");
    expect(normalizeMethod("")).toBe("OTHER");
    expect(normalizeMethod(undefined)).toBe("OTHER");
    expect(normalizeMethod(null)).toBe("OTHER");
    expect(normalizeMethod(123)).toBe("OTHER");
  });

  it("express: non-allow-listed methods collapse to method=OTHER", async () => {
    const app = express();
    install(app, { service: "express-method-norm", version: "0.0.0" });
    // Catch-all route so Express actually responds to unusual methods —
    // the cardinality fix is applied on the metric path, regardless of
    // whether the route 200s or 404s.
    app.all("/", (_req, res) => res.status(200).send("ok"));

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, async () => {
        try {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            server.close();
            resolve();
            return;
          }
          const base = `http://127.0.0.1:${addr.port}`;

          // BREW (RFC 2324) and MKCALENDAR (CalDAV) are valid HTTP tokens
          // but not in the allow-list. fetch accepts arbitrary tokens.
          for (const garbage of ["BREW", "MKCALENDAR", "PROPFIND"]) {
            await fetch(`${base}/`, { method: garbage });
          }

          const body = await (await fetch(`${base}/metrics`)).text();

          for (const garbage of ["BREW", "MKCALENDAR", "PROPFIND"]) {
            expect(body).not.toContain(`method="${garbage}"`);
          }
          expect(body).toMatch(/method="OTHER"/);

          server.close();
          resolve();
        } catch (err) {
          server.close();
          reject(err);
        }
      });
    });
  });

  it("hono: garbage methods collapse to method=OTHER", async () => {
    const app = new Hono();
    install(app, { service: "hono-method-norm", version: "0.0.0" });
    app.get("/known", (c) => c.text("ok"));

    await app.fetch(new Request("http://l/known"));

    for (const garbage of ["X_AUDIT_1", "ASDF", "UNDEFINED"]) {
      await app.fetch(new Request("http://l/x", { method: garbage }));
    }

    const body = await (await app.fetch(new Request("http://l/metrics"))).text();
    for (const garbage of ["X_AUDIT_1", "ASDF", "UNDEFINED"]) {
      expect(body).not.toContain(`method="${garbage}"`);
    }
    expect(body).toMatch(/method="OTHER"/);
  });
});
