import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  ChannelDeliverMessagePayload,
  DelegationAppendMessagePayload,
} from "../../shared/delegation-persistence.js";
import {
  registerBackgroundChannelDelivery,
  clearBackgroundChannelDelivery,
  hasBackgroundChannelDelivery,
  deliverBackgroundChannelMessage,
  deliverChannelVisibleMessage,
} from "./background-delivery.js";

const TTL = 1_000;

function assistantMessage(sessionId: string, content = "milestone"): DelegationAppendMessagePayload {
  return { sessionId, role: "assistant", content, fromAgentId: "agent-1" };
}

function visibleMessage(sessionId: string, text = "milestone"): ChannelDeliverMessagePayload {
  return { sessionId, kind: "milestone", text, fromAgentId: "agent-1" };
}

describe("background-delivery TTL", () => {
  it("routes overlapping same-session requests to their original cards and rejects unscoped/stale results", async () => {
    const a = vi.fn(async () => true), b = vi.fn(async () => true);
    const clearA = registerBackgroundChannelDelivery("s1", a, TTL, "request-a");
    const clearB = registerBackgroundChannelDelivery("s1", b, TTL, "request-b");
    expect(await deliverChannelVisibleMessage({ ...visibleMessage("s1"), requestId: "request-a" })).toBe(true);
    expect(a).toHaveBeenCalledTimes(1); expect(b).not.toHaveBeenCalled();
    expect(await deliverChannelVisibleMessage(visibleMessage("s1"))).toBe(false);
    clearA();
    expect(await deliverChannelVisibleMessage({ ...visibleMessage("s1"), requestId: "request-a" })).toBe(false);
    expect(await deliverChannelVisibleMessage({ ...visibleMessage("s1"), requestId: "request-b" })).toBe(true);
    expect(b).toHaveBeenCalledTimes(1); clearB();
  });
  it("an older cleanup cannot remove a replacement with the same request identity", async () => {
    const old = registerBackgroundChannelDelivery("s1", async () => true, TTL, "a");
    const replacement = vi.fn(async () => true);
    registerBackgroundChannelDelivery("s1", replacement, TTL, "a"); old();
    expect(await deliverChannelVisibleMessage({ ...visibleMessage("s1"), requestId: "a" })).toBe(true);
    expect(replacement).toHaveBeenCalledTimes(1);
  });
  it("a scoped expiry does not remove another queued request's delivery", async () => {
    registerBackgroundChannelDelivery("s1", async () => true, TTL, "a");
    vi.advanceTimersByTime(500); registerBackgroundChannelDelivery("s1", async () => true, TTL, "b");
    vi.advanceTimersByTime(501);
    expect(await deliverChannelVisibleMessage({ ...visibleMessage("s1"), requestId: "a" })).toBe(false);
    expect(await deliverChannelVisibleMessage({ ...visibleMessage("s1"), requestId: "b" })).toBe(true);
  });
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    clearBackgroundChannelDelivery("s1");
    vi.useRealTimers();
  });

  it("expires the handle after the TTL when there is no delivery activity", async () => {
    registerBackgroundChannelDelivery("s1", async () => true, TTL);
    expect(hasBackgroundChannelDelivery("s1")).toBe(true);

    vi.advanceTimersByTime(TTL + 1);

    expect(hasBackgroundChannelDelivery("s1")).toBe(false);
    expect(await deliverBackgroundChannelMessage(assistantMessage("s1"))).toBe(false);
  });

  it("slides the TTL window forward on each successful delivery (long-running turn)", async () => {
    registerBackgroundChannelDelivery("s1", async () => true, TTL);

    // Deliver at 60% of the window — refreshes the handle past the original expiry.
    vi.advanceTimersByTime(600);
    expect(await deliverBackgroundChannelMessage(assistantMessage("s1"))).toBe(true);

    // Original TTL has now elapsed, but the refresh kept the handle alive.
    vi.advanceTimersByTime(600);
    expect(hasBackgroundChannelDelivery("s1")).toBe(true);
    expect(await deliverChannelVisibleMessage(visibleMessage("s1"))).toBe(true);

    // After a full idle TTL past the last delivery, it finally expires.
    vi.advanceTimersByTime(TTL + 1);
    expect(hasBackgroundChannelDelivery("s1")).toBe(false);
    expect(await deliverBackgroundChannelMessage(assistantMessage("s1"))).toBe(false);
  });

  it("does NOT refresh the window when the delivery callback reports no delivery", async () => {
    registerBackgroundChannelDelivery("s1", async () => false, TTL);

    vi.advanceTimersByTime(600);
    expect(await deliverBackgroundChannelMessage(assistantMessage("s1"))).toBe(false);

    // A non-delivery must not keep a dead session alive past its original TTL.
    vi.advanceTimersByTime(401);
    expect(hasBackgroundChannelDelivery("s1")).toBe(false);
  });
});
