import time

import pytest
from prometheus_client import REGISTRY

from simsys_metrics import set_service, track_queue


def test_track_queue_updates_gauge():
    set_service("queue_test_svc")
    depth_value = [7]
    track_queue("inference", depth_fn=lambda: depth_value[0], interval=0.05)
    # Allow the daemon thread one poll cycle.
    deadline = time.time() + 2.0
    while time.time() < deadline:
        v = REGISTRY.get_sample_value(
            "simsys_queue_depth", {"service": "queue_test_svc", "queue": "inference"}
        )
        if v == 7:
            break
        time.sleep(0.05)
    v = REGISTRY.get_sample_value(
        "simsys_queue_depth", {"service": "queue_test_svc", "queue": "inference"}
    )
    assert v == 7


def test_track_queue_requires_install_first():
    with pytest.raises(RuntimeError, match="no service set"):
        track_queue("x", depth_fn=lambda: 1)


def test_track_queue_swallows_depth_fn_exception():
    set_service("queue_test_svc")

    counter = [0]

    def bad():
        counter[0] += 1
        raise RuntimeError("boom")

    track_queue("broken", depth_fn=bad, interval=0.05)
    time.sleep(0.25)
    # Gauge should default to 0 (int coercion of caught exception path).
    v = REGISTRY.get_sample_value(
        "simsys_queue_depth", {"service": "queue_test_svc", "queue": "broken"}
    )
    assert v == 0
    # And the poller kept running (didn't crash after the first raise).
    assert counter[0] >= 2
