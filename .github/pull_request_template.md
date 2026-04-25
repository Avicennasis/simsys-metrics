<!-- Thanks for the PR! See CONTRIBUTING.md for the full guide. -->

## Summary

<!-- 1–3 sentences. What does this PR change and why? -->

## Type of change

- [ ] Bug fix
- [ ] New metric or label (cardinality-checked — see below)
- [ ] New framework install path
- [ ] Docs / tooling only
- [ ] Refactor (no behaviour change)
- [ ] Breaking change (bumps minor version in 0.x; describe migration)

## Checklist

- [ ] `pytest` is green locally (CI will re-run it against py3.10–3.13)
- [ ] `bin/check-metrics-conformance.sh` is green (if FastAPI or baseline touched)
- [ ] `README.md` updated if public API or metric catalogue changed
- [ ] `CHANGELOG.md` entry added under `[Unreleased]`
- [ ] No metric name without the `simsys_` prefix
- [ ] No new unbounded label (user-controlled strings go through `safe_label()`)

## Cardinality note (for metric/label additions only)

<!-- Worst-case cardinality of the new labels, and how it's bounded.
     Example: "route has cardinality ~20 (route templates), status has
     5 values (1xx-5xx), service is set per-app." -->
