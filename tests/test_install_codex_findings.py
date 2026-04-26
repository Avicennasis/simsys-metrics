"""Regression coverage for the v0.3.9 Codex audit findings (Python side).

F3 (build_info ownership)
    Two installs of the same service+version+commit started in the same
    wall-clock second share a labelset (started_at is second-precision).
    Pre-fix, install B's rollback unconditionally called
    ``build_info.remove(*labels)`` and silently deleted install A's
    still-live sample. Fix: register_build_info returns ``(labels, was_new)``
    and rollback uses ``unregister_build_info_if_owned`` which respects
    the flag.

F4 (process collector swap rollback)
    Pre-fix, ``register_process_collector`` returned ``(_, was_new=True)``
    on a service-swap and rollback called ``unregister_process_collector()``,
    leaving NO process collector at all — service A's metrics disappeared
    when B's install failed. Fix: ``register_process_collector`` now
    returns rollback state capturing the prior collector; rollback's
    ``restore_process_collector`` re-registers it on swap-then-fail.
"""

from __future__ import annotations

import pytest

fastapi = pytest.importorskip("fastapi")


def test_register_build_info_same_second_collision_does_not_lose_prior_sample():
    """Two installs of the same service share a labelset when started in
    the same wall-clock second. Install B's rollback (was_new=False)
    must NOT delete install A's still-live sample.
    """
    from prometheus_client import REGISTRY

    from simsys_metrics.build_info import (
        _reset_build_info_ownership_for_tests,
        build_info,
        register_build_info,
        unregister_build_info_if_owned,
    )

    _reset_build_info_ownership_for_tests()
    # Drop any leftover labelset from a previous test run with the same labels.
    try:
        build_info.remove("collide_svc", "1.0", "abc", "2026-01-01T00:00:00+00:00")
    except KeyError:
        pass

    labels_a, was_new_a = register_build_info(
        service="collide_svc",
        version="1.0",
        commit="abc",
        started_at="2026-01-01T00:00:00+00:00",
    )
    assert was_new_a is True

    # Install B in the same second — identical labels.
    labels_b, was_new_b = register_build_info(
        service="collide_svc",
        version="1.0",
        commit="abc",
        started_at="2026-01-01T00:00:00+00:00",
    )
    assert was_new_b is False, (
        "second register_build_info with identical labels must report was_new=False"
    )
    assert labels_a == labels_b

    # B's rollback (was_new=False) must be a no-op so A's sample lives.
    unregister_build_info_if_owned(labels_b, was_new_b)
    val = REGISTRY.get_sample_value(
        "simsys_build_info",
        {
            "service": "collide_svc",
            "version": "1.0",
            "commit": "abc",
            "started_at": "2026-01-01T00:00:00+00:00",
        },
    )
    assert val == 1.0, "rollback of B (was_new=False) wiped A's still-live sample"

    # A's rollback (was_new=True) DOES remove it.
    unregister_build_info_if_owned(labels_a, was_new_a)
    val = REGISTRY.get_sample_value(
        "simsys_build_info",
        {
            "service": "collide_svc",
            "version": "1.0",
            "commit": "abc",
            "started_at": "2026-01-01T00:00:00+00:00",
        },
    )
    assert val is None, "rollback of A (was_new=True) should remove the sample"


def test_process_collector_swap_rollback_restores_prior_service():
    """Service-swap-then-fail must restore the prior service's collector,
    not unregister it entirely. Pre-fix, rollback called
    ``unregister_process_collector()`` and left the registry with no
    process collector at all — service A's process metrics disappeared.
    """
    from prometheus_client import REGISTRY

    from simsys_metrics._process import (
        register_process_collector,
        restore_process_collector,
        unregister_process_collector,
    )

    unregister_process_collector()  # clean slate

    _, state_a = register_process_collector("proc_svc_a")
    assert state_a.action == "registered"

    # Service A's process metrics are present.
    a_cpu = REGISTRY.get_sample_value(
        "simsys_process_cpu_seconds_total", {"service": "proc_svc_a"}
    )
    assert a_cpu is not None

    # Install B service-swaps the singleton.
    _, state_b = register_process_collector("proc_svc_b")
    assert state_b.action == "service_swap"

    # B's metrics flow now; A's are gone (the collector was unregistered).
    b_cpu = REGISTRY.get_sample_value(
        "simsys_process_cpu_seconds_total", {"service": "proc_svc_b"}
    )
    assert b_cpu is not None
    assert (
        REGISTRY.get_sample_value(
            "simsys_process_cpu_seconds_total", {"service": "proc_svc_a"}
        )
        is None
    )

    # Roll back B (simulates B's install_fastapi failing post-swap).
    restore_process_collector(state_b)

    # A's process metrics are back; B's are gone.
    a_cpu_after = REGISTRY.get_sample_value(
        "simsys_process_cpu_seconds_total", {"service": "proc_svc_a"}
    )
    assert a_cpu_after is not None, (
        "rollback of swapped install B did not restore service A's collector"
    )
    assert (
        REGISTRY.get_sample_value(
            "simsys_process_cpu_seconds_total", {"service": "proc_svc_b"}
        )
        is None
    )

    # Cleanup.
    unregister_process_collector()


