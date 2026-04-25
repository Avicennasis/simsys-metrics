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


def test_track_job_async_decorator_success():
    """Async functions wrapped by @track_job should be timed correctly:
    the span exits when the awaited coroutine completes, NOT when the
    coroutine object is returned by the sync wrapper.

    The pre-v0.3.3 wrapper called fn() and exited the span immediately
    on the returned coroutine — turning every async call into an
    instantaneous "success" regardless of whether the underlying
    coroutine eventually raised.
    """
    import asyncio

    set_service("job_test_svc")

    @track_job("async_ok")
    async def add(a, b):
        await asyncio.sleep(0)
        return a + b

    before = _count("async_ok", "success")
    result = asyncio.run(add(2, 3))
    assert result == 5
    assert _count("async_ok", "success") == before + 1


def test_track_job_async_decorator_error_attributed_correctly():
    """Async exceptions must be counted as outcome="error", not "success".

    This is the regression test for the misrecording bug surfaced by the
    Codex audit: previously the sync wrapper's `with _job_span` exited
    when the unawaited coroutine was returned, so the span saw a clean
    return — raising inside the awaited coroutine bumped the SUCCESS
    counter instead of the ERROR counter.
    """
    import asyncio

    set_service("job_test_svc")

    @track_job("async_err")
    async def boom():
        await asyncio.sleep(0)
        raise ValueError("nope")

    success_before = _count("async_err", "success")
    error_before = _count("async_err", "error")

    with pytest.raises(ValueError, match="nope"):
        asyncio.run(boom())

    success_after = _count("async_err", "success")
    error_after = _count("async_err", "error")

    assert error_after == error_before + 1, (
        f"async exception must increment outcome=error counter "
        f"(was {error_before}, now {error_after})"
    )
    assert success_after == success_before, (
        f"async exception must NOT increment outcome=success counter "
        f"(was {success_before}, now {success_after} — this is the bug)"
    )


def test_track_job_async_via_functools_partial():
    """track_job must detect coroutine-ness through functools.partial.

    `functools.partial(async_fn, ...)` is itself NOT an `async def`
    callable, but calling it returns a coroutine. inspect.iscoroutinefunction
    sees through the partial via __wrapped__; asyncio.iscoroutinefunction
    historically did not on older Python. The fix in v0.3.5 swapped to
    inspect.iscoroutinefunction so consumers using partial-wrapped async
    handlers (a common pattern when binding default args) don't regress
    into the v0.3.2 misrecording bug.
    """
    import asyncio
    import functools

    set_service("job_test_svc")

    async def real_async(arg):
        await asyncio.sleep(0)
        if arg == "boom":
            raise ValueError("partial async error")
        return arg

    bound = functools.partial(real_async, "boom")

    # Apply track_job to the partial — the tracker should detect coroutine
    # and use the async wrapper.
    wrapped = track_job("partial_async_err")(bound)

    success_before = _count("partial_async_err", "success")
    error_before = _count("partial_async_err", "error")

    with pytest.raises(ValueError, match="partial async error"):
        asyncio.run(wrapped())

    assert _count("partial_async_err", "error") == error_before + 1, (
        "partial-wrapped async exception must increment error counter"
    )
    assert _count("partial_async_err", "success") == success_before, (
        "partial-wrapped async exception must NOT increment success counter"
    )


def test_track_job_async_via_callable_instance():
    """track_job must detect coroutine-ness on instances whose __call__
    is `async def`.
    """
    import asyncio

    set_service("job_test_svc")

    class AsyncCaller:
        async def __call__(self, x):
            await asyncio.sleep(0)
            raise RuntimeError(f"instance fail: {x}")

    instance = AsyncCaller()
    wrapped = track_job("async_callable_instance_err")(instance)

    error_before = _count("async_callable_instance_err", "error")
    success_before = _count("async_callable_instance_err", "success")

    with pytest.raises(RuntimeError, match="instance fail"):
        asyncio.run(wrapped("x"))

    assert _count("async_callable_instance_err", "error") == error_before + 1
    assert _count("async_callable_instance_err", "success") == success_before
