/**
 * CJS resolution test.
 *
 * The 4 BFR Express apps + pixelops are CommonJS — `require('@simsys/metrics')`
 * is the only ergonomic way to install before any other middleware is
 * registered. v0.4.1 ships a dual ESM+CJS build to support these consumers
 * without forcing each app to wrap startup in an async IIFE (which is
 * indent-noisy and easy to get middleware-ordering wrong).
 *
 * This test spawns a real Node child in CJS context (no `type: module`) and
 * `require()`s the package via its on-disk `dist/cjs/` build to verify the
 * exports map + package-marker are wired correctly.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("CJS build resolution", () => {
  it("require('@simsys/metrics') returns install + adapter exports", () => {
    const tmp = mkdtempSync(join(tmpdir(), "simsys-cjs-"));
    const pkgRoot = resolve(__dirname, "..");

    // Tiny CJS scaffold that requires the local package and prints what it got.
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "cjs-resolve-probe",
        version: "0.0.0",
        // No type field — defaults to "commonjs".
        dependencies: { "@simsys/metrics": `file:${pkgRoot}` },
      }),
    );

    // Symlink instead of copy — `npm install file:...` resolves slow under
    // vitest. We point node_modules/@simsys/metrics at the local pkgRoot
    // and let Node's resolver follow the package.json `exports` map.
    execFileSync("mkdir", ["-p", join(tmp, "node_modules", "@simsys")]);
    execFileSync("ln", [
      "-s",
      pkgRoot,
      join(tmp, "node_modules", "@simsys", "metrics"),
    ]);

    const probe = `
      const m = require('@simsys/metrics');
      const r = require('@simsys/metrics/next/route');
      const out = {
        installType: typeof m.install,
        installNextType: typeof m.installNext,
        bucketRouteType: typeof m.bucketRoute,
        getType: typeof r.GET,
        bucketed: m.bucketRoute('/api/shifts/12345'),
      };
      process.stdout.write(JSON.stringify(out));
    `;
    writeFileSync(join(tmp, "probe.cjs"), probe);

    const stdout = execFileSync("node", ["probe.cjs"], {
      cwd: tmp,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const result = JSON.parse(stdout);
    expect(result.installType).toBe("function");
    expect(result.installNextType).toBe("function");
    expect(result.bucketRouteType).toBe("function");
    expect(result.getType).toBe("function");
    expect(result.bucketed).toBe("/api/shifts/:id");
  });
});
