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
  deliverBackgroundChannelEvent,
} from "./background-delivery.js";

const TTL = 1_000;

function assistantMessage(sessionId: string, content = "milestone"): DelegationAppendMessagePayload {
  return { sessionId, role: "assistant", content, fromAgentId: "agent-1" };
}

function visibleMessage(sessionId: string, text = "milestone"): ChannelDeliverMessagePayload {
  return { sessionId, kind: "milestone", text, fromAgentId: "agent-1" };
}

describe("background-delivery TTL", () => {
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

  it("keeps child and main lifecycle listeners alive independently of an SSE collector", async () => {
    const onEvent = vi.fn(async () => {});
    registerBackgroundChannelDelivery("s1", async () => true, { ttlMs: TTL, onEvent });
    vi.advanceTimersByTime(600);
    await deliverBackgroundChannelEvent("s1", { type: "subagent_done", job_id: "child" });
    vi.advanceTimersByTime(600);
    await deliverBackgroundChannelEvent("s1", { type: "background_turn_start", turnId: "t2" });
    expect(hasBackgroundChannelDelivery("s1")).toBe(true);
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(["subagent_done", "background_turn_start"]);
  });

  it("does not let an in-flight old listener refresh or expire its replacement", async () => {
    let unblock!: () => void;
    registerBackgroundChannelDelivery("s1", async () => true, { ttlMs: 100, onEvent: async () => {
      await new Promise<void>(resolve => { unblock = resolve; });
    } });
    const old = deliverBackgroundChannelEvent("s1", { type: "subagent_done" });
    registerBackgroundChannelDelivery("s1", async () => true, TTL);
    unblock(); await old;
    vi.advanceTimersByTime(101);
    expect(hasBackgroundChannelDelivery("s1")).toBe(true);
  });
});
