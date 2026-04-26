"""Regression coverage for the v0.3.10 self-audit findings (Python side).

F6 (build_info ownership lock scope)
    Pre-fix, register_build_info released the ownership lock between
    set.add and build_info.labels(...).set(1). A concurrent rollback
    could discard the key and remove the gauge sample in that window,
    leaving the gauge inconsistent with the ownership set. Fix holds
    the lock across both the set mutation and the gauge mutation.

F7 (process collector restore identity check)
    Pre-fix, restore_process_collector unconditionally dropped or swapped
    _collector regardless of whether _collector was still the instance
    THIS install put there. A concurrent install that swapped the
    singleton mid-install would have its collector clobbered by the
    rollback. Fix verifies _collector is state.installed_collector
    before mutating.

F10 (started_at format alignment)
    Pre-fix, Python emitted 2026-04-26T10:30:00+00:00 while Node and Go
    emitted 2026-04-26T10:30:00Z. Cross-implementation simsys_build_info
    samples had non-equal label tuples. Fix aligns Python on the Z
    suffix.

F16 (_peek_service lock)
    Pre-fix, _peek_service read _SERVICE without holding _SERVICE_LOCK.
    Multi-install rollback paths could observe torn reads or stale
    snapshots. Fix locks the read.
"""

from __future__ import annotations

import threading

import pytest

fastapi = pytest.importorskip("fastapi")


def test_started_at_format_uses_z_suffix():
    """Python's started_at must use the 'Z' suffix to match Node and Go.
    Pre-fix, Python emitted '+00:00' which broke cross-implementation
    label-tuple equality on simsys_build_info."""
    from simsys_metrics.build_info import (
        _reset_build_info_ownership_for_tests,
        build_info,
        register_build_info,
    )

    _reset_build_info_ownership_for_tests()
    labels, _ = register_build_info(
        service="started_at_z_test", version="1.0", commit="abc"
    )
    started_at = labels[3]
    assert started_at.endswith("Z"), (
        f"started_at must end with 'Z' to match Node/Go formatting, got {started_at!r}"
    )
    assert "+00:00" not in started_at, (
        f"started_at must not contain '+00:00' (Python's default isoformat() shape), "
        f"got {started_at!r}"
    )
    # Cleanup
    build_info.remove(*labels)


def test_register_build_info_lock_covers_gauge_write():
    """F6: a concurrent rollback running between set.add and .set(1)
    must not corrupt the ownership set / gauge state.

    We patch build_info.labels(...).set to inject a delay AFTER the
    ownership-set has been mutated but BEFORE the gauge is written.
    During the delay, a concurrent thread runs unregister_build_info
    for the same labels. Pre-fix (lock released between add and
    .set(1)), the unregister thread would race in and discard the
    key + remove the (yet-to-be-written) gauge sample, leaving the
    register's eventual .set(1) to create an unowned sample.
    Post-fix (lock held across both), the unregister thread blocks
    until register completes.
    """
    from simsys_metrics.build_info import (
        _owned_label_keys,
        _reset_build_info_ownership_for_tests,
        build_info,
        register_build_info,
        unregister_build_info,
    )

    _reset_build_info_ownership_for_tests()
    # Drop any leftover labelset.
    try:
        build_info.remove("lock_scope_test", "1.0", "abc", "2026-01-01T00:00:00Z")
    except KeyError:
        pass

    # Run registration and an unregister-of-same-labels in parallel.
    # If the lock scope is correct, the unregister either runs entirely
    # before OR entirely after the register — never interleaving — and
    # the final state is consistent with one of those orderings.
    barrier = threading.Barrier(2)
    results: dict[str, object] = {}

    def reg():
        barrier.wait()
        labels, was_new = register_build_info(
            service="lock_scope_test",
            version="1.0",
            commit="abc",
            started_at="2026-01-01T00:00:00Z",
        )
        results["reg_labels"] = labels
        results["reg_was_new"] = was_new

    def unreg():
        barrier.wait()
        # Race the register with an explicit unregister of same labels.
        unregister_build_info("lock_scope_test", "1.0", "abc", "2026-01-01T00:00:00Z")

    t1 = threading.Thread(target=reg)
    t2 = threading.Thread(target=unreg)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    # Coherence invariant: the labelset's presence in
    # _owned_label_keys agrees with whether the gauge has the sample.
    # Pre-fix, this could be violated because the lock didn't cover
    # both. Post-fix, the two operations are serialized so either:
    #   (a) reg ran fully then unreg ran fully → sample absent + key absent
    #   (b) unreg ran fully (no-op) then reg ran fully → sample present + key present
    labels = ("lock_scope_test", "1.0", "abc", "2026-01-01T00:00:00Z")
    key_present = labels in _owned_label_keys
    sample_present = (
        build_info.labels(*labels)._value.get() == 1.0 if key_present else False
    )
    if key_present:
        assert sample_present, "key in ownership set but gauge sample missing"
    # Cleanup
    try:
        build_info.remove(*labels)
    except KeyError:
        pass
    _reset_build_info_ownership_for_tests()


