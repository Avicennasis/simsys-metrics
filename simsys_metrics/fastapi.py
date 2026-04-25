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
from ._http import (
    http_request_duration_seconds,
    http_requests_total,
    normalize_method,
    status_bucket,
)
from ._process import register_process_collector
from .build_info import register_build_info

_log = logging.getLogger("simsys_metrics")

# Default exempt paths. Auth middleware on host apps can read
# `app.state.simsys_exempt_paths` to skip these without hard-coding the
# list. The actual set is built per-install so the user-supplied
# `metrics_path` (if non-default) is included — see _build_exempt_paths.
_DEFAULT_HEALTH_PATHS = frozenset({"/health", "/ready", "/healthz"})
EXEMPT_PATHS = frozenset({"/metrics"}) | _DEFAULT_HEALTH_PATHS


def _build_exempt_paths(metrics_path: str) -> frozenset[str]:
    """Return the auth-exempt path set for an install, including the
    user-supplied metrics_path if it differs from the default."""
    return frozenset({metrics_path}) | _DEFAULT_HEALTH_PATHS


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
    from starlette.middleware.base import BaseHTTPMiddleware
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

    # Set the sentinel BEFORE side effects so consumer code that races
    # against install (e.g. an upstream auth middleware reading the exempt
    # path set during startup) sees a consistent picture. If any of the
    # side-effecting calls below raises, the sentinel is CLEARED in the
    # except block — otherwise a transient failure (e.g. a `git rev-parse`
    # subprocess timeout in build_info.py) would permanently mark the app
    # as installed without actually wiring metrics, blocking retries.
    app.state.simsys_service = service
    app.state.simsys_version = version
    app.state.simsys_exempt_paths = _build_exempt_paths(metrics_path)
    app.state.simsys_metrics_installed = True

    try:
        set_service(service)
        # Skip the custom SimsysProcessCollector in multiproc mode: it reads
        # the current process's /proc stats only, so summing those across
        # workers would be meaningless. Per-process CPU/RSS/FDs gauges are a
        # known limitation of multiproc mode.
        if not multiproc_dir:
            register_process_collector(service)
        register_build_info(service=service, version=version, commit=commit)

        # Use a BaseHTTPMiddleware subclass via app.add_middleware() rather
        # than the function-style @app.middleware("http") decorator. The
        # decorator form is known to deadlock with
        # starlette.testclient.TestClient under recent Starlette versions
        # (0.51+); BaseHTTPMiddleware is the canonical, testable pattern.
        #
        # add_middleware raises RuntimeError if the app has already started
        # serving requests ("Cannot add middleware after an application has
        # started"). The except block below catches this so a late-install
        # failure is recoverable on retry rather than leaving the app
        # marked installed without metrics actually wired.
        class _SimsysHTTPMetrics(BaseHTTPMiddleware):
            async def dispatch(self, request: Request, call_next):
                if request.url.path == metrics_path:
                    return await call_next(request)
                start = time.perf_counter()
                status_code = 500  # default until call_next returns a Response
                try:
                    response = await call_next(request)
                    status_code = response.status_code
                    return response
                finally:
                    elapsed = time.perf_counter() - start
                    route_obj = request.scope.get("route")
                    route = getattr(route_obj, "path", None) or "__unmatched__"
                    method = normalize_method(request.method)
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

        app.add_middleware(_SimsysHTTPMetrics)

        if multiproc_dir:
            # Multiproc mode: fresh registry + MultiProcessCollector, mount
            # /metrics as a plain route. Instrumentator.expose() reads from
            # the default REGISTRY only, so we skip it here.
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
    except BaseException:
        # Roll back the sentinel + state attributes so a retry can attempt
        # a fresh install. Caller still sees the original exception. Covers
        # ALL framework wiring failures (add_middleware after startup,
        # Instrumentator.expose collisions, route registration on a frozen
        # app, etc.) — not just the registry/build-info phase.
        app.state.simsys_metrics_installed = False
        if hasattr(app.state, "simsys_service"):
            del app.state.simsys_service
        if hasattr(app.state, "simsys_version"):
            del app.state.simsys_version
        if hasattr(app.state, "simsys_exempt_paths"):
            del app.state.simsys_exempt_paths
        raise
