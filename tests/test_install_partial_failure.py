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


def test_fastapi_partial_failure_does_not_leak_build_info(monkeypatch):
    """Pre-fix: a partial install (Instrumentator.expose raises) left the
    build_info gauge sample registered. A successful retry then added a
    SECOND sample with a fresher started_at — two simsys_build_info
    lines for the same service/version/commit. The rollback now calls
    unregister_build_info to drop the failed-install label-set."""
    import time as _time

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from prometheus_fastapi_instrumentator import Instrumentator

    from simsys_metrics import install

    app = FastAPI()
    real_expose = Instrumentator.expose
    call_count = {"n": 0}

    def flaky(self, *args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("forced expose failure")
        return real_expose(self, *args, **kwargs)

    monkeypatch.setattr(Instrumentator, "expose", flaky)

    with pytest.raises(RuntimeError, match="forced expose failure"):
        install(app, service="bi_leak_test", version="0.0.1")

    # Sleep past a second-precision boundary so a leaked label-set
    # would have a different started_at than the retry's label-set.
    _time.sleep(1.1)

    install(app, service="bi_leak_test", version="0.0.1")

    text = TestClient(app).get("/metrics").text
    bi_lines = [
        line
        for line in text.splitlines()
        if line.startswith("simsys_build_info{") and 'service="bi_leak_test"' in line
    ]
    assert len(bi_lines) == 1, (
        f"expected exactly one simsys_build_info sample for bi_leak_test "
        f"after rollback+retry, got {len(bi_lines)}:\n{bi_lines}"
    )


def test_flask_partial_failure_does_not_leak_build_info(monkeypatch):
    """Same regression as above, Flask edition. Force build_info to
    succeed but the Flask wiring phase to fail; assert the rollback
    drops the build_info label-set so the retry's sample is the only
    one visible on /metrics."""
    import time as _time

    from flask import Flask

    from simsys_metrics import install

    app = Flask("flask_bi_leak")

    real_add_url_rule = app.add_url_rule
    call_count = {"n": 0}

    def flaky_add_url_rule(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise AssertionError("forced add_url_rule failure")
        return real_add_url_rule(*args, **kwargs)

    monkeypatch.setattr(app, "add_url_rule", flaky_add_url_rule)

    with pytest.raises(AssertionError, match="forced add_url_rule failure"):
        install(app, service="bi_leak_flask", version="0.0.1")

    _time.sleep(1.1)
    install(app, service="bi_leak_flask", version="0.0.1")

    text = app.test_client().get("/metrics").get_data(as_text=True)
    bi_lines = [
        line
        for line in text.splitlines()
        if line.startswith("simsys_build_info{") and 'service="bi_leak_flask"' in line
    ]
    assert len(bi_lines) == 1, (
        f"expected exactly one simsys_build_info sample for bi_leak_flask "
        f"after rollback+retry, got {len(bi_lines)}:\n{bi_lines}"
    )


def test_fastapi_partial_failure_does_not_double_stack_middleware(monkeypatch):
    """Regression: if install_fastapi() got past app.add_middleware() and
    then failed (e.g. Instrumentator.expose raised), the rollback must
    truncate the middleware list. Otherwise a retry adds a SECOND
    metrics middleware and every request gets counted twice.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from prometheus_fastapi_instrumentator import Instrumentator

    from simsys_metrics import install

    app = FastAPI()

    # Force Instrumentator.expose to raise on the first attempt only.
    real_expose = Instrumentator.expose
    call_count = {"n": 0}

    def flaky_expose(self, *args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("forced expose failure")
        return real_expose(self, *args, **kwargs)

    monkeypatch.setattr(Instrumentator, "expose", flaky_expose)

    pre_count = len(app.user_middleware)

    with pytest.raises(RuntimeError, match="forced expose failure"):
        install(app, service="dbl_stack_test", version="0.0.1")

    # Middleware added during the failed attempt MUST be removed on
    # rollback. Without the truncate, len(app.user_middleware) would be
    # pre_count + 1 here.
    assert len(app.user_middleware) == pre_count, (
        f"rollback did not truncate middleware: was {pre_count}, "
        f"now {len(app.user_middleware)}"
    )

    # Retry must succeed and add exactly one middleware.
    install(app, service="dbl_stack_test", version="0.0.1")
    assert len(app.user_middleware) == pre_count + 1, (
        f"retry did not add exactly one middleware: pre={pre_count}, "
        f"post={len(app.user_middleware)}"
    )

    # Drive a request and confirm it's counted exactly once, not twice.
    @app.get("/ping")
    def ping():
        return {"pong": True}

    client = TestClient(app)
    client.get("/ping")
    text = client.get("/metrics").text

    counter_lines = [
        line
        for line in text.splitlines()
        if line.startswith("simsys_http_requests_total")
        and 'route="/ping"' in line
        and 'service="dbl_stack_test"' in line
    ]
    assert len(counter_lines) == 1, f"expected one /ping line, got {counter_lines}"
    value = float(counter_lines[0].rsplit(" ", 1)[1])
    assert value == 1.0, (
        f"expected /ping count=1.0, got {value} — middleware double-stacked"
    )
