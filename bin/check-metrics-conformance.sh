#!/usr/bin/env bash
# check-metrics-conformance.sh
# Boots the demo FastAPI app, curls /metrics, asserts:
#   - all 6 baseline simsys_* metric names are present
#   - every exposed metric name starts with simsys_ or python_/process_
#     (python_/process_ are prometheus_client's default collectors; the spec
#     only requires *our* metrics to carry the prefix)
#   - simsys_build_info carries service, version, commit labels
#
# Exit codes:
#   0 — all assertions pass
#   1 — a baseline metric is missing, a label is missing, or the server never came up
#   2 — bad invocation / environment

set -euo pipefail

PORT="${PORT:-8765}"
HOST="127.0.0.1"
URL="http://${HOST}:${PORT}/metrics"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${REPO_ROOT}"

PYTHON="${PYTHON:-python3}"
if ! command -v "${PYTHON}" >/dev/null 2>&1; then
    echo "❌ python3 not found in PATH; set PYTHON=..." >&2
    exit 2
fi

if ! "${PYTHON}" -c "import fastapi, uvicorn, prometheus_fastapi_instrumentator" >/dev/null 2>&1; then
    echo "❌ Install the fastapi extra first: pip install -e .[fastapi,test]" >&2
    exit 2
fi

tmpout="$(mktemp)"
trap 'rm -f "${tmpout}"' EXIT

echo "▶ Starting demo FastAPI app on :${PORT}"
"${PYTHON}" -m uvicorn tests.demo_fastapi:app --host "${HOST}" --port "${PORT}" --log-level warning >"${tmpout}" 2>&1 &
SERVER_PID=$!
trap 'kill "${SERVER_PID}" >/dev/null 2>&1 || true; rm -f "${tmpout}"' EXIT

# Wait for readiness (max 15s)
deadline=$(( $(date +%s) + 15 ))
until curl -fsS "${URL}" >/dev/null 2>&1; do
    if ! kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
        echo "❌ Demo server exited before coming up. Log:" >&2
        cat "${tmpout}" >&2
        exit 1
    fi
    if [[ "$(date +%s)" -ge "${deadline}" ]]; then
        echo "❌ Demo server never became ready on ${URL}" >&2
        cat "${tmpout}" >&2
        exit 1
    fi
    sleep 0.2
done

# Exercise the app so HTTP metrics have data.
curl -fsS "http://${HOST}:${PORT}/" >/dev/null
curl -fsS "http://${HOST}:${PORT}/items/1" >/dev/null

metrics_text="$(curl -fsS "${URL}")"

fail=0
check_name() {
    # Match either the bare name (Counter/Gauge) or *_bucket / *_count / *_sum
    # (Histogram — exposition format never emits the bare histogram name).
    local name="$1"
    if ! grep -qE "^${name}(_bucket|_count|_sum)?(\{|[[:space:]])" <<<"${metrics_text}"; then
        echo "❌ missing baseline metric: ${name}"
        fail=1
    else
        echo "✓ ${name}"
    fi
}

echo "▶ Asserting baseline metrics present"
check_name simsys_http_requests_total
check_name simsys_http_request_duration_seconds
check_name simsys_process_cpu_seconds_total
check_name simsys_process_memory_bytes
check_name simsys_process_open_fds
check_name simsys_build_info

echo "▶ Asserting simsys_build_info carries service/version/commit labels"
build_line="$(grep -m1 -E '^simsys_build_info\{' <<<"${metrics_text}" || true)"
if [[ -z "${build_line}" ]]; then
    echo "❌ simsys_build_info line not found"
    fail=1
else
    for lab in service version commit started_at; do
        if ! grep -q "${lab}=\"" <<<"${build_line}"; then
            echo "❌ simsys_build_info missing label: ${lab}"
            fail=1
        else
            echo "✓ label present: ${lab}"
        fi
    done
fi

echo "▶ Asserting every application metric carries the simsys_ prefix"
# Grab non-comment, non-empty metric names. python_/process_ come from the
# prometheus_client default collectors (GC counts, fd counts, etc.) which the
# spec doesn't require to be renamed — they're upstream defaults.
unexpected="$(
    grep -vE '^(#|$)' <<<"${metrics_text}" \
      | awk '{print $1}' \
      | sed 's/{.*//' \
      | sort -u \
      | grep -vE '^(simsys_|python_|process_)' \
      || true
)"
if [[ -n "${unexpected}" ]]; then
    echo "❌ metrics without simsys_ prefix detected:"
    echo "${unexpected}"
    fail=1
else
    echo "✓ all application metrics carry the simsys_ prefix"
fi

if [[ "${fail}" -ne 0 ]]; then
    echo "❌ CONFORMANCE FAILED" >&2
    exit 1
fi
echo "✅ CONFORMANCE PASSED"
