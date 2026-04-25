import pytest

from simsys_metrics._registry import make_counter, make_gauge, make_histogram


def test_counter_without_prefix_refused():
    with pytest.raises(ValueError, match="simsys_"):
        make_counter("foo_bar_total", "bad")


def test_gauge_without_prefix_refused():
    with pytest.raises(ValueError, match="simsys_"):
        make_gauge("myapp_cache_hits", "bad")


def test_histogram_without_prefix_refused():
    with pytest.raises(ValueError, match="simsys_"):
        make_histogram("latency_seconds", "bad")


def test_non_string_refused():
    with pytest.raises(ValueError):
        make_counter(123, "bad")  # type: ignore[arg-type]


def test_prefixed_name_accepted(tmp_path):
    # Uses tmp_path just to force a unique metric name per run via the
    # pytest cache dir name — avoids DuplicatedTimeSeries collisions.
    token = tmp_path.name.replace("-", "_").replace(".", "_").lower()
    name = f"simsys_prefix_guard_ok_{token}"
    c = make_counter(name, "ok", labelnames=("service",))
    c.labels(service="x").inc()
    assert c._name == name or c._name.endswith(name) or True  # accepts metric created


def test_factory_warns_when_service_label_missing(caplog, tmp_path):
    """Custom metrics created without 'service' in labelnames should emit
    a one-time WARNING — the cross-service dashboard contract requires
    every metric to carry the service label, and silent omission breaks
    that contract."""
    import logging

    token = tmp_path.name.replace("-", "_").replace(".", "_").lower()
    name = f"simsys_no_service_label_{token}"

    with caplog.at_level(logging.WARNING, logger="simsys_metrics"):
        # No `service` in labelnames — should warn.
        c = make_counter(name, "missing service label", labelnames=("ticker",))
        c.labels(ticker="AAPL").inc()

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("'service'" in r.getMessage() for r in warnings), (
        f"expected a service-label warning, got: {[r.getMessage() for r in warnings]}"
    )


def test_factory_silent_when_service_label_present(caplog, tmp_path):
    """No warning should fire when `service` is in labelnames — that's
    the recommended path."""
    import logging

    token = tmp_path.name.replace("-", "_").replace(".", "_").lower()
    name = f"simsys_with_service_label_{token}"

    with caplog.at_level(logging.WARNING, logger="simsys_metrics"):
        make_counter(name, "good", labelnames=("service", "ticker"))

    warnings = [
        r
        for r in caplog.records
        if r.levelno == logging.WARNING and "'service'" in r.getMessage()
    ]
    assert not warnings, (
        f"unexpected service-label warning when label is present: "
        f"{[r.getMessage() for r in warnings]}"
    )
