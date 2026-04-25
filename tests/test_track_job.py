import pytest
from prometheus_client import REGISTRY

from simsys_metrics import set_service, track_job


def _count(job: str, outcome: str) -> float:
    return (
        REGISTRY.get_sample_value(
            "simsys_jobs_total",
            {"service": "job_test_svc", "job": job, "outcome": outcome},
        )
        or 0.0
    )


def test_track_job_requires_install_first():
    with pytest.raises(RuntimeError, match="no service set"):

        @track_job("x")
        def f():
            return 1

        f()


def test_track_job_decorator_success():
    set_service("job_test_svc")

    @track_job("decorator_ok")
    def add(a, b):
        return a + b

    before = _count("decorator_ok", "success")
    assert add(2, 3) == 5
    assert _count("decorator_ok", "success") == before + 1


def test_track_job_decorator_error_propagates_and_counts():
    set_service("job_test_svc")

    @track_job("decorator_err")
    def boom():
        raise ValueError("nope")

    before = _count("decorator_err", "error")
    with pytest.raises(ValueError):
        boom()
    assert _count("decorator_err", "error") == before + 1


def test_track_job_context_manager_success():
    set_service("job_test_svc")
    before = _count("ctx_ok", "success")
    with track_job("ctx_ok"):
        pass
    assert _count("ctx_ok", "success") == before + 1


def test_track_job_context_manager_error():
    set_service("job_test_svc")
    before = _count("ctx_err", "error")
    with pytest.raises(RuntimeError):
        with track_job("ctx_err"):
            raise RuntimeError("oops")
    assert _count("ctx_err", "error") == before + 1
