"""Flask install path for simsys-metrics.

Uses ``prometheus_client`` directly — no third-party Flask exporter. A
``before_request`` / ``after_request`` pair records HTTP metrics; a single
``/metrics`` view exposes the default registry.
"""

from __future__ import annotations

import time
from typing import Optional

from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from ._baseline import set_service
from ._http import http_request_duration_seconds, http_requests_total, status_bucket
from ._process import register_process_collector
from .build_info import register_build_info

EXEMPT_PATHS = frozenset({"/metrics", "/health", "/ready", "/healthz"})


def install_flask(
    app,
    *,
    service: str,
    version: str,
    commit: Optional[str] = None,
    metrics_path: str = "/metrics",
) -> None:
    """Wire simsys baseline metrics into a Flask ``app``."""
    from flask import Flask, request  # local import: flask is an optional extra
    from flask import Response as FlaskResponse

    if not isinstance(app, Flask):
        raise TypeError(f"install_flask expected a flask.Flask, got {type(app)!r}")

    # Idempotent: a second install_flask() on the same app is a no-op.
    app.extensions = getattr(app, "extensions", {}) or {}
    if app.extensions.get("simsys_metrics", {}).get("installed"):
        return

    set_service(service)
    register_process_collector(service)
    register_build_info(service=service, version=version, commit=commit)

    app.extensions["simsys_metrics"] = {
        "service": service,
        "exempt_paths": EXEMPT_PATHS,
        "installed": True,
    }

    @app.before_request
    def _simsys_before():
        # Store start time on the request context via flask.g
        from flask import g

        g.simsys_start = time.perf_counter()

    @app.after_request
    def _simsys_after(response):
        from flask import g

        if request.path == metrics_path:
            return response

        start = getattr(g, "simsys_start", None)
        # url_rule.rule is the template ("/items/<id>"); when no rule matched
        # (404, exception path), fall back to a single bucket label so 404
        # scanner traffic doesn't blow out cardinality.
        rule = request.url_rule
        route = rule.rule if rule is not None else "__unmatched__"
        http_requests_total.labels(
            service=service,
            method=request.method,
            route=route,
            status=status_bucket(response.status_code),
        ).inc()
        # Skip the histogram observe when before_request never ran (mounted
        # error handlers, redirect chains): a 0.0 sample would skew the
        # smallest bucket.
        if start is not None:
            elapsed = time.perf_counter() - start
            http_request_duration_seconds.labels(
                service=service,
                method=request.method,
                route=route,
            ).observe(elapsed)
        return response

    @app.route(metrics_path)
    def _simsys_metrics_view():
        return FlaskResponse(generate_latest(), mimetype=CONTENT_TYPE_LATEST)
