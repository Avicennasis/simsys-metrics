/**
 * simsys_build_info commit detection.
 *
 * Resolution order, matching the Python package:
 *   1. SIMSYS_BUILD_COMMIT env var (if set and non-empty).
 *   2. `git rev-parse --short HEAD` in the current working directory.
 *   3. Literal string "unknown".
 */

import { execFileSync } from "node:child_process";

export function detectCommit(cwd?: string): string {
  const envCommit = (process.env.SIMSYS_BUILD_COMMIT ?? "").trim();
  if (envCommit) {
    return envCommit;
  }

  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const trimmed = out.trim();
    return trimmed || "unknown";
  } catch {
    return "unknown";
  }
}

export function startedAtNow(): string {
  // ISO-8601 seconds-precision UTC timestamp, matching the Python reference.
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
