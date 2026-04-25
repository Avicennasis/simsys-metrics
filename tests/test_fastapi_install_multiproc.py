"""Multiproc-mode install_fastapi() tests.

prometheus_client's multiprocess mode requires that:
  * ``PROMETHEUS_MULTIPROC_DIR`` is set BEFORE any metric objects are created.
  * Metric values are written to per-process .db files in that directory.

Our package creates its metric objects at module-import time, so the env
var must be set before ``simsys_metrics`` is first imported. This test
suite is therefore run in a subprocess so it gets a cold interpreter
where the env var is visible to every subsequent import.
"""

from __future__ import annotations

import subprocess
import sys

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("fastapi.testclient")


_SUBPROCESS_SCRIPT = r"""
import json
import os
import sys

# Sanity check: the env var the parent set must be visible here.
assert os.environ.get("PROMETHEUS_MULTIPROC_DIR"), \
    "PROMETHEUS_MULTIPROC_DIR not inherited into subprocess"

from fastapi import FastAPI
from fastapi.testclient import TestClient

from simsys_metrics import install, track_job


app = FastAPI()
install(app, service="mp_test_svc", version="0.0.1", commit="mpsha")


@track_job("mp_job")
def do_work():
    return "ok"


# Exercise the job decorator inline so simsys_jobs_total should be non-zero.
do_work()
do_work()
do_work()

client = TestClient(app)
r = client.get("/metrics")
assert r.status_code == 200, f"/metrics returned {r.status_code}"

body = r.text

# Parse metric names present in the exposition text (minus # lines).
names = set()
for line in body.splitlines():
    if not line or line.startswith("#"):
        continue
    name = line.split("{", 1)[0].split(" ", 1)[0]
    if name:
        names.add(name)

# Count simsys_jobs_total samples (sum of sample values for the success series).
jobs_total_success = 0.0
for line in body.splitlines():
    if line.startswith("#") or not line.startswith("simsys_jobs_total"):
        continue
    if 'job="mp_job"' in line and 'outcome="success"' in line:
        try:
            jobs_total_success += float(line.rsplit(" ", 1)[1])
        except ValueError:
            pass

result = {
    "status_code": r.status_code,
    "content_type": r.headers.get("content-type", ""),
    "has_build_info": "simsys_build_info" in names,
    "has_jobs_total": "simsys_jobs_total" in names,
    "has_process_cpu": "simsys_process_cpu_seconds_total" in names,
    "has_process_memory": "simsys_process_memory_bytes" in names,
    "has_process_open_fds": "simsys_process_open_fds" in names,
    "jobs_total_success": jobs_total_success,
    "sample_names": sorted(n for n in names if n.startswith("simsys_"))[:30],
}

sys.stdout.write("BEGIN_JSON\n")
sys.stdout.write(json.dumps(result))
sys.stdout.write("\nEND_JSON\n")
"""


def _run_subprocess_with_multiproc_dir(multiproc_dir: str) -> dict:
    """Run the subprocess script with PROMETHEUS_MULTIPROC_DIR set, parse JSON."""
    import json as _json

    env = dict(**__import__("os").environ)
    env["PROMETHEUS_MULTIPROC_DIR"] = multiproc_dir
    # Isolate: avoid inheriting pytest's PYTHONDONTWRITEBYTECODE drift, but do
    # keep PYTHONPATH so the in-tree package is importable.
    completed = subprocess.run(
        [sys.executable, "-c", _SUBPROCESS_SCRIPT],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert completed.returncode == 0, (
        f"subprocess failed rc={completed.returncode}\n"
        f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
    )
    marker_start = completed.stdout.find("BEGIN_JSON\n")
    marker_end = completed.stdout.find("\nEND_JSON\n")
    assert marker_start != -1 and marker_end != -1, (
        f"no JSON markers in subprocess stdout:\n{completed.stdout}"
    )
    payload = completed.stdout[marker_start + len("BEGIN_JSON\n") : marker_end]
    return _json.loads(payload)


def test_multiproc_install_mounts_metrics(tmp_path):
    """/metrics returns 200 with Prometheus exposition format in multiproc mode."""
    result = _run_subprocess_with_multiproc_dir(str(tmp_path))
    assert result["status_code"] == 200
    # CONTENT_TYPE_LATEST starts with 'text/plain' per prometheus_client.
    assert result["content_type"].startswith("text/plain"), result["content_type"]


def test_multiproc_install_records_jobs_total(tmp_path):
    """track_job() increments simsys_jobs_total visibly via the /metrics scrape."""
    result = _run_subprocess_with_multiproc_dir(str(tmp_path))
    assert result["has_jobs_total"], (
        "simsys_jobs_total absent from /metrics; "
        f"saw simsys_* = {result['sample_names']}"
    )
    # We called do_work() three times in the child; the livesum aggregate
    # should therefore be >= 3. Use >= because Counter sum across workers.
    assert result["jobs_total_success"] >= 3.0, (
        f"simsys_jobs_total{{outcome=success}} = {result['jobs_total_success']}; "
        "expected >= 3"
    )


def test_multiproc_install_emits_build_info(tmp_path):
    """simsys_build_info still present (Gauge with multiprocess_mode='liveall')."""
    result = _run_subprocess_with_multiproc_dir(str(tmp_path))
    assert result["has_build_info"], (
        "simsys_build_info absent from /metrics; "
        f"saw simsys_* = {result['sample_names']}"
    )


def test_multiproc_install_skips_process_collector(tmp_path):
    """SimsysProcessCollector is skipped in multiproc mode (not multiproc-safe)."""
    result = _run_subprocess_with_multiproc_dir(str(tmp_path))
    assert not result["has_process_cpu"], (
        "simsys_process_cpu_seconds_total unexpectedly present in multiproc "
        f"mode; saw simsys_* = {result['sample_names']}"
    )
    assert not result["has_process_memory"], (
        "simsys_process_memory_bytes unexpectedly present in multiproc mode"
    )
    assert not result["has_process_open_fds"], (
        "simsys_process_open_fds unexpectedly present in multiproc mode"
    )
