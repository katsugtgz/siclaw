#!/usr/bin/env python3
"""Compare recorded compiler runs with identical frozen evidence and evaluation.

This offline reader never starts a model, changes a knowledge base or fills in
missing semantic measurements. See docs/design/kbc-harness-validation.md.
"""
import argparse
import json
import math
import re
from pathlib import Path

IDENTITY = ("raw_sha256", "evaluation_sha256", "model", "policy_sha256")
MEASUREMENTS = (
    "elapsed_seconds", "model_calls", "input_tokens", "output_tokens",
    "cache_read_tokens", "cache_write_tokens", "recoveries", "human_interventions",
    "candidate_pages", "claims_checked", "unsupported_claims",
    "critical_facts_checked", "missing_critical_facts", "graded_questions", "passed_questions",
    "tickets_reviewed", "actionable_tickets", "media_passed_pages", "media_exhausted_pages",
)


def validate(record):
    if not isinstance(record, dict) or type(record.get("schema_version")) is not int or record.get("schema_version") != 1:
        raise ValueError("expected a schema_version=1 run record")
    for key in (*IDENTITY, "engine", "source_revision", "outcome"):
        if not isinstance(record.get(key), str) or not record[key] or len(record[key]) > 256:
            raise ValueError(f"missing or invalid {key}")
    for key in ("raw_sha256", "evaluation_sha256", "policy_sha256"):
        if not re.fullmatch(r"[a-f0-9]{64}", record[key]):
            raise ValueError(f"{key} must identify exact frozen bytes")
    if not re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", record["source_revision"]):
        raise ValueError("source_revision must be an exact compiler commit")
    if record["engine"] not in {"claude_agent_sdk", "pi_agent"}:
        raise ValueError("unsupported engine")
    if record["outcome"] not in {"completed", "failed", "cancelled", "running"}:
        raise ValueError("unsupported outcome")
    metrics = record.get("metrics")
    if not isinstance(metrics, dict):
        raise ValueError("metrics must be an object; use null for unavailable measurements")
    for key in MEASUREMENTS:
        value = metrics.get(key)
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0
                                  or (key != "elapsed_seconds" and value != int(value))):
            raise ValueError(f"invalid measurement: {key}")
    for numerator, denominator in (("unsupported_claims", "claims_checked"),
            ("missing_critical_facts", "critical_facts_checked"), ("passed_questions", "graded_questions"),
            ("actionable_tickets", "tickets_reviewed")):
        n, d = metrics.get(numerator), metrics.get(denominator)
        if n is not None and (d is None or n > d):
            raise ValueError(f"{numerator} requires a consistent {denominator}")
    return record


def compare(baseline, candidate):
    baseline, candidate = validate(baseline), validate(candidate)
    for key in IDENTITY:
        if baseline[key] != candidate[key]:
            raise ValueError(f"incomparable runs: {key} differs")
    rows = {}
    for key in MEASUREMENTS:
        a, b = baseline["metrics"].get(key), candidate["metrics"].get(key)
        rows[key] = {"baseline": a, "candidate": b,
                     "delta": b - a if a is not None and b is not None else None}
    return {
        "schema_version": 1,
        "identity": {key: baseline[key] for key in IDENTITY},
        "baseline": {key: baseline[key] for key in ("engine", "source_revision", "outcome")},
        "candidate": {key: candidate[key] for key in ("engine", "source_revision", "outcome")},
        "both_completed": baseline["outcome"] == candidate["outcome"] == "completed",
        "measurements": rows,
        "limitations": [
            "Recorded measurements are supplied evidence, not independently graded by this command.",
            "Null means not measured, never zero failures or a passing quality gate.",
            "One pair cannot establish completion rates or semantic parity; repeat over the frozen corpus suite.",
            "Token counts and cache usage are not a billed-cost comparison.",
            "An incomplete run's deltas do not measure the cost of finishing the same task.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = compare(json.loads(args.baseline.read_text()), json.loads(args.candidate.read_text()))
    except (OSError, ValueError) as error:
        parser.exit(2, f"Cannot compare compiler runs: {error}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
