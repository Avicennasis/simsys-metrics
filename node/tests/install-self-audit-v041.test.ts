/**
 * Regression coverage for the v0.4.1 self-audit findings (Node only):
 *
 *   F17 — Hot-reload + sentinel-clear must NOT double-patch
 *         http.Server.prototype.emit. v0.4.0 captured the live `emit`
 *         as `origEmit`; if the live `emit` was already our prior
 *         patch (because a consumer cleared the sentinel without
 *         restoring), we'd stack a second patch and double-count.
 *         Fix: cache the TRUE original on first install in
 *         globalThis.__simsysNextOrigEmit and reuse on subsequent
 *         installs.
 *
 *   F19 — registerNodeDefaultMetrics now refreshes setDefaultLabels
 *         on every call. Previously it short-circuited on
 *         defaultMetricsRegistered=true and the prior service's
 *         label persisted on every default metric.
 *
 *   F20/F21 — bucketRoute hardening: mixed-alphanumeric / slug /
 *             percent-encoded segments collapse to ":str".
 *
 *   F24 — bucketRoute path-length cap (8KB → "/__toolong__").
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registry } from "../src/index.js";
import { _resetForTests as _resetProc } from "../src/process.js";
import { _resetForTests as _resetBase } from "../src/baseline.js";
import { _resetBuildInfoOwnershipForTests } from "../src/buildinfo.js";

const ORIG_HTTP_EMIT = http.Server.prototype.emit;

function resetAll(): void {
  http.Server.prototype.emit = ORIG_HTTP_EMIT;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__simsysNextInstalled;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__simsysNextOrigEmit;
  _resetProc();
  _resetBase();
  _resetBuildInfoOwnershipForTests();
  registry.resetMetrics();
  registry.setDefaultLabels({});
}

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function driveRequest(server: http.Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as AddressInfo;
    const req = http.request(
      { host: "127.0.0.1", port: addr.port, path, method: "GET" },
      (res) => {
        res.on("data", () => undefined);
        res.on("end", () => resolve());
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("v0.4.1 self-audit regressions", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  it("F17: hot-reload after sentinel-clear does NOT double-patch emit", async () => {
    const { installNext } = await import("../src/index.js");

    // First install — captures the true original emit and patches.
    installNext({ service: "f17-first", version: "1.0.0" });

    // Simulate a hot-reload that explicitly clears the sentinel WITHOUT
    // restoring http.Server.prototype.emit. (Real Next dev mode keeps
    // the sentinel set, but a consumer doing manual re-init is exactly
    // the pre-fix vector.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__simsysNextInstalled;

    // Second install — pre-fix, this would re-capture the LIVE emit
    // (which is our first patch) as origEmit and stack a second
    // patch. Post-fix, globalThis.__simsysNextOrigEmit holds the TRUE
    // original from the first install, so the second install layers
    // its patch directly on the Node built-in.
    installNext({ service: "f17-second", version: "1.0.0" });

    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    try {
      await driveRequest(server, "/once");
      // Wait for finalize to fire.
      await new Promise((r) => setTimeout(r, 50));
      const body = await registry.metrics();
      const lines = body
        .split("\n")
        .filter(
          (l) =>
            l.startsWith("simsys_http_requests_total{") &&
            l.includes('route="/once"'),
        );
      // Pre-fix: lines.length would still be 1 (one labelset), but the
      // counter VALUE would be 2 (two finalize closures fired). Fix: 1.
      expect(lines).toHaveLength(1);
      const value = Number(lines[0].trim().split(/\s+/).pop());
      expect(
        value,
        `pre-fix bug: emit was double-patched on hot-reload, finalize fired twice per request. Got value=${value}, expected 1.`,
      ).toBe(1);
    } finally {
      server.close();
    }
  });

  it("F19: registerNodeDefaultMetrics refreshes default labels on swap", async () => {
    const { installNext } = await import("../src/index.js");

    installNext({ service: "f19-a", version: "1.0.0" });
    let body = await registry.metrics();
    expect(body).toMatch(/process_cpu_user_seconds_total\{service="f19-a"\}/);

    // Simulate a hot-reload to a new service name.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__simsysNextInstalled;
    installNext({ service: "f19-b", version: "1.0.0" });

    body = await registry.metrics();
    // The default `process_*` / `nodejs_*` metrics must now carry
    // service="f19-b". Pre-fix, registerNodeDefaultMetrics no-opped on
    // the second call, leaving the registry's default labels at
    // service="f19-a" — process_cpu_user_seconds_total would still
    // emit service="f19-a".
    expect(
      body,
      "default metrics should now carry the swapped service label",
    ).toMatch(/process_cpu_user_seconds_total\{service="f19-b"\}/);
    expect(body).not.toMatch(
      /process_cpu_user_seconds_total\{service="f19-a"\}/,
    );
  });

  it("F20: bucketRoute collapses mixed-alphanumeric / slug segments to :str", async () => {
    const { bucketRoute } = await import("../src/index.js");
    // Slug-style IDs like ORD-9981, JWT tokens, base64 tokens — any
    // mixed-alphanumeric segment is a cardinality vector pre-fix.
    expect(bucketRoute("/api/orders/ORD-9981")).toBe("/api/orders/:str");
    expect(bucketRoute("/api/tokens/eyJhbGciOi.payload.sig")).toBe(
      "/api/tokens/:str",
    );
    // Single uppercase letter — not in the safe-text-segment regex.
    expect(bucketRoute("/api/A")).toBe("/api/:str");
    // Long lowercase string — exceeds 32-char limit.
    expect(bucketRoute("/api/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      "/api/:str",
    );
    // Numeric ID still collapses to :id (not :str).
    expect(bucketRoute("/api/orders/12345")).toBe("/api/orders/:id");
  });

  it("F21: bucketRoute decodes percent-encoded segments before classifying", async () => {
    const { bucketRoute } = await import("../src/index.js");
    // %41 = 'A' — without decoding, "/%41" would pass through verbatim
    // and produce a different label than "/A".
    expect(bucketRoute("/api/data/%41")).toBe(bucketRoute("/api/data/A"));
    // Numeric encoded as percent literal — decoding a single byte
    // shouldn't change its classification (digit → :id).
    expect(bucketRoute("/api/items/%31%32%33")).toBe("/api/items/:id");
    // Malformed percent-encoding falls through to raw classification.
    // "/api/items/%" has a lone % which decodeURIComponent rejects;
    // the raw "%" is also non-safe → :str.
    expect(bucketRoute("/api/items/%")).toBe("/api/items/:str");
  });

  it("F24: paths exceeding 8KB short-circuit to /__toolong__", async () => {
    const { bucketRoute } = await import("../src/index.js");
    const longPath = "/" + "a".repeat(10000);
    expect(bucketRoute(longPath)).toBe("/__toolong__");
    // Just under the limit still works normally.
    const shortPath = "/" + "a".repeat(20);
    expect(bucketRoute(shortPath)).toBe(shortPath);
  });

  it("F20: existing bucketRoute behaviour preserved (regression guard)", async () => {
    const { bucketRoute } = await import("../src/index.js");
    // Pre-existing assertions from next.test.ts must still pass.
    expect(bucketRoute("/")).toBe("/");
    expect(bucketRoute("")).toBe("/");
    expect(bucketRoute("/page")).toBe("/page");
    expect(bucketRoute("/about")).toBe("/about");
    expect(bucketRoute("/x?a=1#frag")).toBe("/x");
    // Numeric / UUID classification unchanged.
    expect(bucketRoute("/api/users/12345")).toBe("/api/users/:id");
    expect(
      bucketRoute("/api/applicants/3f8b6c4a-1d2e-4f5b-9a8c-7e1f0d2a3b4c"),
    ).toBe("/api/applicants/:uuid");
  });
});
