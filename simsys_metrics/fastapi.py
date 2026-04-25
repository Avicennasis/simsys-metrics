"""FastAPI install path for simsys-metrics.

Uses ``prometheus-fastapi-instrumentator`` for reliable route-template
resolution and plugs our own custom metric observers on top so every emitted
metric carries the mandatory ``service`` label.

``/metrics`` is auto-mounted and added to a common exempt set so host apps
with auth middleware can skip it automatically.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Optional

from ._baseline import set_service
from ._http import http_request_duration_seconds, http_requests_total, status_bucket
from ._process import register_process_collector
from .build_info import register_build_info

_log = logging.getLogger("simsys_metrics")

# Auth middleware on host apps can read this attribute on the app to decide
# what to skip. Declaring it here lets consumers discover it without importing
# a private helper.
EXEMPT_PATHS = frozenset({"/metrics", "/health", "/ready", "/healthz"})


def install_fastapi(
    app,
    *,
    service: str,
    version: str,
    commit: Optional[str] = None,
    metrics_path: str = "/metrics",
) -> None:
    """Wire simsys baseline metrics into a FastAPI ``app``.

    - Sets the process-wide service label.
    - Registers the simsys_process_* collector (single-process mode only;
      skipped when ``PROMETHEUS_MULTIPROC_DIR`` is set because the collector
      reads the current process's /proc stats and cannot aggregate across
      workers).
    - Records simsys_http_requests_total + simsys_http_request_duration_seconds
      on every request using the resolved route template.
    - Mounts ``metrics_path`` (default ``/metrics``) exposing the default
      Prometheus registry. In multiproc mode, mounts a plain FastAPI route
      that serves a ``MultiProcessCollector`` view instead, aggregating
      samples from every process writing into ``PROMETHEUS_MULTIPROC_DIR``.
    - Advertises exempt paths via ``app.state.simsys_exempt_paths`` so
      host-app middleware can avoid authenticating the scrape path.
    """
    from fastapi import FastAPI  # local import: fastapi is an optional extra
    from prometheus_fastapi_instrumentator import Instrumentator
    from starlette.requests import Request
    from starlette.responses import Response

    if not isinstance(app, FastAPI):
        raise TypeError(
            f"install_fastapi expected a fastapi.FastAPI, got {type(app)!r}"
        )

    # Idempotent: a second install_fastapi() on the same app is a no-op so
    # tests, plugins, and lazy app factories can call install() repeatedly
    # without doubling middleware or re-registering metrics.
    if getattr(app.state, "simsys_metrics_installed", False):
        prior_service = getattr(app.state, "simsys_service", None)
        prior_version = getattr(app.state, "simsys_version", None)
        if (prior_service, prior_version) != (service, version):
            _log.warning(
                "simsys_metrics.install() called again on the same app with "
                "different service/version (%r/%r vs %r/%r); the new values "
                "are IGNORED. To re-init, drop app.state.simsys_metrics_installed "
                "first.",
                prior_service,
                prior_version,
                service,
                version,
            )
        return

    multiproc_dir = os.environ.get("PROMETHEUS_MULTIPROC_DIR")

    # Set the sentinel BEFORE side effects so a partial first install (e.g.
    # register_build_info raises mid-way) doesn't leave the registry partially
    # populated AND let a retry re-run the full registration. Process collector
    # registration is locked-singleton-safe and build_info is set-idempotent,
    # so re-entering after a transient error is benign — but we want exactly
    # one effective install per app, not "however many retries it took."
    app.state.simsys_service = service
    app.state.simsys_version = version
    app.state.simsys_exempt_paths = EXEMPT_PATHS
    app.state.simsys_metrics_installed = True

    set_service(service)
    # Skip the custom SimsysProcessCollector in multiproc mode: it reads the
    # current process's /proc stats only, so summing those across workers
    # would be meaningless. Per-process CPU/RSS/FDs gauges are a known
    # limitation of multiproc mode.
    if not multiproc_dir:
        register_process_collector(service)
    register_build_info(service=service, version=version, commit=commit)

    @app.middleware("http")
    async def _simsys_http_metrics(request: Request, call_next):
        if request.url.path == metrics_path:
            return await call_next(request)
        start = time.perf_counter()
        response: Optional[Response] = None
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        finally:
            elapsed = time.perf_counter() - start
            # Route-template resolution: FastAPI stamps the matched route onto
            # request.scope["route"]; its .path is the template (e.g. /items/{id}).
            # When no route matched (404, OPTIONS pre-flight, exception path),
            # fall back to a single bucket label to keep cardinality bounded.
            route_obj = request.scope.get("route")
            route = getattr(route_obj, "path", None) or "__unmatched__"
            method = request.method
            http_requests_total.labels(
                service=service,
                method=method,
                route=route,
                status=status_bucket(status_code),
            ).inc()
            http_request_duration_seconds.labels(
                service=service,
                method=method,
                route=route,
            ).observe(elapsed)

    if multiproc_dir:
        # Multiproc mode: build a fresh registry, attach MultiProcessCollector
        # to aggregate samples across all processes writing into
        # $PROMETHEUS_MULTIPROC_DIR, and mount /metrics as a plain route.
        # Instrumentator.expose() reads from the default REGISTRY and offers
        # no registry= override, so we skip it entirely here.
        from prometheus_client import (
            CONTENT_TYPE_LATEST,
            CollectorRegistry,
            generate_latest,
        )
        from prometheus_client.multiprocess import MultiProcessCollector

        multiproc_registry = CollectorRegistry()
        MultiProcessCollector(multiproc_registry)

        @app.get(metrics_path, include_in_schema=False)
        def _simsys_metrics_multiproc() -> Response:
            return Response(
                content=generate_latest(multiproc_registry),
                media_type=CONTENT_TYPE_LATEST,
            )
    else:
        Instrumentator(
            should_group_status_codes=True,
            should_ignore_untemplated=True,
            excluded_handlers=[metrics_path],
        ).expose(app, endpoint=metrics_path, include_in_schema=False)
