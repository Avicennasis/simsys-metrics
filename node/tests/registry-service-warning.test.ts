/**
 * Custom metrics registered without 'service' in labelNames must emit
 * a one-time console.warn — the cross-service Grafana dashboards filter
 * on the service label, so a metric without it can't participate in the
 * shared contract. The warning makes silent omissions visible.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeCounter, makeGauge, registry } from "../src/registry.js";

describe("registry service-label warning", () => {
  let warnings: string[];
  let origWarn: typeof console.warn;

  beforeEach(() => {
    registry.resetMetrics();
    warnings = [];
    origWarn = console.warn;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console.warn = (...args: any[]) => {
      warnings.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.warn = origWarn;
  });

  it("warns when 'service' is missing from labelNames", () => {
    makeCounter("simsys_no_service_test_warn", "missing service", ["ticker"]);
    expect(warnings.some((w) => w.includes("'service'"))).toBe(true);
  });

  it("does not warn when 'service' is present", () => {
    makeGauge("simsys_with_service_test_warn", "has service", [
      "service",
      "operation",
    ]);
    const offenders = warnings.filter(
      (w) =>
        w.includes("'service'") &&
        w.includes("simsys_with_service_test_warn"),
    );
    expect(offenders).toEqual([]);
  });
});
