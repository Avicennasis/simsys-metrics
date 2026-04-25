/**
 * Custom simsys_process_* collector.
 *
 * prom-client's default metrics cover most of this already (`process_*`,
 * `nodejs_*`) but they don't carry the `simsys_` prefix or the `service`
 * label. This module emits our own family alongside so cross-service PromQL
 * like `sum by (service) (simsys_process_memory_bytes{type="rss"})` works
 * unmodified across every app.
 *
 * Matches `simsys_metrics._process` (Python).
 */

import { readdirSync } from "node:fs";
import { Counter, Gauge } from "prom-client";
import { registry } from "./registry.js";

let registered = false;
let service: string | null = null;

// We store these in module scope so they survive across collect() cycles.
let cpuTotal: Counter | null = null;
let memoryBytes: Gauge | null = null;
let openFds: Gauge | null = null;
let uptimeSeconds: Gauge | null = null;

// Last observed cumulative CPU seconds — used to inc() the Counter by the
// delta on each collect() cycle, preserving monotonic counter semantics so
// rate() and reset-detection behave correctly.
let lastCpuSeconds = 0;

function countOpenFds(): number {
  // Linux-only: /proc/self/fd lists one entry per open FD.
  if (process.platform !== "linux") return 0;
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return 0;
  }
}

export function registerProcessCollector(svc: string): void {
  if (registered) {
    if (service !== svc) {
      // Re-install with a different service: refresh the static label.
      service = svc;
    }
    return;
  }
  service = svc;
  registered = true;

  cpuTotal = new Counter({
    name: "simsys_process_cpu_seconds_total",
    help: "Process CPU seconds (user + system) consumed since process start.",
    labelNames: ["service"],
    registers: [registry],
    collect() {
      // process.cpuUsage() returns microseconds since process start, which is
      // monotonic. Inc by the delta since the last collect so the prom-client
      // Counter's internal value stays monotonic too — using reset()+inc()
      // would defeat prom-client's reset-detection (rate() over a scrape
      // boundary would behave undefined).
      const { user, system } = process.cpuUsage();
      const total = (user + system) / 1_000_000;
      const delta = Math.max(0, total - lastCpuSeconds);
      lastCpuSeconds = total;
      if (delta > 0) {
        this.inc({ service: service! }, delta);
      }
    },
  });

  memoryBytes = new Gauge({
    name: "simsys_process_memory_bytes",
    help: "Process memory in bytes. type=rss is resident set; type=heapUsed is V8 heap used; type=heapTotal is V8 heap total.",
    labelNames: ["service", "type"],
    registers: [registry],
    collect() {
      const mem = process.memoryUsage();
      this.set({ service: service!, type: "rss" }, mem.rss);
      this.set({ service: service!, type: "heapUsed" }, mem.heapUsed);
      this.set({ service: service!, type: "heapTotal" }, mem.heapTotal);
      this.set({ service: service!, type: "external" }, mem.external);
    },
  });

  openFds = new Gauge({
    name: "simsys_process_open_fds",
    help: "Open file descriptors for this process (Linux only; 0 elsewhere).",
    labelNames: ["service"],
    registers: [registry],
    collect() {
      this.set({ service: service! }, countOpenFds());
    },
  });

  uptimeSeconds = new Gauge({
    name: "simsys_process_uptime_seconds",
    help: "Process uptime in seconds.",
    labelNames: ["service"],
    registers: [registry],
    collect() {
      this.set({ service: service! }, process.uptime());
    },
  });
}

export function _resetForTests(): void {
  // Best-effort test helper.
  registered = false;
  service = null;
  lastCpuSeconds = 0;
  registry.removeSingleMetric("simsys_process_cpu_seconds_total");
  registry.removeSingleMetric("simsys_process_memory_bytes");
  registry.removeSingleMetric("simsys_process_open_fds");
  registry.removeSingleMetric("simsys_process_uptime_seconds");
  cpuTotal = memoryBytes = openFds = uptimeSeconds = null;
}
