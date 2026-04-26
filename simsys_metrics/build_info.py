"""simsys_build_info gauge.

Exposes build/version/commit/started_at as a constant gauge of value 1 with
labels. Grafana panels can drive a service picker via
``label_values(simsys_build_info, service)``.
"""

from __future__ import annotations

import datetime as _dt
import os
import shutil
import subprocess
import threading
from typing import Optional

from ._registry import make_gauge

# In multiproc mode, tag build_info as "liveall" so each live pid contributes
# its own sample (labels identify the service; per-pid series are tolerable
# for typical web-app process counts). Outside multiproc mode, omit the kwarg
# to preserve single-process behaviour exactly.
_MULTIPROC = bool(os.environ.get("PROMETHEUS_MULTIPROC_DIR"))

build_info = make_gauge(
    "simsys_build_info",
    "Service build information. Always equal to 1; read labels for actual data.",
    labelnames=("service", "version", "commit", "started_at"),
    multiprocess_mode="liveall" if _MULTIPROC else None,
)

# Module-scoped ownership tracker. When register_build_info() is called
# with a labelset that's already in this set, we know an earlier (still
# live) install added it — was_new=False. On rollback, callers pass
# was_new back to unregister_build_info_if_owned() so we only call
# build_info.remove() when WE were the install that added the sample.
#
# Why this matters: started_at is second-precision, so two installs of
# the same service+version+commit started in the same wall-clock second
# produce identical labelsets. Without ownership tracking, install B's
# rollback would `build_info.remove(*labels)` and silently delete
# install A's still-live sample.
_owned_label_keys: set[tuple[str, str, str, str]] = set()
_owned_label_keys_lock = threading.Lock()


def _detect_commit(cwd: Optional[str] = None) -> str:
    """Best-effort git SHA detection.

    1. ``SIMSYS_BUILD_COMMIT`` env var if set (for container images).
    2. ``git rev-parse --short HEAD`` in ``cwd`` or the current directory.
    3. Literal ``"unknown"`` if git is unavailable or the tree isn't a repo.
    """
    env_commit = os.environ.get("SIMSYS_BUILD_COMMIT", "").strip()
    if env_commit:
        return env_commit

    git = shutil.which("git")
    if not git:
        return "unknown"

    try:
        out = subprocess.run(
            [git, "rev-parse", "--short", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=2.0,
        )
        return out.stdout.strip() or "unknown"
    except (subprocess.SubprocessError, OSError):
        return "unknown"


def register_build_info(
    service: str,
    version: str,
    commit: Optional[str] = None,
    started_at: Optional[str] = None,
) -> tuple[tuple[str, str, str, str], bool]:
    """Set the build_info gauge to 1 with the supplied labels.

    ``commit`` defaults to :func:`_detect_commit`. ``started_at`` defaults to
    the current UTC timestamp in ISO-8601 seconds precision.

    Returns ``(labels, was_new)`` where ``labels`` is the resolved
    ``(service, version, commit, started_at)`` tuple and ``was_new`` is
    ``True`` iff THIS call created the sample (vs. matching an
    already-registered labelset from an earlier still-live install).
    Adapter rollback uses ``was_new`` to decide whether removing the
    sample on failure is safe.
    """
    if commit is None:
        commit = _detect_commit()
    if started_at is None:
        started_at = (
            _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()
        )
    labels = (service, version, commit, started_at)
    with _owned_label_keys_lock:
        was_new = labels not in _owned_label_keys
        if was_new:
            _owned_label_keys.add(labels)
    build_info.labels(
        service=service,
        version=version,
        commit=commit,
        started_at=started_at,
    ).set(1)
    return labels, was_new


def unregister_build_info(
    service: str, version: str, commit: str, started_at: str
) -> None:
    """Remove the exact build_info label-set previously registered.

    Unconditional remove — used by tests and direct callers that know
    they own the sample. Install-rollback paths should call
    :func:`unregister_build_info_if_owned` instead, which respects the
    ownership flag returned from :func:`register_build_info`.
    """
    labels = (service, version, commit, started_at)
    with _owned_label_keys_lock:
        _owned_label_keys.discard(labels)
    try:
        build_info.remove(service, version, commit, started_at)
    except KeyError:
        # Already gone — fine.
        pass


def unregister_build_info_if_owned(
    labels: tuple[str, str, str, str], was_new: bool
) -> None:
    """Drop the build_info sample for ``labels`` ONLY if ``was_new=True``.

    When ``was_new=False``, an earlier still-live install owns this
    labelset and removing it would silently delete that install's
    legitimate sample. Used by install rollback, where two installs in
    the same wall-clock second can produce identical labelsets due to
    second-precision ``started_at``.
    """
    if not was_new:
        return
    with _owned_label_keys_lock:
        _owned_label_keys.discard(labels)
    try:
        build_info.remove(*labels)
    except KeyError:
        pass


def _reset_build_info_ownership_for_tests() -> None:
    """Test-only: clear the labelset ownership tracker."""
    with _owned_label_keys_lock:
        _owned_label_keys.clear()
