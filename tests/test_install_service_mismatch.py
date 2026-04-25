"""install() should warn when re-called with a different service/version.

The previous behavior was silent no-op — which meant test fixtures or
plugins that legitimately wanted re-init under a different service name
got the original install with no signal that their args were ignored.
"""

from __future__ import annotations

import logging

import pytest

fastapi = pytest.importorskip("fastapi")
flask = pytest.importorskip("flask")


def test_fastapi_reinstall_with_different_service_warns(caplog):
    from fastapi import FastAPI

    from simsys_metrics import install

    app = FastAPI()
    install(app, service="first", version="1.0.0")

    with caplog.at_level(logging.WARNING, logger="simsys_metrics"):
        install(app, service="second", version="2.0.0")

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("different service/version" in r.getMessage() for r in warnings), (
        f"expected a service-mismatch warning, got: {[r.getMessage() for r in warnings]}"
    )
    # Original service preserved (no-op semantics held).
    assert app.state.simsys_service == "first"
    assert app.state.simsys_version == "1.0.0"


def test_fastapi_reinstall_with_same_args_silent(caplog):
    from fastapi import FastAPI

    from simsys_metrics import install

    app = FastAPI()
    install(app, service="same", version="1.0.0")

    with caplog.at_level(logging.WARNING, logger="simsys_metrics"):
        install(app, service="same", version="1.0.0")

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert not warnings, (
        f"re-install with identical args must be silent, got: {[r.getMessage() for r in warnings]}"
    )


def test_flask_reinstall_with_different_service_warns(caplog):
    from flask import Flask

    from simsys_metrics import install

    app = Flask("flask_mismatch_app")
    install(app, service="first_flask", version="1.0.0")

    with caplog.at_level(logging.WARNING, logger="simsys_metrics"):
        install(app, service="second_flask", version="2.0.0")

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("different service/version" in r.getMessage() for r in warnings)
    assert app.extensions["simsys_metrics"]["service"] == "first_flask"
    assert app.extensions["simsys_metrics"]["version"] == "1.0.0"
