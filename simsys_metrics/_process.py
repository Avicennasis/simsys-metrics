"""Custom Prometheus collector for simsys_process_* metrics.

``prometheus_client`` ships a ProcessCollector by default but its metric names
don't carry the ``simsys_`` prefix and they don't have a ``service`` label.
Rather than re-wrap those, we emit our own via psutil in a single Collector.

Registered once per process by ``install()``. Collectors are idempotent to
register: calling ``register_process_collector(service)`` again with the same
service reuses the existing collector.
"""

from __future__ import annotations

from threading import Lock
from typing import Optional

import psutil
from prometheus_client import REGISTRY
from prometheus_client.metrics_core import CounterMetricFamily, GaugeMetricFamily

_lock = Lock()
_collector: Optional["SimsysProcessCollector"] = None


class SimsysProcessCollector:
    """Emits simsys_process_cpu_seconds_total / memory_bytes / open_fds."""

    def __init__(self, service: str) -> None:
        self._service = service
        self._proc = psutil.Process()

    def collect(self):
        try:
            cpu = self._proc.cpu_times()
            cpu_total = float(cpu.user) + float(cpu.system)
        except (psutil.Error, OSError):
            cpu_total = 0.0

        cpu_family = CounterMetricFamily(
            "simsys_process_cpu_seconds_total",
            "Process CPU seconds (user + system) consumed since process start.",
            labels=["service"],
        )
        cpu_family.add_metric([self._service], cpu_total)
        yield cpu_family

        try:
            mem = self._proc.memory_info()
            rss = float(mem.rss)
            vms = float(mem.vms)
        except (psutil.Error, OSError):
            rss = 0.0
            vms = 0.0

        mem_family = GaugeMetricFamily(
            "simsys_process_memory_bytes",
            "Process memory in bytes. type=rss is resident set; type=vms is virtual.",
            labels=["service", "type"],
        )
        mem_family.add_metric([self._service, "rss"], rss)
        mem_family.add_metric([self._service, "vms"], vms)
        yield mem_family

        try:
            num_fds = float(self._proc.num_fds())
        except (psutil.Error, OSError, AttributeError):
            num_fds = 0.0

        fds_family = GaugeMetricFamily(
            "simsys_process_open_fds",
            "Open file descriptors for this process.",
            labels=["service"],
        )
        fds_family.add_metric([self._service], num_fds)
        yield fds_family


def register_process_collector(
    service: str,
) -> tuple["SimsysProcessCollector", bool]:
    """Register (or re-use) the singleton process collector for ``service``.

    Returns ``(collector, was_new)``. ``was_new=True`` means this call
    actually registered a NEW collector (either the first registration
    or a service swap that unregistered the old one); ``False`` means
    the existing collector was reused unchanged. install() uses this
    flag to decide whether to unregister on rollback.
    """
    global _collector
    with _lock:
        if _collector is not None:
            if _collector._service != service:
                REGISTRY.unregister(_collector)
                _collector = SimsysProcessCollector(service)
                REGISTRY.register(_collector)
                return _collector, True
            return _collector, False
        _collector = SimsysProcessCollector(service)
        REGISTRY.register(_collector)
        return _collector, True


def unregister_process_collector() -> None:
    """Test-only helper: drop the registered process collector."""
    global _collector
    with _lock:
        if _collector is not None:
            try:
                REGISTRY.unregister(_collector)
            except KeyError:
                pass
            _collector = None
