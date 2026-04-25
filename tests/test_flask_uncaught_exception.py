"""Flask uncaught exceptions must still be counted as 5xx.

Without a got_request_exception handler, Flask routes after_request only
for handled responses. Unhandled exceptions skip after_request entirely
and silently undercount the error rate.
"""

from __future__ import annotations

import pytest

from tests.conftest import has_sample

flask = pytest.importorskip("flask")


def test_flask_uncaught_exception_records_5xx():
    from flask import Flask

    from simsys_metrics import install

    app = Flask("flask_exc_app")
    # Disable Flask's debug error page so the test client gets a real 500
    # rather than a debugger response.
    app.config["TESTING"] = False
    app.config["PROPAGATE_EXCEPTIONS"] = False
    install(app, service="flask_exc_test", version="0.0.1")

    @app.route("/boom")
    def boom():
        raise RuntimeError("planned failure")

    client = app.test_client()
    response = client.get("/boom")
    assert response.status_code == 500

    text = client.get("/metrics").get_data(as_text=True)

    # The uncaught-exception path must record a 5xx counter sample.
    assert has_sample(
        text,
        "simsys_http_requests_total",
        (
            ("service", "flask_exc_test"),
            ("method", "GET"),
            ("route", "/boom"),
            ("status", "5xx"),
        ),
    ), f"expected 5xx counter for /boom in:\n{text}"


def test_flask_uncaught_exception_not_double_counted():
    """If got_request_exception fires AND after_request runs (e.g. error
    handler returns a Response), the request should be counted exactly
    once."""
    from flask import Flask, jsonify

    from simsys_metrics import install

    app = Flask("flask_exc_double_app")
    app.config["TESTING"] = False
    app.config["PROPAGATE_EXCEPTIONS"] = False
    install(app, service="flask_exc_double", version="0.0.1")

    @app.errorhandler(RuntimeError)
    def _handle_runtime(_exc):
        return jsonify({"error": "runtime"}), 500

    @app.route("/handled")
    def handled():
        raise RuntimeError("handled")

    client = app.test_client()
    response = client.get("/handled")
    assert response.status_code == 500

    text = client.get("/metrics").get_data(as_text=True)
    found = [
        line
        for line in text.splitlines()
        if line.startswith("simsys_http_requests_total")
        and 'route="/handled"' in line
        and 'service="flask_exc_double"' in line
    ]
    assert len(found) == 1, (
        f"expected exactly one /handled counter line (no double-count), got {found}"
    )
    value = float(found[0].rsplit(" ", 1)[1])
    assert value == 1.0, f"expected count=1.0 from a single failed request, got {value}"
