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
//
// Updated atomically inside cpuCollectMutex below: prom-client's
// Registry.metrics() walks collectors via Promise.all with no per-registry
// mutex, so two concurrent scrapes (e.g. Prometheus + a sidecar push
// monitor) can race the read-and-update sequence. Without serialization,
// scrape A reads lastCpuSeconds=0, scrape B reads lastCpuSeconds=0, both
// compute the full delta-from-zero and inc by ~total_cpu — counter
// advances by 2× actual on every concurrent-scrape pair.
let lastCpuSeconds = 0;

// Module-scoped serialization for the cpu collect() callback. Each new
// invocation chains onto the previous one; the read-update of
// lastCpuSeconds + the Counter.inc both run inside the chain.
let cpuCollectMutex: Promise<void> = Promise.resolve();

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
    async collect() {
      // process.cpuUsage() returns microseconds since process start, which
      // is monotonic. Inc by the delta since the last collect so the
      // prom-client Counter's internal value stays monotonic too — using
      // reset()+inc() would defeat prom-client's reset-detection (rate()
      // over a scrape boundary would behave undefined).
      //
      // Serialize via cpuCollectMutex so concurrent /metrics scrapes
      // can't both read the same lastCpuSeconds and double-count.
      const counter = this;
      const next = cpuCollectMutex.then(() => {
        const { user, system } = process.cpuUsage();
        const total = (user + system) / 1_000_000;
        const delta = Math.max(0, total - lastCpuSeconds);
        lastCpuSeconds = total;
        if (delta > 0) {
          counter.inc({ service: service! }, delta);
        }
      });
      cpuCollectMutex = next.catch(() => undefined); // swallow for the chain
      await next;
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
  cpuCollectMutex = Promise.resolve();
  registry.removeSingleMetric("simsys_process_cpu_seconds_total");
  registry.removeSingleMetric("simsys_process_memory_bytes");
  registry.removeSingleMetric("simsys_process_open_fds");
  registry.removeSingleMetric("simsys_process_uptime_seconds");
  cpuTotal = memoryBytes = openFds = uptimeSeconds = null;
}
