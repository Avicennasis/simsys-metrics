"""Cardinality regression: 404 / unmatched paths must collapse to one bucket.

Scanner traffic (e.g. /wp-admin, /.env) hammering an app must not blow out the
route label space. The contract is: when no route template matched, the
route label is the literal "__unmatched__".
"""

from __future__ import annotations

import pytest

from tests.conftest import has_sample

fastapi = pytest.importorskip("fastapi")
testclient = pytest.importorskip("fastapi.testclient")
flask = pytest.importorskip("flask")


def test_fastapi_404_collapses_to_unmatched_route_label():
    from fastapi import FastAPI

    from simsys_metrics import install

    app = FastAPI()
    install(app, service="unmatched_test_fastapi", version="0.0.1")

    client = testclient.TestClient(app)
    # None of these should appear as distinct route labels.
    for path in ("/wp-admin", "/.env", "/wp-login.php", "/admin/.git/config"):
        assert client.get(path).status_code == 404

    text = client.get("/metrics").text

    assert has_sample(
        text,
        "simsys_http_requests_total",
        (
            ("service", "unmatched_test_fastapi"),
            ("route", "__unmatched__"),
            ("status", "4xx"),
        ),
    )
    # Hard guarantee: none of the raw scanner paths leak into a label.
    for leaked in ("/wp-admin", "/.env", "/wp-login.php", "/admin/.git/config"):
        assert f'route="{leaked}"' not in text, (
            f"raw path {leaked!r} leaked as a route label"
        )


def test_flask_404_collapses_to_unmatched_route_label():
    from flask import Flask

    from simsys_metrics import install

    app = Flask("unmatched_test_flask")
    install(app, service="unmatched_test_flask", version="0.0.1")

    client = app.test_client()
    for path in ("/wp-admin", "/.env", "/wp-login.php"):
        assert client.get(path).status_code == 404

    text = client.get("/metrics").get_data(as_text=True)
    assert has_sample(
        text,
        "simsys_http_requests_total",
        (
            ("service", "unmatched_test_flask"),
            ("route", "__unmatched__"),
            ("status", "4xx"),
        ),
    )
    for leaked in ("/wp-admin", "/.env", "/wp-login.php"):
        assert f'route="{leaked}"' not in text, (
            f"raw path {leaked!r} leaked as a route label"
        )
