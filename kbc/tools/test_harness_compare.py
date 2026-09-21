import pytest

import harness_compare


def record():
    return {"schema_version": 1, "raw_sha256": "a" * 64, "evaluation_sha256": "b" * 64,
            "policy_sha256": "c" * 64, "model": "same-model", "engine": "pi_agent",
            "source_revision": "1" * 40, "outcome": "completed",
            "metrics": {"model_calls": 20, "claims_checked": 10, "unsupported_claims": 1}}


def test_missing_quality_is_not_zero_or_a_pass():
    left, right = record(), record()
    right["engine"] = "claude_agent_sdk"
    right["metrics"] = {"model_calls": 15}
    result = harness_compare.compare(left, right)
    assert result["measurements"]["model_calls"]["delta"] == -5
    assert result["measurements"]["unsupported_claims"] == {"baseline": 1, "candidate": None, "delta": None}


@pytest.mark.parametrize("key", harness_compare.IDENTITY)
def test_different_evidence_or_policy_cannot_be_called_an_sdk_comparison(key):
    left, right = record(), record()
    right[key] = "different-model" if key == "model" else "d" * 64
    with pytest.raises(ValueError, match="incomparable"):
        harness_compare.compare(left, right)


@pytest.mark.parametrize("value", [True, -1, float("nan"), float("inf"), 1.5])
def test_invalid_call_counts_are_rejected(value):
    right = record()
    right["metrics"]["model_calls"] = value
    with pytest.raises(ValueError, match="measurement"):
        harness_compare.compare(record(), right)


def test_semantic_counts_require_a_denominator():
    right = record()
    right["metrics"] = {"unsupported_claims": 1}
    with pytest.raises(ValueError, match="claims_checked"):
        harness_compare.compare(record(), right)
