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

/**
 * Snapshot of process-collector state immediately before
 * registerProcessCollector() mutated it. Adapter rollback passes this
 * back to restoreProcessCollector() so a swap-then-fail sequence
 * doesn't leave a prior service's process metrics broken.
 *
 * `action` describes what registerProcessCollector did:
 *   - "reused":        collector already existed for this service; nothing changed.
 *   - "registered":    no collector existed; we registered fresh metrics. Rollback drops them.
 *   - "service-swap":  collector existed but for a different service; we relabelled it. Rollback restores priorService.
 */
export type ProcessCollectorRollbackState =
  | { action: "reused" }
  | { action: "registered" }
  | { action: "service-swap"; priorService: string };

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

export function registerProcessCollector(
  svc: string,
): ProcessCollectorRollbackState {
  if (registered) {
    if (service === svc) {
      return { action: "reused" };
    }
    // Re-install with a different service: refresh the static label so
    // future collect() callbacks tag samples with the new service. Capture
    // the prior service so adapter rollback can put it back if a later
    // step in the same install attempt fails.
    //
    // Reset all per-labelset state on swap. prom-client gauges/counters
    // retain entries for prior labelsets indefinitely; without a reset,
    // future scrapes would emit stale samples for the swapped-out
    // service alongside the live ones. Python's _process.py achieves
    // the same cleanliness by unregistering the old collector and
    // registering a brand-new one.
    const priorService = service ?? "";
    service = svc;
    lastCpuSeconds = 0;
    cpuTotal?.reset();
    memoryBytes?.reset();
    openFds?.reset();
    uptimeSeconds?.reset();
    return { action: "service-swap", priorService };
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

  return { action: "registered" };
}

/**
 * Undo whatever registerProcessCollector() did, given its returned state.
 * Called from adapter install rollback when a later step fails, so a
 * service-swap doesn't leave the PRIOR install's process metrics broken
 * (label rewritten to the failed install's service) and a fresh
 * registration doesn't leave dangling collectors in the registry.
 */
export function restoreProcessCollector(
  state: ProcessCollectorRollbackState,
): void {
  switch (state.action) {
    case "reused":
      // Nothing changed; nothing to undo.
      return;
    case "service-swap":
      // We mutated the static `service` global in place — restore it.
      // The Counter/Gauge instances are reused, so collect() callbacks
      // will resume tagging samples with the prior service value.
      //
      // BUT: prom-client retains per-labelset state, so the
      // service-swap window's B-labelled gauge samples linger in the
      // metric's hashmap as stale values. Reset all of them here so
      // future scrapes only contain the restored A-labelled samples
      // (collect() will re-populate them on the next scrape).
      // lastCpuSeconds is also reset so the Counter's delta-tracking
      // doesn't undershoot after the wipe.
      service = state.priorService;
      lastCpuSeconds = 0;
      cpuTotal?.reset();
      memoryBytes?.reset();
      openFds?.reset();
      uptimeSeconds?.reset();
      return;
    case "registered":
      // We registered fresh — drop everything.
      _unregisterAll();
      return;
  }
}

function _unregisterAll(): void {
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

export function _resetForTests(): void {
  // Best-effort test helper.
  _unregisterAll();
}
