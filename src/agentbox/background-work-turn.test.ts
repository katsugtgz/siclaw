import { describe, expect, it, vi } from "vitest";
import { BackgroundWorkTurn, decorateBackgroundWorkEvent } from "./background-work-turn.js";

describe("request-owned completion mail", () => {
  it("publishes each result once without waiting for other children", async () => {
    const turn = new BackgroundWorkTurn();
    turn.register("server"); turn.register("client");
    const waiting = turn.mailbox.wait(1000);
    turn.complete({ taskId: "client", status: "completed", summary: "client finished" });
    expect(await waiting).toBe("mail");
    const result = turn.mailbox.take();
    expect(result).toContain("client finished");
    expect(result).toContain('"pendingJobIds":["server"]');
    turn.complete({ taskId: "client", status: "completed", summary: "duplicate" });
    expect(turn.mailbox.take()).toBeUndefined();
    turn.complete({ taskId: "server", status: "stopped", summary: "stopped" });
    expect(turn.pending).toBe(false);
    expect(turn.mailbox.take()).toContain("stopped");
  });

  it("rolls back a failed launch", () => {
    const turn = new BackgroundWorkTurn();
    turn.register("failed"); turn.unregister("failed");
    expect(turn.jobIds).toEqual([]);
    expect(turn.pending).toBe(false);
  });

  it("keeps late results owned by their closed turn", async () => {
    const old = new BackgroundWorkTurn(); old.register("child");
    const wait = old.mailbox.wait(1000); old.cancel();
    expect(await wait).toBe("closed");
    expect(old.complete({ taskId: "child", status: "done", summary: "late" })).toBe(true);
    expect(old.mailbox.take()).toBeUndefined();
    expect(old.complete({ taskId: "different", status: "done", summary: "other" })).toBe(false);
    expect(new BackgroundWorkTurn().mailbox.take()).toBeUndefined();
  });

  it("recovers an unread result at normal finish and a late result exactly once", () => {
    const recover = vi.fn();
    const turn = new BackgroundWorkTurn(recover);
    turn.register("unread"); turn.register("late"); turn.register("consumed");
    turn.complete({ taskId: "consumed", status: "done", summary: "already integrated" });
    turn.mailbox.take();
    turn.mailbox.defer();
    turn.complete({ taskId: "unread", status: "partial", summary: "not integrated" });
    turn.finish(); turn.finish();
    turn.complete({ taskId: "late", status: "done", summary: "arrived after final" });
    turn.complete({ taskId: "late", status: "done", summary: "duplicate" });
    expect(recover.mock.calls.map(([n]) => n.taskId)).toEqual(["unread", "late"]);
    expect(turn.mailbox.take()).toBeUndefined();
  });

  it("recovers rollback mail but never intermediate send_message or cancelled work", () => {
    const recover = vi.fn();
    const turn = new BackgroundWorkTurn(recover);
    turn.register("child");
    const checkpoint = turn.mailbox.checkpoint();
    turn.complete({ taskId: "child", status: "done", summary: "result" });
    turn.mailbox.take();
    turn.mailbox.rollback(checkpoint);
    turn.mailbox.post("intermediate child update");
    turn.finish();
    expect(recover).toHaveBeenCalledTimes(1);
    const stopped = new BackgroundWorkTurn(recover);
    stopped.register("stopped");
    stopped.complete({ taskId: "stopped", status: "done", summary: "pending at Stop" });
    stopped.cancel(); stopped.finish();
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("labels only runtime mailbox echoes as internal and never hides a final answer", () => {
    const turn = new BackgroundWorkTurn(); turn.register("still-running");
    expect(decorateBackgroundWorkEvent({ message: { role: "custom", customType: "agent_mailbox" } }, turn).internalMessage).toBe(true);
    expect(decorateBackgroundWorkEvent({ message: { role: "user" } }, turn)).not.toHaveProperty("internalMessage");
    expect(decorateBackgroundWorkEvent({ message: { role: "assistant" } }, turn)).not.toHaveProperty("awaitingSubagents");
  });
});
