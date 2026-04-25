/**
 * Cardinality regression: 404/unmatched routes must collapse to one bucket.
 *
 * Scanner traffic (/wp-admin, /.env, etc.) must not produce one route label
 * per distinct probe path. Contract: route="__unmatched__" for any unrouted
 * request.
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { Hono } from "hono";
import { install, registry } from "../src/index.js";
import { _resetForTests as _resetProc } from "../src/process.js";
import { _resetForTests as _resetBase } from "../src/baseline.js";

describe("unmatched-route fallback", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  it("express: 404 paths collapse to route=__unmatched__", async () => {
    _resetProc();
    _resetBase();
    const app = express();
    install(app, { service: "express-unmatched", version: "0.0.0" });

    app.get("/known", (_req, res) => {
      res.status(200).send("ok");
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

        for (const path of [
          "/wp-admin",
          "/.env",
          "/wp-login.php",
          "/admin/.git/config",
        ]) {
          await fetch(`${base}${path}`);
        }
        const body = await (await fetch(`${base}/metrics`)).text();

        expect(body).toMatch(/route="__unmatched__"/);
        for (const leaked of [
          "/wp-admin",
          "/.env",
          "/wp-login.php",
          "/admin/.git/config",
        ]) {
          expect(body).not.toContain(`route="${leaked}"`);
        }

        server.close();
        resolve();
      });
    });
  });

  it("hono: unmatched routePath collapses to route=__unmatched__", async () => {
    _resetProc();
    _resetBase();
    const app = new Hono();
    install(app, { service: "hono-unmatched", version: "0.0.0" });

    app.get("/known", (c) => c.text("ok"));

    // Drive a few unmatched paths through the Hono fetch handler directly.
    for (const path of ["/wp-admin", "/.env", "/wp-login.php"]) {
      await app.fetch(new Request(`http://localhost${path}`));
    }
    const res = await app.fetch(new Request("http://localhost/metrics"));
    const body = await res.text();

    expect(body).toMatch(/route="__unmatched__"/);
    for (const leaked of ["/wp-admin", "/.env", "/wp-login.php"]) {
      expect(body).not.toContain(`route="${leaked}"`);
    }
  });
});
