import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRequestWork } from "./codex-request-work.js";
import { CodexAgentBrain } from "./codex-agent-brain.js";
const execution = (id: string) => ({ id, threadId: id, parentThreadId: "root" });
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe("native logical-request completion fence", () => {
  it("waits for every owned execution, counts failures as terminal, and deduplicates completion", async () => {
    const progress = vi.fn(), work = new CodexRequestWork("sync", progress, vi.fn());
    const a = work.register(execution("a")), b = work.register(execution("b"));
    const wake = work.wait(); a.finished("done"); await wake;
    expect(work.pending).toBe(true); expect(work.needsReport).toBe(true);
    b.finished("failed"); b.finished("failed");
    expect(progress).toHaveBeenCalledTimes(4); expect(work.pending).toBe(false);
    work.startReport("final"); work.finishReport("final", true);
    expect(work.needsReport).toBe(false);
  });
  it("does not bless an early draft when a child completes during streaming", () => {
    const work = new CodexRequestWork("sync", vi.fn(), vi.fn()), run = work.register(execution("a"));
    work.startReport("early"); run.finished("done"); work.finishReport("early", true);
    expect(work.needsReport).toBe(true);
    work.startReport("final"); work.finishReport("final", true); expect(work.needsReport).toBe(false);
  });
  it("Stop wakes the fence and latches a child that starts late", async () => {
    const interrupt = vi.fn().mockResolvedValue(undefined), work = new CodexRequestWork("sync", vi.fn(), interrupt);
    const run = work.register(execution("a")), wake = work.wait();
    await work.cancel(); await wake; run.started("late-turn");
    expect(interrupt).toHaveBeenLastCalledWith(expect.objectContaining({ turnId: "late-turn" }));
  });
  it("recovers late async results once under the original owner, never after Stop", async () => {
    const recover = vi.fn(), work = new CodexRequestWork("async", vi.fn(), vi.fn(), recover);
    const a = work.register(execution("a")), b = work.register(execution("b"));
    work.finish(); a.finished("done"); expect(recover).not.toHaveBeenCalled();
    b.finished("done"); b.finished("done"); expect(recover).toHaveBeenCalledTimes(1);
    const stopped = new CodexRequestWork("async", vi.fn(), vi.fn(), recover);
    const run = stopped.register(execution("stopped")); stopped.finish(); await stopped.cancel(); run.finished("cancelled");
    expect(recover).toHaveBeenCalledTimes(1);
  });
  it("fails rather than hanging forever after native connection loss", async () => {
    const work = new CodexRequestWork("sync", vi.fn(), vi.fn()); work.register(execution("a"));
    work.fail(new Error("native connection lost")); await expect(work.wait()).rejects.toThrow("connection lost");
  });
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-request-fence-"))); roots.push(root);
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  const brain = new (CodexAgentBrain as any)(manager, { grants: { readRoots: [], writeRoots: [], deniedRoots: [],
    allowCommands: false, production: false }, codexHome: path.join(root, "home") }, "", new Map(), root, [], false);
  brain.model = { id: "fixture", provider: "fixture", api: "openai-responses", contextWindow: 8000 };
  brain.transformInput = async (text: string) => ({ text });
  brain.ensureThread = async () => { brain.threadId = "root"; };
  brain.client = { request: vi.fn().mockResolvedValue({}) };
  const events: any[] = []; brain.subscribe((event: any) => events.push(event));
  const event = (method: string, threadId: string, params: any) => brain.handleEvent({ method, params: { threadId, ...params } });
  let turnCounter = 0;
  const begin = () => {
    const id = `root-turn-${++turnCounter}`;
    brain.active = { id, toolNames: new Set(), userMessage: { role: "user", content: "inspect" }, resolve: vi.fn(), reject: vi.fn() };
    event("turn/started", "root", { turn: { id } }); return id;
  };
  const spawn = (id: string, parent = "root", parentTurn = brain.active.id) => {
    event("item/completed", parent, { turnId: parentTurn, item: { type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
      id: `spawn-${id}`, receiverThreadIds: [id], prompt: "bounded check" } });
    event("turn/started", id, { turn: { id: `${id}-turn` } });
  };
  const done = (id: string, status = "completed") => event("turn/completed", id, { turn: { id: `${id}-turn`, status } });
  const answer = (id: string) => {
    event("item/started", "root", { item: { type: "agentMessage", id } });
    event("item/completed", "root", { item: { type: "agentMessage", id, text: id, phase: "final_answer" } });
    brain.lastTurnHadContent = true; brain.lastToolNames = new Set();
  };
  return { brain, events, begin, spawn, done, answer, event };
}
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("native brain request boundaries (real projection, deterministic native events)", () => {
  it("retains one accepted request fence across provider attempts", async () => {
    const f = fixture(); f.brain.beginRequest("sync");
    f.brain.runTurn = vi.fn(async () => {
      f.begin();
      if (f.brain.runTurn.mock.calls.length === 1) { f.spawn("a"); f.brain.active = undefined; throw new Error("provider attempt failed"); }
      f.answer(f.brain.runTurn.mock.calls.length === 2 ? "early-retry" : "complete-report"); f.brain.active = undefined;
    });
    await expect(f.brain.prompt("inspect")).rejects.toThrow("provider attempt failed");
    const owner = f.brain.requestWork;
    let finished = false; const retry = f.brain.prompt("retry").then(() => { finished = true; });
    await settle(); expect(finished).toBe(false); expect(f.brain.requestWork).toBe(owner);
    f.done("a"); await retry; f.brain.endRequest(); expect(f.brain.requestWork).toBeUndefined();
  });
  it("a reused child's old parent terminal cannot complete its newer execution", async () => {
    const f = fixture(); f.brain.setRequestMode("async");
    f.brain.runTurn = vi.fn(async () => {
      const id = f.begin(), call = f.brain.runTurn.mock.calls.length;
      if (call === 1) { f.spawn("a"); f.done("a"); }
      if (call === 2) {
        f.event("item/completed", "root", { turnId: id, item: { type: "collabAgentToolCall", tool: "sendInput", status: "completed", id: "reuse-a", receiverThreadIds: ["a"] } });
        f.event("turn/started", "a", { turn: { id: "a-new-turn" } });
      }
      f.answer(call === 2 ? "early" : "complete-report"); f.brain.active = undefined;
    });
    await f.brain.prompt("A"); f.brain.setRequestMode("sync");
    let finished = false; const b = f.brain.prompt("B").then(() => { finished = true; }); await settle();
    f.event("item/completed", "root", { turnId: "root-turn-1", item: { type: "subAgentActivity", kind: "completed", id: "subagent-completed-a-turn", agentThreadId: "a" } });
    f.done("a"); await settle(); expect(finished).toBe(false);
    f.event("turn/completed", "a", { turn: { id: "a-new-turn", status: "completed" } }); await b;
  });
  it("holds the SAME sync request through early parent return, then performs one native synthesis", async () => {
    const f = fixture(); f.brain.setRequestMode("sync");
    f.brain.runTurn = vi.fn(async () => {
      f.begin();
      if (f.brain.runTurn.mock.calls.length === 1) { f.spawn("a"); f.spawn("b"); f.answer("early-progress"); }
      else f.answer("final-report");
      f.brain.active = undefined;
    });
    let finished = false; const prompt = f.brain.prompt("inspect").then(() => { finished = true; });
    await settle(); expect(finished).toBe(false);
    f.done("a"); await settle(); expect(finished).toBe(false);
    f.done("b", "failed"); await prompt;
    expect(f.brain.runTurn).toHaveBeenCalledTimes(2);
    expect(f.brain.runTurn.mock.calls[1][0][0].text).toContain("SAME request");
    expect(f.events.filter(e => e.type === "native_subagent_progress").at(-1)).toMatchObject({ total: 2, done: 2, failed: 1 });
  });
  it("adds no extra model turn when native waiting already precedes the final answer", async () => {
    const f = fixture(); f.brain.setRequestMode("sync");
    f.brain.runTurn = vi.fn(async () => { f.begin(); f.spawn("a"); f.done("a"); f.answer("complete-report"); f.brain.active = undefined; });
    await f.brain.prompt("inspect"); expect(f.brain.runTurn).toHaveBeenCalledTimes(1);
  });
  it("includes owned descendants rather than finishing after only the direct child", async () => {
    const f = fixture(); f.brain.setRequestMode("sync");
    f.brain.runTurn = vi.fn(async () => {
      f.begin();
      if (f.brain.runTurn.mock.calls.length === 1) { f.spawn("a"); f.spawn("grandchild", "a", "a-turn"); f.done("a"); f.answer("early"); }
      else f.answer("complete-report");
      f.brain.active = undefined;
    });
    let finished = false; const prompt = f.brain.prompt("inspect").then(() => { finished = true; });
    await settle(); expect(finished).toBe(false); f.done("grandchild"); await prompt;
    expect(finished).toBe(true);
  });
  it("Stop between parent turns interrupts the owned child and never starts synthesis", async () => {
    const f = fixture(); f.brain.setRequestMode("sync");
    f.brain.runTurn = vi.fn(async () => { f.begin(); f.spawn("a"); f.answer("early"); f.brain.active = undefined; });
    const prompt = f.brain.prompt("inspect"); await settle(); await f.brain.abort(); await prompt;
    expect(f.brain.client.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "a", turnId: "a-turn" });
    expect(f.brain.runTurn).toHaveBeenCalledTimes(1); f.done("a"); expect(f.brain.runTurn).toHaveBeenCalledTimes(1);
  });
  it("late async A completion cannot finish or steer sync request B", async () => {
    const f = fixture(), recoveryA = vi.fn(), recoveryB = vi.fn();
    f.brain.setRequestMode("async"); f.brain.setNativeChildRecovery(recoveryA);
    f.brain.runTurn = vi.fn(async () => {
      f.begin(); const call = f.brain.runTurn.mock.calls.length;
      if (call <= 2) f.spawn(call === 1 ? "a" : "b");
      f.answer(call <= 2 ? "early" : "complete-report"); f.brain.active = undefined;
    });
    await f.brain.prompt("A"); f.brain.setRequestMode("sync"); f.brain.setNativeChildRecovery(recoveryB);
    let finishedB = false; const b = f.brain.prompt("B").then(() => { finishedB = true; });
    await settle(); f.done("a"); await settle();
    expect(recoveryA).toHaveBeenCalledTimes(1); expect(recoveryB).not.toHaveBeenCalled(); expect(finishedB).toBe(false);
    f.done("b"); await b;
  });
});
