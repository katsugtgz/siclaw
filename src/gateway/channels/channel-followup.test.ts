import { describe, it, expect, vi } from "vitest";
import { createChannelFollowup } from "./channel-followup.js";

function setup() {
  const renderer = {
    open: vi.fn(async () => ({ id: "new-card" })),
    update: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    emptyText: "No additional result", errorText: "Execution failed", cancelledText: "Cancelled",
  };
  return { renderer, followup: createChannelFollowup(renderer) };
}

describe("channel follow-up lifecycle", () => {
  it("keeps a new main turn open across child completion and finalizes even a short reply", async () => {
    const { renderer, followup } = setup();
    await followup.event({ type: "subagent_done", job_id: "child" });
    expect(renderer.open).not.toHaveBeenCalled();
    await followup.event({ type: "background_turn_start", turnId: "t2" });
    await followup.message("Working on the late result");
    await followup.event({ type: "subagent_done", job_id: "another-child" });
    expect(renderer.finish).not.toHaveBeenCalled();
    await followup.message("42");
    await followup.event({ type: "background_turn_done", turnId: "old" });
    expect(renderer.finish).not.toHaveBeenCalled();
    await followup.event({ type: "background_turn_done", turnId: "t2", outcome: "completed" });
    await followup.event({ type: "background_turn_done", turnId: "t2", outcome: "completed" });
    expect(renderer.finish).toHaveBeenCalledExactlyOnceWith({ id: "new-card" }, "42");
    expect(await followup.message("not in a follow-up")).toBe(false);
  });

  it.each([['error', 'Execution failed'], ['aborted', 'Cancelled']])("renders %s without passing progress off as success", async (outcome, expected) => {
    const { renderer, followup } = setup();
    await followup.event({ type: "background_turn_start", turnId: "t2" });
    await followup.message("Partial progress");
    await followup.event({ type: "background_turn_done", turnId: "t2", outcome });
    expect(renderer.finish).toHaveBeenCalledWith({ id: "new-card" }, expected);
  });

  it("serializes async card creation, messages and terminal events", async () => {
    const { renderer, followup } = setup();
    let open!: () => void;
    renderer.open.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { open = resolve; });
      return { id: "slow-card" };
    });
    const start = followup.event({ type: "background_turn_start", turnId: "t2" });
    const message = followup.message("Complete report");
    const done = followup.event({ type: "background_turn_done", turnId: "t2" });
    await Promise.resolve(); open();
    await Promise.all([start, message, done]);
    expect(renderer.finish).toHaveBeenCalledWith({ id: "slow-card" }, "Complete report");
  });
});
