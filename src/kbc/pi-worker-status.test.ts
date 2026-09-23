import { describe, expect, it } from "vitest";
import { providerStatus } from "./pi-worker.js";

describe("providerStatus", () => {
  it("reads the upstream status the de-streaming shim attaches to a stream error", () => {
    const event = JSON.stringify({ type: "error", error: { type: "api_error", message: "busy" }, status: 503 });
    expect(providerStatus(new Error(event))).toBe(503);
  });

  it("maps Anthropic stream error types when no status is present", () => {
    expect(providerStatus(new Error(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } })))).toBe(429);
    expect(providerStatus(new Error(JSON.stringify({ type: "error", error: { type: "overloaded_error" } })))).toBe(529);
    expect(providerStatus(new Error(JSON.stringify({ type: "error", error: { type: "billing_error" } })))).toBe(402);
  });

  it("keeps text classification and leaves unknown errors unclassified", () => {
    expect(providerStatus(new Error("429 Too Many Requests"))).toBe(429);
    expect(providerStatus(new Error("upstream returned HTTP 502"))).toBe(502);
    expect(providerStatus(new Error(JSON.stringify({ type: "error", error: { type: "mystery" } })))).toBeUndefined();
    // Upstream text: an inherited key must not resolve to Object.prototype members.
    for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(providerStatus(new Error(JSON.stringify({ type: "error", error: { type } })))).toBeUndefined();
    }
    expect(providerStatus(new Error("socket hang up"))).toBeUndefined();
  });
});
