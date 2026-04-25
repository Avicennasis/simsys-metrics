"""Shared HTTP request/duration metrics used by both FastAPI and Flask paths.

Defined once at module level so re-install is cheap and both framework paths
emit metrics with identical names, labels, and buckets.
"""

from __future__ import annotations

from ._registry import make_counter, make_histogram

http_requests_total = make_counter(
    "simsys_http_requests_total",
    "Total HTTP requests handled, bucketed by status class.",
    labelnames=("service", "method", "route", "status"),
)

http_request_duration_seconds = make_histogram(
    "simsys_http_request_duration_seconds",
    "HTTP request duration in seconds, labelled by route template.",
    labelnames=("service", "method", "route"),
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)


def status_bucket(status_code: int | str) -> str:
    """Map a raw HTTP status to its class string (``2xx`` / ``3xx`` / ...)."""
    try:
        code = int(status_code)
    except (TypeError, ValueError):
        return "5xx"
    if 100 <= code < 200:
        return "1xx"
    if 200 <= code < 300:
        return "2xx"
    if 300 <= code < 400:
        return "3xx"
    if 400 <= code < 500:
        return "4xx"
    return "5xx"
