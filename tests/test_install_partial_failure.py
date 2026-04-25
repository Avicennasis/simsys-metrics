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
