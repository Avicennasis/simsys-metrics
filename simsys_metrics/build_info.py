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
) -> None:
    """Set the build_info gauge to 1 with the supplied labels.

    ``commit`` defaults to :func:`_detect_commit`. ``started_at`` defaults to
    the current UTC timestamp in ISO-8601 seconds precision.
    """
    if commit is None:
        commit = _detect_commit()
    if started_at is None:
        started_at = (
            _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()
        )
    build_info.labels(
        service=service,
        version=version,
        commit=commit,
        started_at=started_at,
    ).set(1)
