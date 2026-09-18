"""Diagnostic categories must not persist provider bodies or drive retries."""

import json

import pytest

from execution_observation import ExecutionObserver, observe_sessions


@pytest.mark.parametrize("status,error,outcome,expected", [
    (400, "API Error: 400 max_tokens: 8192 exceeds the maximum 4096; private source", "failed", "model_output_limit_rejected"),
    (400, "API Error: 400 prompt is too long: 210000 tokens > 200000 maximum", "failed", "model_context_limit_rejected"),
    (400, "unknown error; request says max_tokens: 8192 exceeds the maximum 4096", "failed", "model_request_failed"),
    (400, "quota? echoed private prompt", "failed", "model_request_failed"),
    (None, "max_tokens: 8192 exceeds the maximum 4096", "failed", "model_request_failed"),
    (401, "private key rejected", "failed", "model_authentication_failed"),
    (403, "private account", "failed", "model_permission_denied"),
    (402, "private billing detail", "failed", "model_billing_rejected"),
    (429, "private request", "failed", "model_rate_limited"),
    (503, "private service details", "failed", "model_request_failed"),
    (None, "KBC_MODEL_CALL_BUDGET_EXCEEDED", "failed", "model_call_budget_exceeded"),
    (400, "API Error: 400 max_tokens: 8192 exceeds the maximum 4096", "aborted", "interrupted"),
    (None, "private completed output", "completed", None),
])
async def test_failure_observations_are_content_free(status, error, outcome, expected):
    observations = []

    async def collect(event):
        observations.append(event)

    with observe_sessions(collect):
        observer = ExecutionObserver("session-fixture", {
            "role": "judge", "model": {"id": "fixture", "provider": "fixture"}})
        await observer.emit("result", {"outcome": outcome, "error": error,
                            "api_error_status": status, "usage": {
                                "input_tokens": 0, "error_message": "private nested body"}}, "turn-fixture")
    result = observations[0]
    assert result["data"].get("failure_code") == expected
    assert result["session_id"] == "session-fixture"
    assert result["turn_id"] == "turn-fixture"
    assert result["role"] == "judge"
    assert "error" not in result["data"]
    assert "private" not in json.dumps(observations)
    assert error not in json.dumps(observations)
