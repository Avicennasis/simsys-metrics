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


def test_flask_unhandled_exception_count_is_exactly_one():
    """Symmetry with the double-count test: a single uncaught exception
    must produce a counter value of exactly 1.0, not 2.0 (no double-count
    via after_request running on the InternalServerError response Flask
    synthesises) and not 0.0 (the bug v0.3.1 fixed)."""
    from flask import Flask

    from simsys_metrics import install

    app = Flask("flask_exc_count_app")
    app.config["TESTING"] = False
    app.config["PROPAGATE_EXCEPTIONS"] = False
    install(app, service="flask_exc_count", version="0.0.1")

    @app.route("/blow")
    def blow():
        raise RuntimeError("once")

    client = app.test_client()
    assert client.get("/blow").status_code == 500

    text = client.get("/metrics").get_data(as_text=True)
    found = [
        line
        for line in text.splitlines()
        if line.startswith("simsys_http_requests_total")
        and 'route="/blow"' in line
        and 'service="flask_exc_count"' in line
    ]
    assert len(found) == 1, f"expected one /blow counter line, got {found}"
    value = float(found[0].rsplit(" ", 1)[1])
    assert value == 1.0, f"expected count=1.0 from a single failed request, got {value}"


def test_flask_before_request_exception_records_5xx():
    """If an exception originates in a user's before_request hook (NOT in
    the route handler), the metric still has to be recorded as 5xx with
    the matched route template. before_request runs after URL routing in
    Flask, so `request.url_rule` is already populated when the signal
    fires.

    `install()` registers `_simsys_before` at install time, so by the time
    a user's later before_request hook raises, `g.simsys_start` has
    already been set — meaning the histogram observe is valid.
    """
    from flask import Flask

    from simsys_metrics import install

    app = Flask("flask_before_exc_app")
    app.config["TESTING"] = False
    app.config["PROPAGATE_EXCEPTIONS"] = False
    install(app, service="flask_before_exc", version="0.0.1")

    @app.before_request
    def _user_before():
        # Only blow up on /protected so /metrics scrapes still work.
        from flask import request

        if request.path == "/protected":
            raise RuntimeError("auth failed")

    @app.route("/protected")
    def protected():  # never reached
        return "should not see this"

    client = app.test_client()
    assert client.get("/protected").status_code == 500

    text = client.get("/metrics").get_data(as_text=True)
    found = [
        line
        for line in text.splitlines()
        if line.startswith("simsys_http_requests_total")
        and 'route="/protected"' in line
        and 'status="5xx"' in line
        and 'service="flask_before_exc"' in line
    ]
    assert len(found) == 1, (
        f"expected one /protected 5xx counter (route resolved before handler), "
        f"got {found}"
    )
    value = float(found[0].rsplit(" ", 1)[1])
    assert value == 1.0, f"expected count=1.0, got {value}"


def test_flask_before_request_failure_before_simsys_skips_histogram():
    """When a user registers a before_request hook BEFORE calling
    `install()`, the user's hook runs first. If that hook raises,
    `g.simsys_start` was never set — `_record` must skip the histogram
    observe rather than emitting a 0.0 sample that would skew the
    smallest bucket.

    The counter MUST still increment so the 5xx is visible on dashboards.
    """
    from flask import Flask

    from simsys_metrics import install

    app = Flask("flask_pre_install_before_app")
    app.config["TESTING"] = False
    app.config["PROPAGATE_EXCEPTIONS"] = False

    # Register the user hook BEFORE install() so it sits ahead of
    # _simsys_before in the callback chain.
    @app.before_request
    def _user_before_first():
        from flask import request

        if request.path == "/early":
            raise RuntimeError("early auth failed")

    install(app, service="flask_pre_install_before", version="0.0.1")

    @app.route("/early")
    def early():  # never reached
        return "nope"

    client = app.test_client()
    assert client.get("/early").status_code == 500

    text = client.get("/metrics").get_data(as_text=True)

    # Counter must still record the 5xx.
    counter_lines = [
        line
        for line in text.splitlines()
        if line.startswith("simsys_http_requests_total")
        and 'route="/early"' in line
        and 'status="5xx"' in line
    ]
    assert counter_lines, (
        "expected a /early 5xx counter even when simsys_before never ran"
    )
    assert float(counter_lines[0].rsplit(" ", 1)[1]) == 1.0

    # Histogram observe MUST be skipped — no 0.0-bucket pollution. Either
    # no count line at all, or count is 0.
    histogram_count_lines = [
        line
        for line in text.splitlines()
        if line.startswith("simsys_http_request_duration_seconds_count")
        and 'route="/early"' in line
    ]
    if histogram_count_lines:
        value = float(histogram_count_lines[0].rsplit(" ", 1)[1])
        assert value == 0, (
            f"histogram observe should have been skipped (g.simsys_start "
            f"unset because user before_request failed before _simsys_before "
            f"could run), got count={value}"
        )
