"""Shared pytest fixtures.

Metric collectors live on the process-wide prometheus_client default registry.
Re-installing across tests would raise DuplicatedTimeSeries, so we expose a
single shared registry view and give tests cheap helpers for reading metric
values from the exposition text.
"""

from __future__ import annotations

import re
from typing import Iterable

import pytest
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest  # noqa: F401

from simsys_metrics import _baseline, _process


@pytest.fixture(autouse=True)
def _reset_simsys_state():
    """Before each test, clear process-wide simsys state.

    Metric collectors themselves stay registered — they're module-level — but
    the service global and any process collector registration are reset.
    """
    _baseline._reset_for_tests()
    _process.unregister_process_collector()
    yield
    _baseline._reset_for_tests()
    _process.unregister_process_collector()


def metric_names(exposition_text: str) -> set[str]:
    """Return the set of metric names (minus # HELP/# TYPE prefix) in the text."""
    names: set[str] = set()
    for line in exposition_text.splitlines():
        if not line or line.startswith("#"):
            continue
        m = re.match(r"([a-zA-Z_:][a-zA-Z0-9_:]*)", line)
        if m:
            names.add(m.group(1))
    return names


def has_sample(
    exposition_text: str, name: str, labels: Iterable[tuple[str, str]] = ()
) -> bool:
    """Return True if ``name{labels}`` appears at least once in the text."""
    for line in exposition_text.splitlines():
        if line.startswith("#") or not line.startswith(name):
            continue
        if not labels:
            return True
        if all(f'{k}="{v}"' in line for k, v in labels):
            return True
    return False
