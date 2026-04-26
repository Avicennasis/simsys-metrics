/**
 * Next.js adapter — installNext() patches http.Server.prototype.emit before
 * Next constructs its server, captures request finishes, and emits the same
 * simsys baseline as the Express + Hono adapters.
 *
 * Tests use a raw http.Server because Next.js standalone is too heavy for
 * unit tests. The contract under test is "every request through ANY
 * http.Server is recorded after installNext()" — Next is just one consumer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { registry } from "../src/index.js";
import { _resetForTests as _resetProc } from "../src/process.js";
import { _resetForTests as _resetBase } from "../src/baseline.js";
import { _resetBuildInfoOwnershipForTests } from "../src/buildinfo.js";

// Save the pristine emit so each test can restore it. installNext() patches
// http.Server.prototype.emit; if a test crashes mid-flight we must un-patch
// before the next test runs.
const ORIG_HTTP_EMIT = http.Server.prototype.emit;

function resetAll() {
  registry.resetMetrics();
  _resetProc();
  _resetBase();
  _resetBuildInfoOwnershipForTests();
  // Drop any installNext() sentinel + patch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__simsysNextInstalled = false;
  http.Server.prototype.emit = ORIG_HTTP_EMIT;
}

async function driveRequest(
  server: http.Server,
  path: string,
): Promise<number> {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("server has no address");
  }
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  await res.text();
  return res.status;
}

function startServer(
  handler: http.RequestListener,
): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve(server));
  });
}

describe("next adapter", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  it("registers simsys_build_info with the supplied service + version", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({ service: "test-next", version: "1.2.3" });

    const body = await registry.metrics();
    expect(body).toContain("simsys_build_info");
    expect(body).toContain('service="test-next"');
    expect(body).toContain('version="1.2.3"');
  });

  it("records HTTP requests to a vanilla http.Server after installNext()", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({ service: "next-http", version: "0.0.0" });

    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hi");
    });

    try {
      const status = await driveRequest(server, "/hello");
      expect(status).toBe(200);

      const body = await registry.metrics();
      expect(body).toMatch(/simsys_http_requests_total\{[^}]*service="next-http"/);
      expect(body).toMatch(/simsys_http_request_duration_seconds/);
    } finally {
      server.close();
    }
  });

  it("does not record /api/metrics in HTTP request counts", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({ service: "next-exempt", version: "0.0.0" });

    const server = await startServer((req, res) => {
      // Mimic Next: serve the metrics body when its route is hit.
      if (req.url === "/api/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("# served by app");
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });

    try {
      await driveRequest(server, "/api/metrics");
      await driveRequest(server, "/regular");

      const body = await registry.metrics();
      // /api/metrics must NOT appear as a route label.
      expect(body).not.toMatch(/route="\/api\/metrics"/);
      // /regular SHOULD appear (bucketed unchanged — it's a single segment).
      expect(body).toMatch(/route="\/regular"/);
    } finally {
      server.close();
    }
  });

  it("buckets numeric path segments to :id to bound cardinality", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({ service: "next-bucket", version: "0.0.0" });

    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    try {
      await driveRequest(server, "/api/shifts/12345");
      await driveRequest(server, "/api/shifts/67890");
      await driveRequest(server, "/api/shifts/1");

      const body = await registry.metrics();
      expect(body).toMatch(/route="\/api\/shifts\/:id"/);
      // Numeric ids must NOT survive as their own labels.
      expect(body).not.toContain('route="/api/shifts/12345"');
      expect(body).not.toContain('route="/api/shifts/67890"');
    } finally {
      server.close();
    }
  });

  it("buckets UUID path segments to :uuid", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({ service: "next-uuid", version: "0.0.0" });

    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    try {
      await driveRequest(
        server,
        "/api/applicants/3f8b6c4a-1d2e-4f5b-9a8c-7e1f0d2a3b4c",
      );
      const body = await registry.metrics();
      expect(body).toMatch(/route="\/api\/applicants\/:uuid"/);
      expect(body).not.toContain(
        'route="/api/applicants/3f8b6c4a-1d2e-4f5b-9a8c-7e1f0d2a3b4c"',
      );
    } finally {
      server.close();
    }
  });

  it("collapses paths with > 5 segments to first-2-segments to bound cardinality", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({ service: "next-deep", version: "0.0.0" });

    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    try {
      await driveRequest(server, "/a/b/c/d/e/f/g/h");
      const body = await registry.metrics();
      // Default fallback for long paths: collapse to first two segments + /__deep__
      expect(body).toMatch(/route="\/a\/b\/__deep__"/);
    } finally {
      server.close();
    }
  });

  it("strips query strings before bucketing", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({ service: "next-qs", version: "0.0.0" });

    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    try {
      await driveRequest(server, "/page?foo=bar&id=123");
      const body = await registry.metrics();
      expect(body).toMatch(/route="\/page"/);
      expect(body).not.toContain("foo=bar");
    } finally {
      server.close();
    }
  });

  it("respects routeTemplates for high-fidelity custom labels", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({
      service: "next-tmpl",
      version: "0.0.0",
      routeTemplates: [
        { pattern: /^\/api\/users\/[^/]+\/profile$/, template: "/api/users/:user/profile" },
      ],
    });

    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    try {
      await driveRequest(server, "/api/users/alice/profile");
      await driveRequest(server, "/api/users/bob/profile");

      const body = await registry.metrics();
      expect(body).toMatch(/route="\/api\/users\/:user\/profile"/);
      expect(body).not.toContain('route="/api/users/alice/profile"');
      expect(body).not.toContain('route="/api/users/bob/profile"');
    } finally {
      server.close();
    }
  });

  it("is idempotent — second installNext() does not double-count", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({ service: "next-idem", version: "0.0.0" });
    // Second call must be a no-op.
    installNext({ service: "next-idem", version: "0.0.0" });

    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    try {
      await driveRequest(server, "/once");
      const body = await registry.metrics();
      const matches = body
        .split("\n")
        .filter(
          (l) =>
            l.startsWith("simsys_http_requests_total") &&
            l.includes('route="/once"') &&
            l.includes('service="next-idem"'),
        );
      expect(matches.length).toBe(1);
      const value = Number(matches[0].split(" ").pop());
      expect(value).toBe(1);
    } finally {
      server.close();
    }
  });

  it("normalizes status into bucket labels (2xx/4xx/5xx)", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({ service: "next-status", version: "0.0.0" });

    const server = await startServer((req, res) => {
      if (req.url === "/notfound") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/oops") {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    });

    try {
      await driveRequest(server, "/ok");
      await driveRequest(server, "/notfound");
      await driveRequest(server, "/oops");

      const body = await registry.metrics();
      expect(body).toMatch(/status="2xx"/);
      expect(body).toMatch(/status="4xx"/);
      expect(body).toMatch(/status="5xx"/);
    } finally {
      server.close();
    }
  });

  it("normalizes method into the simsys allow-list (GET, POST, …, OTHER)", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({ service: "next-method", version: "0.0.0" });

    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });

    try {
      await driveRequest(server, "/std");
      const body = await registry.metrics();
      expect(body).toMatch(/method="GET"/);
    } finally {
      server.close();
    }
  });
});

describe("next adapter validation + hot-reload", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  it("rejects empty service", async () => {
    const { installNext } = await import("../src/index.js");
    expect(() =>
      installNext({ service: "", version: "1.0.0" }),
    ).toThrow(/service must be a non-empty string/);
  });

  it("rejects empty version", async () => {
    const { installNext } = await import("../src/index.js");
    expect(() =>
      installNext({ service: "x", version: "" }),
    ).toThrow(/version must be a non-empty string/);
  });

  it("rejects null/undefined opts", async () => {
    const { installNext } = await import("../src/index.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => installNext(null as any)).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => installNext(undefined as any)).toThrow();
  });

  it("re-installs cleanly after sentinel reset (hot-reload simulation)", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({ service: "hot-1", version: "1.0.0" });

    // Simulate Next dev-mode hot-reload clearing the sentinel.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__simsysNextInstalled = false;

    // Second install with a different service should now succeed.
    installNext({ service: "hot-2", version: "2.0.0" });

    const body = await registry.metrics();
    expect(body).toMatch(/simsys_build_info\{[^}]*service="hot-2"/);
    expect(body).toMatch(/version="2.0.0"/);
  });
});

describe("bucketRoute (pure)", () => {
  it("preserves single-segment routes verbatim", async () => {
    const { bucketRoute } = await import("../src/index.js");
    expect(bucketRoute("/page")).toBe("/page");
    expect(bucketRoute("/about")).toBe("/about");
  });

  it("handles root path", async () => {
    const { bucketRoute } = await import("../src/index.js");
    expect(bucketRoute("/")).toBe("/");
    expect(bucketRoute("")).toBe("/");
  });

  it("strips both query string and fragment", async () => {
    const { bucketRoute } = await import("../src/index.js");
    expect(bucketRoute("/x?a=1#frag")).toBe("/x");
    expect(bucketRoute("/x#frag")).toBe("/x");
  });

  it("templates win over default bucketing even when default would also match", async () => {
    const { bucketRoute } = await import("../src/index.js");
    // /api/foo/12345 would default-bucket to /api/foo/:id; the custom
    // template matches exactly the same shape but emits a different label.
    const tmpl = [
      { pattern: /^\/api\/foo\/\d+$/, template: "/api/foo/:fooId" },
    ];
    expect(bucketRoute("/api/foo/12345", tmpl)).toBe("/api/foo/:fooId");
  });
});

describe("next route handler", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  it("GET handler returns Prometheus text-format with current registry contents", async () => {
    const { installNext } = await import("../src/index.js");
    installNext({ service: "route-handler", version: "9.9.9" });

    const { GET } = await import("../src/adapters/next-route.js");
    const res = await GET();

    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toContain("simsys_build_info");
    expect(body).toContain('service="route-handler"');
  });
});
