import { describe, expect, it } from "vitest";
import { asFailureToken, asSafeFailureMessage, capabilityStartFailure, normalizeFailure, structuredBoxFailure } from "./failure.js";
import { RpcResponseError, wrapRpcError } from "../../lib/error-envelope.js";

describe("failure token normalization", () => {
  it("preserves model-call budget and final-stage identity without provider text", () => {
    expect(structuredBoxFailure({code: "model_call_budget_exceeded", stage: "batch_final",
      exception_class: "ModelCallBudgetExceeded", error: "private provider body"})).toEqual({
      code: "model_call_budget_exceeded", stage: "batch_final", exception_class: "ModelCallBudgetExceeded",
      message: "model_call_budget_exceeded:ModelCallBudgetExceeded",
    });
  });
  it("rejects tokens with whitespace or newlines (log-injection)", () => {
    expect(asFailureToken("box_error\nFORGED Authorization: Bearer X")).toBeUndefined();
    expect(asFailureToken("model turn stalled")).toBeUndefined();
    expect(asFailureToken("plan_integrity")).toBe("plan_integrity");
  });

  it("structuredBoxFailure normalizes before log/checkpoint shape is fixed", () => {
    const failure = structuredBoxFailure({
      code: "box_error\nFORGED_LOG Authorization: Bearer TEST-TOKEN",
      stage: "compile",
      exception_class: "RuntimeError",
      error: "RuntimeError('provider payload Authorization: Bearer SECRET source=/raw/x.md')",
      message: "also not a pure token but short ok",
    });
    // Forged code is stripped → box_error default; message kept if safe.
    expect(failure.code).toBe("box_error");
    expect(failure.stage).toBe("compile");
    expect(failure.exception_class).toBe("RuntimeError");
    expect(JSON.stringify(failure)).not.toContain("FORGED");
    expect(JSON.stringify(failure)).not.toContain("TEST-TOKEN");
    expect(JSON.stringify(failure)).not.toContain("SECRET");
    expect(JSON.stringify(failure)).not.toContain("/raw/");
  });

  it("does not copy owner-facing error into message", () => {
    const failure = structuredBoxFailure({
      code: "quota_exhausted",
      stage: "batch_compile",
      exception_class: "ModelQuotaExhausted",
      error: "ModelQuotaExhausted('Authorization: Bearer sk-live')",
    });
    expect(failure).toMatchObject({
      code: "quota_exhausted",
      stage: "batch_compile",
      exception_class: "ModelQuotaExhausted",
      message: "quota_exhausted:ModelQuotaExhausted",
    });
    expect(failure.message).not.toContain("Bearer");
  });

  it("normalizeFailure defaults missing code to runtime_failure not box_error", () => {
    expect(normalizeFailure({ stage: "watchdog" })).toMatchObject({
      code: "runtime_failure",
      stage: "watchdog",
    });
  });

  it("collapses whitespace and truncates by Unicode code point", () => {
    expect(asSafeFailureMessage("one\n\ttwo\r\nthree")).toBe("one two three");
    expect(asSafeFailureMessage("😀😀x", 2)).toBe("😀😀");
  });

  it("does not manufacture failures from arrays or empty checkpoint objects", () => {
    expect(normalizeFailure([])).toBeUndefined();
    expect(normalizeFailure({})).toBeUndefined();
  });
});

describe("capability start failure classification", () => {
  const boxError = (status: number, body: Record<string, unknown>) =>
    new RpcResponseError(wrapRpcError(Object.assign(new Error("box"), { status, ...body })));

  it("marks a box that refuses its session configuration as spawn_config_refused", () => {
    const failure = capabilityStartFailure(boxError(422, { code: "session_config_invalid", retriable: false }));
    expect(failure).toMatchObject({
      code: "spawn_config_refused",
      stage: "capability_start",
      exception_class: "RpcResponseError",
      message: "spawn_config_refused:session_config_invalid",
    });
  });

  it("keeps transient and unknown start failures retryable", () => {
    for (const err of [
      boxError(500, {}),
      boxError(429, { retriable: false }),
      boxError(409, {}),
      boxError(422, { code: "busy", retriable: true }),
      // A 4xx without the box's refusal code is not a configuration verdict,
      // even though its HTTP status alone defaults it to non-retriable.
      boxError(403, {}),
      boxError(413, {}),
      boxError(422, { retriable: false }),
      new Error("socket hang up"),
    ]) {
      expect(capabilityStartFailure(err).code).toBe("start_failed");
    }
  });

  it("never copies the box message into the checkpoint", () => {
    const failure = capabilityStartFailure(boxError(422, { code: "session_config_invalid", retriable: false, message: "role compile: secret-ish detail" }));
    expect(JSON.stringify(failure)).not.toContain("secret-ish");
  });
});
