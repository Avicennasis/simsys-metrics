/**
 * simsys_build_info commit detection.
 *
 * Resolution order, matching the Python package:
 *   1. SIMSYS_BUILD_COMMIT env var (if set and non-empty).
 *   2. `git rev-parse --short HEAD` in the current working directory.
 *   3. Literal string "unknown".
 */

import { execFileSync } from "node:child_process";
import { buildInfo } from "./registry.js";

export type BuildInfoLabels = {
  service: string;
  version: string;
  commit: string;
  started_at: string;
} & Record<string, string>;

// Globally-scoped ownership tracker. When registerBuildInfo() is called
// with a labelset that's already in this set, we know an earlier (still
// live) install added it — wasNew=false. On rollback, callers pass
// wasNew back to unregisterBuildInfoIfOwned() so we only call
// buildInfo.remove() when WE were the install that added the sample.
//
// Why this matters: started_at is second-precision, so two installs of
// the same service+version+commit started in the same wall-clock second
// produce identical labelsets. Without ownership tracking, install B's
// rollback would `buildInfo.remove(labels)` and silently delete install
// A's still-live sample.
//
// Pinned to globalThis so that bundler chunk-splitting (e.g. Next.js
// inlining buildinfo.ts into both the instrumentation chunk and any
// chunk that re-uses installNext) doesn't give each chunk its own
// ownership Set — that would let chunk B's rollback remove chunk A's
// live sample. See registry.ts header for the full rationale.
declare global {
  // eslint-disable-next-line no-var
  var __simsysMetricsBuildInfoOwned: Set<string> | undefined;
}

const _ownedLabelKeys: Set<string> = (globalThis.__simsysMetricsBuildInfoOwned ??=
  new Set<string>());

function _labelKey(labels: BuildInfoLabels): string {
  return [labels.service, labels.version, labels.commit, labels.started_at].join("\x00");
}

/**
 * Set the build_info gauge to 1 with the supplied labels and return the
 * resolved labelset along with `wasNew=true` if THIS call created the
 * sample (vs. matching an already-registered labelset from an earlier
 * install). Adapter rollback uses wasNew to decide whether removing the
 * sample on failure is safe.
 */
export function registerBuildInfo(
  labels: BuildInfoLabels,
): { labels: BuildInfoLabels; wasNew: boolean } {
  const key = _labelKey(labels);
  const wasNew = !_ownedLabelKeys.has(key);
  if (wasNew) {
    _ownedLabelKeys.add(key);
  }
  buildInfo.labels(labels).set(1);
  return { labels, wasNew };
}

/**
 * Drop the build_info sample for `labels` ONLY if `wasNew=true` (i.e.
 * the install attempt being rolled back is the one that created the
 * sample). When `wasNew=false`, an earlier install already owns this
 * labelset and removing it would silently delete that install's
 * legitimate sample.
 */
export function unregisterBuildInfoIfOwned(
  labels: BuildInfoLabels,
  wasNew: boolean,
): void {
  if (!wasNew) return;
  const key = _labelKey(labels);
  _ownedLabelKeys.delete(key);
  try {
    buildInfo.remove(labels);
  } catch {
    /* defensive: prom-client throws if the labelset is already gone */
  }
}

export function _resetBuildInfoOwnershipForTests(): void {
  _ownedLabelKeys.clear();
}

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
