"""install() must roll back the sentinel if any side-effecting step raises.

Otherwise a transient failure (e.g. `git rev-parse` subprocess timeout in
build_info, registry collision, label assertion) would permanently mark
the app as installed without actually wiring metrics — and the idempotent
guard would silently swallow every retry. The fix wraps the side effects
in try/except that resets the sentinel on failure.
"""

from __future__ import annotations

import pytest

fastapi = pytest.importorskip("fastapi")
flask = pytest.importorskip("flask")


def test_fastapi_install_failure_clears_sentinel(monkeypatch):
    from fastapi import FastAPI

    from simsys_metrics import install
    import simsys_metrics.fastapi as fastapi_mod

    app = FastAPI()

    # Force register_build_info to raise on the first call, succeed on the
    # second. Simulates a transient subprocess.TimeoutExpired in
    # detect_commit() / git rev-parse.
    real_register_build_info = fastapi_mod.register_build_info
    call_count = {"n": 0}

    def flaky_register_build_info(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("transient: git rev-parse timed out")
        return real_register_build_info(*args, **kwargs)

    monkeypatch.setattr(fastapi_mod, "register_build_info", flaky_register_build_info)

    # First install must propagate the exception AND leave the app in a
    # state where retry is possible.
    with pytest.raises(RuntimeError, match="transient"):
        install(app, service="partial_fastapi", version="0.0.1")

    assert getattr(app.state, "simsys_metrics_installed", False) is False, (
        "sentinel must be rolled back on failure so a retry can proceed"
    )
    assert not hasattr(app.state, "simsys_service") or (
        getattr(app.state, "simsys_service", None) is None
    ), "service attribute should be unset after failed install"

    # Retry must now succeed and leave the app fully wired.
    install(app, service="partial_fastapi", version="0.0.1")
    assert app.state.simsys_metrics_installed is True
    assert app.state.simsys_service == "partial_fastapi"
    assert call_count["n"] == 2, f"expected 2 install attempts, got {call_count['n']}"


def test_flask_install_failure_clears_sentinel(monkeypatch):
    from flask import Flask

    from simsys_metrics import install
    import simsys_metrics.flask as flask_mod

    app = Flask("flask_partial_app")

    real_register_build_info = flask_mod.register_build_info
    call_count = {"n": 0}

    def flaky_register_build_info(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("transient: git rev-parse timed out")
        return real_register_build_info(*args, **kwargs)

    monkeypatch.setattr(flask_mod, "register_build_info", flaky_register_build_info)

    with pytest.raises(RuntimeError, match="transient"):
        install(app, service="partial_flask", version="0.0.1")

    assert "simsys_metrics" not in app.extensions, (
        "extensions entry must be cleared on failure so a retry can proceed"
    )

    install(app, service="partial_flask", version="0.0.1")
    assert app.extensions["simsys_metrics"]["installed"] is True
    assert app.extensions["simsys_metrics"]["service"] == "partial_flask"
    assert call_count["n"] == 2


def test_fastapi_install_late_addmiddleware_failure_clears_sentinel(monkeypatch):
    """If app.add_middleware fails (e.g., the app has already started
    serving requests), the rollback must extend to the framework-wiring
    phase — not just the registry/build-info phase. Otherwise a retry
    would no-op on the sentinel and never wire metrics.
    """
    from fastapi import FastAPI

    from simsys_metrics import install

    app = FastAPI()

    # Force add_middleware to raise the same RuntimeError Starlette raises
    # when middleware is added after startup.
    real_add_middleware = app.add_middleware
    call_count = {"n": 0}

    def flaky_add_middleware(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("Cannot add middleware after an application has started")
        return real_add_middleware(*args, **kwargs)

    monkeypatch.setattr(app, "add_middleware", flaky_add_middleware)

    with pytest.raises(RuntimeError, match="after an application has started"):
        install(app, service="late_fastapi", version="0.0.1")

    # Sentinel must be cleared so a retry can proceed.
    assert getattr(app.state, "simsys_metrics_installed", False) is False, (
        "sentinel must be cleared when add_middleware fails post-startup"
    )

    # Retry succeeds.
    install(app, service="late_fastapi", version="0.0.1")
    assert app.state.simsys_metrics_installed is True
    assert call_count["n"] == 2


def test_flask_install_late_route_failure_clears_sentinel(monkeypatch):
    """If a Flask hook registration fails late (e.g., app.route on an
    already-running server), the sentinel must roll back."""
    from flask import Flask

    from simsys_metrics import install

    app = Flask("flask_late_app")

    # Force the @app.route decorator to fail on the first call.
    real_add_url_rule = app.add_url_rule
    call_count = {"n": 0}

    def flaky_add_url_rule(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise AssertionError(
                "The setup method 'add_url_rule' can no longer be called "
                "on the application. It has already handled its first "
                "request, any changes will not be applied consistently."
            )
        return real_add_url_rule(*args, **kwargs)

    monkeypatch.setattr(app, "add_url_rule", flaky_add_url_rule)

    with pytest.raises(AssertionError, match="add_url_rule"):
        install(app, service="late_flask", version="0.0.1")

    assert "simsys_metrics" not in app.extensions, (
        "extensions entry must be cleared when route registration fails"
    )

    install(app, service="late_flask", version="0.0.1")
    assert app.extensions["simsys_metrics"]["installed"] is True
    assert call_count["n"] == 2
