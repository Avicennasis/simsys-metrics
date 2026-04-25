"""install() must be idempotent — calling it twice on the same app is a no-op.

Otherwise tests, plugins, or app factories that re-import code can double the
middleware stack and double-count every HTTP request.
"""

from __future__ import annotations

import pytest


fastapi = pytest.importorskip("fastapi")
testclient = pytest.importorskip("fastapi.testclient")
flask = pytest.importorskip("flask")


def test_fastapi_install_twice_does_not_double_count():
    from fastapi import FastAPI

    from simsys_metrics import install

    app = FastAPI()
    install(app, service="idem_fastapi", version="0.0.1")
    install(app, service="idem_fastapi", version="0.0.1")  # second call: no-op

    @app.get("/ping")
    def ping():
        return {"ok": True}

    client = testclient.TestClient(app)
    client.get("/ping")
    text = client.get("/metrics").text

    # Hit must be counted exactly once. has_sample doesn't compare values, so
    # check the actual count line by parsing.
    found = [
        line
        for line in text.splitlines()
        if line.startswith("simsys_http_requests_total")
        and 'route="/ping"' in line
        and 'service="idem_fastapi"' in line
    ]
    assert len(found) == 1, f"expected exactly one /ping counter line, got {found}"
    # Counter value should be exactly 1.0
    value = float(found[0].rsplit(" ", 1)[1])
    assert value == 1.0, f"expected count=1.0 from a single request, got {value}"


def test_flask_install_twice_does_not_double_count():
    from flask import Flask

    from simsys_metrics import install

    app = Flask("idem_flask_app")
    install(app, service="idem_flask", version="0.0.1")
    install(app, service="idem_flask", version="0.0.1")  # second call: no-op

    @app.route("/ping")
    def ping():
        return {"ok": True}

    client = app.test_client()
    client.get("/ping")
    text = client.get("/metrics").get_data(as_text=True)

    found = [
        line
        for line in text.splitlines()
        if line.startswith("simsys_http_requests_total")
        and 'route="/ping"' in line
        and 'service="idem_flask"' in line
    ]
    assert len(found) == 1, f"expected exactly one /ping counter line, got {found}"
    value = float(found[0].rsplit(" ", 1)[1])
    assert value == 1.0, f"expected count=1.0 from a single request, got {value}"


def test_fastapi_install_idempotent_check_smoke():
    from fastapi import FastAPI

    from simsys_metrics import install

    app = FastAPI()
    install(app, service="idem_smoke", version="0.0.1")
    assert app.state.simsys_metrics_installed is True


def test_flask_install_idempotent_check_smoke():
    from flask import Flask

    from simsys_metrics import install

    app = Flask("idem_flask_smoke")
    install(app, service="idem_smoke_flask", version="0.0.1")
    assert app.extensions["simsys_metrics"]["installed"] is True

    # Has metrics view registered
    assert any(rule.rule == "/metrics" for rule in app.url_map.iter_rules()), (
        "expected /metrics view to be registered"
    )
