from simsys_metrics import safe_label
from simsys_metrics.helpers import OTHER


def test_safe_label_in_allowed_set():
    assert safe_label("AAPL", {"AAPL", "GOOG"}) == "AAPL"


def test_safe_label_out_of_set_collapses_to_other():
    assert safe_label("XYZ", {"AAPL", "GOOG"}) == OTHER == "other"


def test_safe_label_none_is_other():
    assert safe_label(None, {"AAPL"}) == "other"


def test_safe_label_accepts_iterable():
    # Generator (one-shot) still works.
    assert safe_label("A", (x for x in ["A", "B"])) == "A"


def test_safe_label_accepts_frozenset():
    assert safe_label("A", frozenset({"A"})) == "A"


def test_safe_label_case_sensitive():
    assert safe_label("aapl", {"AAPL"}) == "other"


def test_safe_label_non_string_input_coerced():
    assert safe_label(42, {"42"}) == "42"
    assert safe_label(42, {"41"}) == "other"
