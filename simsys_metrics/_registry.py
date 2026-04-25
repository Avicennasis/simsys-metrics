"""Prefix-guarded metric factories.

Every metric created through these helpers is forced to start with `simsys_`.
The guard makes it impossible to accidentally ship a metric under a bare name
or any other prefix when using this package.
"""

from __future__ import annotations

from typing import Iterable, Optional, Sequence

from prometheus_client import Counter, Gauge, Histogram

PREFIX = "simsys_"


def _guard_name(name: str) -> str:
    if not isinstance(name, str) or not name.startswith(PREFIX):
        raise ValueError(
            f"simsys-metrics refuses to register metric {name!r}: "
            f"all metric names must start with {PREFIX!r}."
        )
    return name


def make_counter(
    name: str, documentation: str, labelnames: Sequence[str] = ()
) -> Counter:
    return Counter(_guard_name(name), documentation, labelnames=tuple(labelnames))


def make_gauge(
    name: str,
    documentation: str,
    labelnames: Sequence[str] = (),
    multiprocess_mode: Optional[str] = None,
) -> Gauge:
    """Create a Gauge with the simsys_ prefix guard.

    ``multiprocess_mode`` is forwarded to ``prometheus_client.Gauge`` only
    when non-None; omitting it preserves the stdlib default (``"all"``)
    and keeps the constructor call identical in single-process mode.
    """
    kwargs: dict[str, object] = {}
    if multiprocess_mode is not None:
        kwargs["multiprocess_mode"] = multiprocess_mode
    return Gauge(
        _guard_name(name), documentation, labelnames=tuple(labelnames), **kwargs
    )


def make_histogram(
    name: str,
    documentation: str,
    labelnames: Sequence[str] = (),
    buckets: Iterable[float] | None = None,
) -> Histogram:
    kwargs = {}
    if buckets is not None:
        kwargs["buckets"] = tuple(buckets)
    return Histogram(
        _guard_name(name), documentation, labelnames=tuple(labelnames), **kwargs
    )
