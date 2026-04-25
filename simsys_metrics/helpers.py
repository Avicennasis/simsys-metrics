"""Cardinality helpers for consumer code.

Use ``safe_label`` to coerce any user-facing value into a bounded set of label
values. Anything outside the allow-list collapses to ``"other"`` so your
Prometheus cardinality stays flat even when the input is adversarial.
"""

from __future__ import annotations

from typing import Iterable

OTHER = "other"


def safe_label(value: object, allowed: Iterable[str]) -> str:
    """Return ``str(value)`` if it is in ``allowed``, else ``"other"``.

    The allow-list is compared by string equality (case-sensitive). Callers that
    want case-insensitive matching should normalize both sides themselves.

    Example:
        >>> safe_label("AAPL", {"AAPL", "GOOG"})
        'AAPL'
        >>> safe_label("XYZ", {"AAPL", "GOOG"})
        'other'
        >>> safe_label(None, {"AAPL"})
        'other'
    """
    if value is None:
        return OTHER
    s = value if isinstance(value, str) else str(value)
    allowed_set = allowed if isinstance(allowed, (set, frozenset)) else set(allowed)
    return s if s in allowed_set else OTHER
