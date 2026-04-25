"""Flask install path for simsys-metrics.

Uses ``prometheus_client`` directly — no third-party Flask exporter. A
``before_request`` / ``after_request`` pair records HTTP metrics; a single
``/metrics`` view exposes the default registry.
"""

from __future__ import annotations

import logging
import time
from typing import Optional

from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

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

# Default exempt paths. Auth middleware can read
# `app.extensions["simsys_metrics"]["exempt_paths"]` to skip the metrics
# endpoint without hard-coding it. The actual set is built per-install
# so a user-supplied `metrics_path` (if non-default) is included.
_DEFAULT_HEALTH_PATHS = frozenset({"/health", "/ready", "/healthz"})
EXEMPT_PATHS = frozenset({"/metrics"}) | _DEFAULT_HEALTH_PATHS


def _build_exempt_paths(metrics_path: str) -> frozenset[str]:
    """Return the auth-exempt path set for an install, including the
    user-supplied metrics_path if it differs from the default."""
    return frozenset({metrics_path}) | _DEFAULT_HEALTH_PATHS


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
    existing = app.extensions.get("simsys_metrics") or {}
    if existing.get("installed"):
        if (existing.get("service"), existing.get("version")) != (service, version):
            _log.warning(
                "simsys_metrics.install() called again on the same Flask app "
                "with different service/version (%r/%r vs %r/%r); the new "
                "values are IGNORED. To re-init, drop "
                "app.extensions['simsys_metrics'] first.",
                existing.get("service"),
                existing.get("version"),
                service,
                version,
            )
        return

    # Set the extensions sentinel BEFORE side effects so consumer code
    # that races against install sees a consistent picture. If any of the
    # side-effecting calls below raises, the sentinel is CLEARED in the
    # except block — otherwise a transient failure (e.g. a `git rev-parse`
    # subprocess timeout in build_info.py) would permanently mark the app
    # as installed without actually wiring metrics, blocking retries.
    app.extensions["simsys_metrics"] = {
        "service": service,
        "version": version,
        "exempt_paths": _build_exempt_paths(metrics_path),
        "installed": True,
    }

    try:
        set_service(service)
        register_process_collector(service)
        register_build_info(service=service, version=version, commit=commit)

        @app.before_request
        def _simsys_before():
            # Store start time on the request context via flask.g
            from flask import g

            g.simsys_start = time.perf_counter()

        def _record(method: str, route: str, status: int, start) -> None:
            """Emit one observation. Used by both after_request and the
            got_request_exception handler so unhandled-exception 5xx are
            still counted instead of vanishing silently."""
            http_requests_total.labels(
                service=service,
                method=method,
                route=route,
                status=status_bucket(status),
            ).inc()
            # Skip the histogram observe when before_request never ran
            # (early error handlers, redirect chains): a 0.0 sample would
            # skew the smallest bucket.
            if start is not None:
                elapsed = time.perf_counter() - start
                http_request_duration_seconds.labels(
                    service=service,
                    method=method,
                    route=route,
                ).observe(elapsed)

        @app.after_request
        def _simsys_after(response):
            from flask import g

            if request.path == metrics_path:
                return response
            # If got_request_exception already recorded this request
            # (unhandled exception path that Flask still let through to
            # after_request via an error handler), skip — counting twice
            # would inflate the 5xx series.
            if getattr(g, "simsys_recorded", False):
                return response

            # url_rule.rule is the template ("/items/<id>"); when no rule
            # matched (404, exception path), fall back to a single bucket
            # label so 404 scanner traffic doesn't blow out cardinality.
            rule = request.url_rule
            route = rule.rule if rule is not None else "__unmatched__"
            _record(
                normalize_method(request.method),
                route,
                response.status_code,
                getattr(g, "simsys_start", None),
            )
            g.simsys_recorded = True
            return response

        # Flask invokes do_teardown_request (NOT after_request) for
        # unhandled exceptions, so without this signal handler 5xx caused
        # by uncaught exceptions would never be counted. Subscribe to
        # got_request_exception which fires BEFORE teardown.
        from flask.signals import got_request_exception

        def _simsys_on_exception(sender, exception, **_kwargs):
            from flask import g

            if request.path == metrics_path:
                return
            if getattr(g, "simsys_recorded", False):
                return
            rule = request.url_rule
            route = rule.rule if rule is not None else "__unmatched__"
            _record(
                normalize_method(request.method),
                route,
                500,
                getattr(g, "simsys_start", None),
            )
            g.simsys_recorded = True

        got_request_exception.connect(_simsys_on_exception, app)

        @app.route(metrics_path)
        def _simsys_metrics_view():
            return FlaskResponse(generate_latest(), mimetype=CONTENT_TYPE_LATEST)
    except BaseException:
        # Roll back the sentinel so a retry can attempt a fresh install.
        # Caller still sees the original exception. Covers ALL framework
        # wiring failures: before_request / after_request / route
        # registration on an already-serving app, signal-connection
        # collisions, and the registry/build-info phase.
        app.extensions.pop("simsys_metrics", None)
        raise
