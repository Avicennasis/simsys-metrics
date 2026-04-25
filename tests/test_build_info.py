from prometheus_client import REGISTRY

from simsys_metrics.build_info import _detect_commit, register_build_info


def test_register_build_info_sets_gauge_to_1():
    register_build_info(
        service="test_build_info_svc",
        version="9.9.9",
        commit="deadbeef",
        started_at="2026-04-23T00:00:00+00:00",
    )
    value = REGISTRY.get_sample_value(
        "simsys_build_info",
        {
            "service": "test_build_info_svc",
            "version": "9.9.9",
            "commit": "deadbeef",
            "started_at": "2026-04-23T00:00:00+00:00",
        },
    )
    assert value == 1.0


def test_detect_commit_env_var_wins(monkeypatch):
    monkeypatch.setenv("SIMSYS_BUILD_COMMIT", "from_env_123")
    assert _detect_commit() == "from_env_123"


def test_detect_commit_empty_env_falls_through(monkeypatch):
    monkeypatch.setenv("SIMSYS_BUILD_COMMIT", "")
    # Result is either a short sha (in a git checkout) or "unknown". Both valid.
    value = _detect_commit()
    assert isinstance(value, str) and value


def test_detect_commit_non_repo_returns_unknown(monkeypatch, tmp_path):
    monkeypatch.delenv("SIMSYS_BUILD_COMMIT", raising=False)
    # tmp_path is not a git repo; git rev-parse exits non-zero.
    assert _detect_commit(cwd=str(tmp_path)) == "unknown"


def test_register_build_info_default_commit_and_started_at(monkeypatch):
    monkeypatch.setenv("SIMSYS_BUILD_COMMIT", "envsha")
    register_build_info(service="svc_default_ts", version="1.0.0")
    # Any started_at with the default commit counts as a success.
    for metric in REGISTRY.collect():
        if metric.name == "simsys_build_info":
            for s in metric.samples:
                labels = s.labels
                if (
                    labels.get("service") == "svc_default_ts"
                    and labels.get("commit") == "envsha"
                ):
                    assert s.value == 1.0
                    assert labels.get("started_at")
                    return
    raise AssertionError("Expected build_info sample for svc_default_ts not found.")
