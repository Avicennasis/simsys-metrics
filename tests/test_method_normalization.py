"""HTTP method label must be normalized to a bounded allow-list.

Otherwise an attacker can hammer the app with arbitrary methods
(e.g. `X_AUDIT_1`, `ASDF`, `\\x00\\x00`) and force one new metric
series per distinct value — defeating the package's stated cardinality
discipline.

Allow-list (case-insensitive): RFC 9110 standard methods plus PATCH.
Anything else collapses to ``OTHER``.
"""

from __future__ import annotations

import pytest

fastapi = pytest.importorskip("fastapi")
testclient = pytest.importorskip("fastapi.testclient")
flask = pytest.importorskip("flask")


def test_normalize_method_unit():
    from simsys_metrics._http import normalize_method

    # Standard methods: returned upper-cased
    assert normalize_method("GET") == "GET"
    assert normalize_method("get") == "GET"
    assert normalize_method("Post") == "POST"
    assert normalize_method("PATCH") == "PATCH"
    assert normalize_method("OPTIONS") == "OPTIONS"
    # Non-standard / attacker-controlled: collapse to OTHER
    assert normalize_method("X_AUDIT_1") == "OTHER"
    assert normalize_method("ASDF") == "OTHER"
    assert normalize_method("") == "OTHER"
    # Defensive: non-string input → OTHER
    assert normalize_method(None) == "OTHER"
    assert normalize_method(123) == "OTHER"


def test_fastapi_garbage_methods_collapse_to_OTHER():
    from fastapi import FastAPI

    from simsys_metrics import install

    app = FastAPI()
    install(app, service="method_norm_fastapi", version="0.0.1")

    @app.get("/items/{item_id}")
    def item(item_id: int):
        return {"id": item_id}

    client = testclient.TestClient(app)
    # Send a real GET so the legitimate path series exists.
    client.get("/items/42")

    # Send several garbage methods.
    for garbage in ("X_AUDIT_1", "X_AUDIT_2", "ASDF", "UNDEFINED"):
        client.request(garbage, "/anything")

    text = client.get("/metrics").text

    # Garbage methods must NOT appear as label values.
    for garbage in ("X_AUDIT_1", "X_AUDIT_2", "ASDF", "UNDEFINED"):
        assert f'method="{garbage}"' not in text, (
            f"raw garbage method {garbage!r} leaked as a label value"
        )

    # All garbage requests must collapse into a single OTHER bucket.
    assert 'method="OTHER"' in text, (
        "expected garbage methods to collapse to method=OTHER"
    )


def test_flask_garbage_methods_collapse_to_OTHER():
    from flask import Flask

    from simsys_metrics import install

    app = Flask("flask_method_norm_app")
    install(app, service="method_norm_flask", version="0.0.1")

    @app.route("/known")
    def known():
        return "ok"

    client = app.test_client()
    client.get("/known")

    # Flask test client requires `method=` keyword for arbitrary verbs.
    for garbage in ("X_AUDIT_1", "X_AUDIT_2", "ASDF"):
        client.open("/whatever", method=garbage)

    text = client.get("/metrics").get_data(as_text=True)

    for garbage in ("X_AUDIT_1", "X_AUDIT_2", "ASDF"):
        assert f'method="{garbage}"' not in text, (
            f"raw garbage method {garbage!r} leaked as a Flask label value"
        )
    assert 'method="OTHER"' in text, (
        "expected garbage methods to collapse to method=OTHER (Flask)"
    )