def test_fastapi_swap_then_fail_preserves_prior_app_process_metrics(monkeypatch):
    """End-to-end: install A on app1 with service=A, install B on app2 with
    service=B fails after register_process_collector swaps the
    singleton. After rollback, app_a's /metrics still emits
    simsys_process_* lines for service="proc_swap_a".
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from prometheus_fastapi_instrumentator import Instrumentator

    from simsys_metrics import install
    from simsys_metrics._baseline import _reset_for_tests as _reset_base
    from simsys_metrics._process import unregister_process_collector
    from simsys_metrics.build_info import _reset_build_info_ownership_for_tests

    unregister_process_collector()
    _reset_base()
    _reset_build_info_ownership_for_tests()

    app_a = FastAPI()
    install(app_a, service="proc_swap_a", version="1.0")

    # Sanity: app_a's process metrics are present.
    text_pre = TestClient(app_a).get("/metrics").text
    assert any(
        line.startswith("simsys_process_cpu_seconds_total")
        and 'service="proc_swap_a"' in line
        for line in text_pre.splitlines()
    ), "baseline: app_a should have process metrics before B's install"

    # Force install B to fail post-swap.
    real_expose = Instrumentator.expose
    fail_state = {"hit": 0}

    def flaky_expose(self, *args, **kwargs):
        fail_state["hit"] += 1
        if fail_state["hit"] == 1:
            raise RuntimeError("forced expose failure for swap rollback test")
        return real_expose(self, *args, **kwargs)

    monkeypatch.setattr(Instrumentator, "expose", flaky_expose)

    app_b = FastAPI()
    with pytest.raises(RuntimeError, match="forced expose failure"):
        install(app_b, service="proc_swap_b", version="1.0")

    # After rollback, app_a's process metrics MUST still be exposed.
    text_post = TestClient(app_a).get("/metrics").text
    a_proc_lines = [
        line
        for line in text_post.splitlines()
        if line.startswith("simsys_process_") and 'service="proc_swap_a"' in line
    ]
    proc_excerpt = "\n".join(
        line for line in text_post.splitlines() if "simsys_process_" in line
    )[:1500]
    assert a_proc_lines, (
        "rollback of B's failed install left app_a without process metrics. "
        f"Sample of /metrics:\n{proc_excerpt}"
    )
    # And service B's process samples must be gone.
    b_proc_lines = [
        line
        for line in text_post.splitlines()
        if line.startswith("simsys_process_") and 'service="proc_swap_b"' in line
    ]
    assert not b_proc_lines, (
        f"rollback did not drop service B's process metrics: {b_proc_lines}"
    )


def test_fastapi_same_second_install_failure_preserves_prior_build_info(monkeypatch):
    """End-to-end: install A on app1 succeeds; install B on app2 (same
    service/version/commit, same wall-clock second) fails. The
    rollback's call to unregister_build_info_if_owned must respect
    was_new=False and leave app_a's build_info sample in place.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from prometheus_fastapi_instrumentator import Instrumentator

    from simsys_metrics import install
    from simsys_metrics._baseline import _reset_for_tests as _reset_base
    from simsys_metrics._process import unregister_process_collector
    from simsys_metrics.build_info import _reset_build_info_ownership_for_tests

    unregister_process_collector()
    _reset_base()
    _reset_build_info_ownership_for_tests()

    # Pin commit + started_at by env + by a frozen time. Easiest:
    # patch register_build_info to feed identical started_at to both
    # installs, simulating same-second timing without a flaky sleep.
    import simsys_metrics.build_info as bi_mod

    real_register_build_info = bi_mod.register_build_info

    def pinned(*args, started_at=None, **kwargs):
        return real_register_build_info(
            *args, started_at="2026-04-26T00:00:00+00:00", **kwargs
        )

    # Patch wherever the adapters import register_build_info from.
    monkeypatch.setattr(
        "simsys_metrics.fastapi.register_build_info", pinned, raising=True
    )

    app_a = FastAPI()
    install(app_a, service="bi_collide", version="1.0", commit="cafef00d")

    # Verify A's sample is present.
    text_a = TestClient(app_a).get("/metrics").text
    a_bi_lines = [
        line
        for line in text_a.splitlines()
        if line.startswith("simsys_build_info{") and 'service="bi_collide"' in line
    ]
    assert len(a_bi_lines) == 1

    # Force B to fail post-build_info.
    real_expose = Instrumentator.expose
    fail_state = {"hit": 0}

    def flaky_expose(self, *args, **kwargs):
        fail_state["hit"] += 1
        if fail_state["hit"] == 1:
            raise RuntimeError("forced expose failure for build_info collision test")
        return real_expose(self, *args, **kwargs)

    monkeypatch.setattr(Instrumentator, "expose", flaky_expose)

    app_b = FastAPI()
    with pytest.raises(RuntimeError, match="forced expose failure"):
        install(app_b, service="bi_collide", version="1.0", commit="cafef00d")

    # A's build_info sample must STILL be present after B's rollback.
    text_after = TestClient(app_a).get("/metrics").text
    surviving_bi_lines = [
        line
        for line in text_after.splitlines()
        if line.startswith("simsys_build_info{") and 'service="bi_collide"' in line
    ]
    assert len(surviving_bi_lines) == 1, (
        "B's rollback wiped A's build_info sample (same-second labelset "
        f"collision); surviving lines: {surviving_bi_lines}"
    )
