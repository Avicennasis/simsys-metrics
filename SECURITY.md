# Security Policy

## Supported versions

Only the latest `0.x.y` tag is supported. Fixes will land on `main` and be
cut as a new patch release; older tags will not be back-patched.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Email **avicennasis@gmail.com** with:

- A description of the issue.
- Steps to reproduce (or a proof-of-concept).
- The version or commit SHA you found it against.
- Any suggested mitigation if you have one.

Expect an acknowledgement within a week. This is a side-project package —
there is no bug bounty and no SLA — but I take security issues seriously
and will coordinate a fix and disclosure with you.

## What's in scope

This package is a thin wrapper over `prometheus_client`,
`prometheus-fastapi-instrumentator`, and `psutil`. In-scope issues:

- Crashes, hangs, or DoS triggered through the package's API surface
  (`install`, `track_queue`, `track_job`, `safe_label`, the metric
  factories).
- Information disclosure via the `/metrics` endpoint beyond what Prometheus
  exposition format normally reveals.
- Cardinality-explosion vectors that the `safe_label` / prefix guard /
  route-template pattern was supposed to prevent.

## What's out of scope

- Issues in upstream dependencies (report upstream).
- Misconfiguration by consumer apps (e.g. exposing `/metrics` to the
  public internet without auth). The package documents that `/metrics`
  should be on a scoped port or behind auth middleware.
- `/metrics` leaking operator-chosen label values (tenant names, ticker
  symbols, etc.) that were passed through `safe_label` with an allow-list
  the operator chose. If the allow-list itself is sensitive, that's on
  the operator, not the package.
