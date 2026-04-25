"""Tests for simsys_metrics.progress (track_progress + ProgressTracker)."""

from __future__ import annotations

import time

import pytest
from prometheus_client import REGISTRY

from simsys_metrics import ProgressOpts, set_service, track_progress


def _sample(name: str, **labels: str) -> float | None:
    return REGISTRY.get_sample_value(name, labels)


def test_track_progress_emits_seed_gauges():
    """Right after track_progress(), gauges exist at their starting values."""
    set_service("prog_test_seed")
    t = track_progress(ProgressOpts(operation="scan-seed", total=100, interval=0.05))
    try:
        assert (
            _sample(
                "simsys_progress_remaining",
                service="prog_test_seed",
                operation="scan-seed",
            )
            == 100
        )
        assert (
            _sample(
                "simsys_progress_rate_per_second",
                service="prog_test_seed",
                operation="scan-seed",
            )
            == 0
        )
        assert (
            _sample(
                "simsys_progress_estimated_completion_timestamp",
                service="prog_test_seed",
                operation="scan-seed",
            )
            == 0
        )
    finally:
        t.stop()


def test_track_progress_inc_updates_counter_and_remaining():
    set_service("prog_test_inc")
    t = track_progress(ProgressOpts(operation="scan-inc", total=10, interval=0.05))
    try:
        t.inc(3)
        t.inc(2)
        # processed counter is immediate (no wait for loop tick).
        assert (
            _sample(
                "simsys_progress_processed_total",
                service="prog_test_inc",
                operation="scan-inc",
            )
            == 5
        )

        # remaining updates on the loop tick — wait for one.
        deadline = time.time() + 2.0
        while time.time() < deadline:
            v = _sample(
                "simsys_progress_remaining",
                service="prog_test_inc",
                operation="scan-inc",
            )
            if v == 5:
                break
            time.sleep(0.05)
        assert (
            _sample(
                "simsys_progress_remaining",
                service="prog_test_inc",
                operation="scan-inc",
            )
            == 5
        )
    finally:
        t.stop()


def test_track_progress_rate_and_eta_nonzero_after_work():
    set_service("prog_test_rate")
    t = track_progress(
        ProgressOpts(operation="scan-rate", total=1000, interval=0.05, window=0.1)
    )
    try:
        # Do several inc()s spread over time to let the EWMA settle.
        for _ in range(20):
            t.inc(5)
            time.sleep(0.02)

        # Wait for another tick to roll in.
        deadline = time.time() + 2.0
        while time.time() < deadline:
            rate = _sample(
                "simsys_progress_rate_per_second",
                service="prog_test_rate",
                operation="scan-rate",
            )
            if rate and rate > 0:
                break
            time.sleep(0.05)
        rate = _sample(
            "simsys_progress_rate_per_second",
            service="prog_test_rate",
            operation="scan-rate",
        )
        assert rate > 0, f"expected positive rate, got {rate}"

        eta = _sample(
            "simsys_progress_estimated_completion_timestamp",
            service="prog_test_rate",
            operation="scan-rate",
        )
        # ETA should be in the future (rate>0, remaining>0).
        assert eta > time.time(), f"expected future ETA, got {eta} (now={time.time()})"
    finally:
        t.stop()


def test_track_progress_set_total_updates_denominator():
    set_service("prog_test_settotal")
    t = track_progress(
        ProgressOpts(operation="scan-settotal", total=100, interval=0.05)
    )
    try:
        t.inc(10)
        t.set_total(500)

        deadline = time.time() + 2.0
        while time.time() < deadline:
            v = _sample(
                "simsys_progress_remaining",
                service="prog_test_settotal",
                operation="scan-settotal",
            )
            if v == 490:
                break
            time.sleep(0.05)
        assert (
            _sample(
                "simsys_progress_remaining",
                service="prog_test_settotal",
                operation="scan-settotal",
            )
            == 490
        )
    finally:
        t.stop()


def test_track_progress_stop_is_idempotent():
    set_service("prog_test_stop")
    t = track_progress(ProgressOpts(operation="scan-stop", total=10, interval=0.05))
    t.stop()
    t.stop()  # must not raise


def test_track_progress_requires_install_first():
    """Like track_queue, track_progress reads the service global."""
    # Must test in a clean state — the autouse conftest fixture resets this.
    with pytest.raises(RuntimeError, match="no service set"):
        track_progress(ProgressOpts(operation="x", total=1))


def test_track_progress_rejects_bad_opts():
    set_service("prog_test_bad")
    with pytest.raises(ValueError, match="total"):
        track_progress(ProgressOpts(operation="x", total=-1))
    with pytest.raises(ValueError, match="window"):
        track_progress(ProgressOpts(operation="x", total=1, window=0))
    with pytest.raises(ValueError, match="interval"):
        track_progress(ProgressOpts(operation="x", total=1, interval=0))


def test_track_progress_inc_rejects_negative():
    set_service("prog_test_neg")
    t = track_progress(ProgressOpts(operation="x", total=10, interval=0.05))
    try:
        with pytest.raises(ValueError, match="n must"):
            t.inc(-1)
    finally:
        t.stop()


def test_track_progress_inc_rejects_nan_inf():
    """inc() must reject nan/inf — the previous `< 0` check let nan
    through (nan < 0 is False per IEEE-754) and the value propagated
    into the exported counter, yielding lines like
    `simsys_progress_processed_total ... nan` that downstream alerting
    cannot reason about.
    """
    import math

    set_service("prog_test_inc_nan_inf")
    t = track_progress(ProgressOpts(operation="inc_nan", total=10, interval=0.05))
    try:
        with pytest.raises(ValueError, match="finite"):
            t.inc(math.nan)
        with pytest.raises(ValueError, match="finite"):
            t.inc(math.inf)
        with pytest.raises(ValueError, match="finite"):
            t.inc(-math.inf)
    finally:
        t.stop()


def test_track_progress_set_total_rejects_nan_inf():
    import math

    set_service("prog_test_set_total_nan_inf")
    t = track_progress(ProgressOpts(operation="set_total_nan", total=10, interval=0.05))
    try:
        with pytest.raises(ValueError, match="finite"):
            t.set_total(math.nan)
        with pytest.raises(ValueError, match="finite"):
            t.set_total(math.inf)
        with pytest.raises(ValueError, match="finite"):
            t.set_total(-math.inf)
    finally:
        t.stop()


def test_track_progress_rejects_nan_inf_intervals():
    """NaN passes `<= 0` vacuously, Infinity is positive non-finite —
    both would start a daemon thread that later crashes inside Event.wait
    (NaN) or never wakes up (inf). Reject at construction time."""
    import math

    set_service("prog_test_nan_inf")
    with pytest.raises(ValueError, match="positive finite number"):
        track_progress(ProgressOpts(operation="x", total=1, interval=math.nan))
    with pytest.raises(ValueError, match="positive finite number"):
        track_progress(ProgressOpts(operation="x", total=1, interval=math.inf))
    with pytest.raises(ValueError, match="positive finite number"):
        track_progress(ProgressOpts(operation="x", total=1, interval=-math.inf))
    with pytest.raises(ValueError, match="positive finite number"):
        track_progress(ProgressOpts(operation="x", total=1, window=math.nan))
    with pytest.raises(ValueError, match="positive finite number"):
        track_progress(ProgressOpts(operation="x", total=1, window=math.inf))
    with pytest.raises(ValueError, match="finite number"):
        track_progress(ProgressOpts(operation="x", total=math.nan))
    with pytest.raises(ValueError, match="finite number"):
        track_progress(ProgressOpts(operation="x", total=math.inf))
