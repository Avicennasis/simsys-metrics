"""Custom metrics_path must be reflected in the exposed exempt-path set.

Otherwise apps relying on app.state.simsys_exempt_paths (FastAPI) or
app.extensions["simsys_metrics"]["exempt_paths"] (Flask) to skip auth
on the metrics endpoint would still auth-block /internal/metrics when
the user passed metrics_path="/internal/metrics".
"""

from __future__ import annotations

import pytest

fastapi = pytest.importorskip("fastapi")
flask = pytest.importorskip("flask")


def test_fastapi_custom_metrics_path_in_exempt_set():
    from fastapi import FastAPI

    from simsys_metrics import install

    app = FastAPI()
    install(
        app,
        service="exempt_test_fastapi",
        version="0.0.1",
        metrics_path="/internal/metrics",
    )

    exempt = app.state.simsys_exempt_paths
    assert "/internal/metrics" in exempt, (
        f"custom metrics_path missing from exempt set: {exempt}"
    )
    assert "/health" in exempt, "default health paths must still be present"
    # The default /metrics should NOT be in the set when a custom path was used.
    assert "/metrics" not in exempt, (
        f"default /metrics should not be in exempt set when a custom path "
        f"was supplied: {exempt}"
    )


def test_fastapi_default_metrics_path_in_exempt_set():
    from fastapi import FastAPI

    from simsys_metrics import install

    app = FastAPI()
    install(app, service="exempt_default_fastapi", version="0.0.1")

    exempt = app.state.simsys_exempt_paths
    assert "/metrics" in exempt
    assert {"/health", "/ready", "/healthz"}.issubset(exempt)


def test_flask_custom_metrics_path_in_exempt_set():
    from flask import Flask

    from simsys_metrics import install

    app = Flask("flask_exempt_app")
    install(
        app,
        service="exempt_test_flask",
        version="0.0.1",
        metrics_path="/internal/metrics",
    )

    exempt = app.extensions["simsys_metrics"]["exempt_paths"]
    assert "/internal/metrics" in exempt
    assert "/metrics" not in exempt
    assert "/health" in exempt