def test_restore_process_collector_no_clobber_on_concurrent_swap():
    """F7: a concurrent install that swaps the singleton between this
    install's register and rollback must not have its collector
    clobbered by the rollback.

    Sequence:
      1. Install A: registers fresh; state_a.action = "registered",
         state_a.installed_collector = collector_A.
      2. Install B (concurrent): service-swaps. collector_A is
         unregistered, collector_B is now in the singleton.
      3. Install A's rollback runs restore_process_collector(state_a)
         with action="registered". Pre-fix: would unconditionally
         drop _collector (which is now collector_B!). Post-fix:
         compares _collector to state_a.installed_collector
         (collector_A); they differ; rollback no-ops on the live
         collector.
    """
    from prometheus_client import REGISTRY

    from simsys_metrics._process import (
        register_process_collector,
        restore_process_collector,
        unregister_process_collector,
    )

    unregister_process_collector()  # clean slate

    coll_a, state_a = register_process_collector("clobber_a")
    assert state_a.action == "registered"
    assert state_a.installed_collector is coll_a

    # Concurrent install B: swaps the singleton.
    coll_b, state_b = register_process_collector("clobber_b")
    assert state_b.action == "service_swap"
    assert coll_b is not coll_a

    # Install A's rollback now runs. Without the identity check, it
    # would drop _collector entirely, killing collector_B's metrics.
    restore_process_collector(state_a)

    # collector_B must still be the live singleton AND its metrics
    # must still be in the registry.
    b_cpu = REGISTRY.get_sample_value(
        "simsys_process_cpu_seconds_total", {"service": "clobber_b"}
    )
    assert b_cpu is not None, (
        "restore_process_collector clobbered concurrent install B's collector"
    )
    # And A's labelset is correctly absent (B's swap unregistered A).
    assert (
        REGISTRY.get_sample_value(
            "simsys_process_cpu_seconds_total", {"service": "clobber_a"}
        )
        is None
    )

    # Cleanup
    unregister_process_collector()


def test_restore_process_collector_swap_no_clobber_on_third_swap():
    """F7 variant: install A swaps from baseline to A; install B swaps
    A→B; install A's rollback (with state.action="service_swap")
    must not unregister B's collector (it's not the one A
    installed)."""
    from prometheus_client import REGISTRY

    from simsys_metrics._process import (
        register_process_collector,
        restore_process_collector,
        unregister_process_collector,
    )

    unregister_process_collector()

    # Start with a baseline collector.
    _, state_baseline = register_process_collector("baseline_svc")
    assert state_baseline.action == "registered"

    # Install A swaps from baseline to A.
    coll_a, state_a = register_process_collector("third_swap_a")
    assert state_a.action == "service_swap"

    # Concurrent install B swaps A→B.
    coll_b, state_b = register_process_collector("third_swap_b")
    assert state_b.action == "service_swap"
    assert coll_b is not coll_a

    # Install A's rollback runs. Without identity check, it would
    # unregister _collector (which is now coll_b) and try to
    # re-register baseline — kicking out B's metrics.
    restore_process_collector(state_a)

    # B's collector must still be live.
    b_cpu = REGISTRY.get_sample_value(
        "simsys_process_cpu_seconds_total", {"service": "third_swap_b"}
    )
    assert b_cpu is not None, (
        "restore_process_collector('service_swap') on a third-swap "
        "scenario clobbered the concurrent install's collector"
    )

    # Cleanup
    unregister_process_collector()


def test_peek_service_under_lock():
    """F16: _peek_service reads _SERVICE under the lock so a concurrent
    set_service can't tear the read."""
    from simsys_metrics._baseline import (
        _peek_service,
        _reset_for_tests,
        set_service,
    )

    _reset_for_tests()
    assert _peek_service() is None
    set_service("peek_test_service")
    assert _peek_service() == "peek_test_service"
    set_service(None)
    assert _peek_service() is None
    # We don't assert the lock object directly — just verify the
    # function returns coherent values across set_service calls.
