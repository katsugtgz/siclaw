import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexChildProjection, type NativeChildOperation } from "./codex-child-projection.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-child-projection-"));
  const operations: NativeChildOperation[] = [];
  const persist = vi.fn(async (op: NativeChildOperation) => { operations.push(op); });
  const activity = vi.fn();
  let receipt = "request-1";
  const create = () => {
    const projection = new CodexChildProjection(dir, () => "root", () => ({ sessionId: "public-root",
      executionRole: "root", apiRequestId: receipt }), () => ({ id: "parent-model", provider: "provider" }), (child, usage, callId) => ({
      ...child.context, sessionId: child.sessionId, executionRole: "internal_subagent", schemaVersion: 1,
      callId, phase: "finished", requestAt: new Date().toISOString(), kind: "agent", routingAttempt: 1,
      model: { configId: "cfg", name: "Provider", sourceKind: "api", sourceId: "provider", sourceName: "Provider",
        requestedId: child.modelId, runtimeProvider: "provider" },
      usageEvidence: { protocol: "openai_responses", providerUsagePresent: true, finality: "terminal", rawUsage: usage },
    }));
    projection.setSink({ persist, activity });
    return projection;
  };
  return { dir, create, operations, persist, activity, receipt: (id: string) => { receipt = id; },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const event = (method: string, threadId: string, values: Record<string, unknown>) => ({ method, params: { threadId, ...values } });
const spawn = (threadId = "root", childId = "child") => event("item/completed", threadId, {
  item: { type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", id: "spawn-1",
    receiverThreadIds: [childId], prompt: "Investigate", model: "child-model" },
});
const usage = (total: number, turnId = "turn-1") => event("thread/tokenUsage/updated", "child", {
  turnId, tokenUsage: { total: { totalTokens: total }, last: { inputTokens: 5, outputTokens: 2 } },
});

describe("native child projection", () => {
  it("persists native MCP error-only reasons and child citation attribution", async () => {
    const f = fixture();
    try {
      const p = f.create(); p.handle(spawn()); p.handle(event("turn/started", "child", { turn: { id: "turn-1" } }));
      p.handle(event("item/completed", "child", { item: { id: "error", type: "mcpToolCall", tool: "read", status: "failed", error: { message: "Backend read failed" } } }));
      p.setKnowledgeSources("child", [{ title: "Runbook", url: "https://docs.example.org/runbook", repoId: "repo", page: "guide.md" }]);
      p.handle(event("item/completed", "child", { item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "Read complete." } }));
      await p.flush();
      expect(f.operations).toContainEqual(expect.objectContaining({ type: "message", role: "tool", content: "Backend read failed", outcome: "error" }));
      expect(f.operations).toContainEqual(expect.objectContaining({ type: "message", role: "assistant", metadata: expect.objectContaining({ knowledge_citations: expect.objectContaining({ repo_ids: ["repo"] }) }) }));
    } finally { f.cleanup(); }
  });
  it("projects buffered child events only after an owned spawn, preserving dispatch receipt and model", async () => {
    const f = fixture();
    try {
      const p = f.create();
      p.handle(event("turn/started", "unrelated-memory-thread", { turn: { id: "turn-0" } }));
      p.handle(event("item/completed", "unrelated-memory-thread", { item: { type: "agentMessage", id: "secret", text: "not ours" } }));
      p.handle(event("turn/started", "child", { turn: { id: "turn-1" } }));
      p.handle(event("item/completed", "child", { item: { type: "agentMessage", id: "answer", text: "Found it" } }));
      p.handle(usage(7));
      await p.flush();
      expect(f.operations).toHaveLength(0);
      p.handle(spawn());
      f.receipt("unrelated-next-parent-turn");
      p.handle(usage(14));
      p.handle(usage(14));
      p.handle(event("turn/completed", "child", { turn: { id: "turn-1", status: "completed" } }));
      await p.flush();
      expect(f.operations[0].type).toBe("ensure");
      expect(f.operations.filter(op => op.type === "message").map(op => op.content)).toEqual(["Found it"]);
      const calls = f.operations.filter(op => op.type === "usage");
      expect(calls).toHaveLength(2);
      for (const call of calls) expect(call.observation).toMatchObject({ executionRole: "internal_subagent",
        apiRequestId: "request-1", model: { requestedId: "child-model" } });
      expect(f.activity.mock.calls.map(c => c[1])).toEqual([true, false]);
      expect(JSON.stringify(f.operations)).not.toContain("unrelated-memory-thread");
    } finally { f.cleanup(); }
  });

  it("projects V2 lifecycle and nested ancestry without taking over native execution", async () => {
    const f = fixture();
    try {
      const p = f.create();
      p.handle(event("item/started", "root", { item: { type: "subAgentActivity", id: "activity-1",
        agentThreadId: "child", agentPath: "/root/check", kind: "started" } }));
      p.handle(spawn("child", "grandchild"));
      p.handle(event("item/completed", "root", { item: { type: "subAgentActivity", id: "complete-1",
        agentThreadId: "child", agentPath: "/root/check", kind: "completed" } }));
      await p.flush();
      const children = f.operations.filter(op => op.type === "ensure");
      expect(children).toHaveLength(2);
      expect(children[1].child.parentSessionId).toBe(children[0].child.sessionId);
      expect(p.details({ type: "subAgentActivity", agentThreadId: "child" })).toMatchObject({
        native_subagent: true, child_session_id: children[0].child.sessionId, status: "done" });
      expect(f.operations.filter(op => op.type === "status" && op.status === "done")).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  it("captures a continuation receipt before a child response can precede the parent's tool completion", async () => {
    const f = fixture();
    try {
      const p = f.create();
      p.handle(spawn());
      f.receipt("continuation-request");
      p.handle(event("item/started", "root", { item: { type: "collabAgentToolCall", tool: "sendInput",
        id: "send-1", status: "inProgress", receiverThreadIds: ["child"] } }));
      p.handle(event("turn/started", "child", { turn: { id: "continuation-turn" } }));
      p.handle(usage(7, "continuation-turn"));
      await p.flush();
      const call = f.operations.find(op => op.type === "usage");
      expect(call?.type === "usage" && call.observation.apiRequestId).toBe("continuation-request");
    } finally { f.cleanup(); }
  });

  it("retries a failed durable append after restart and excludes historical usage replay", async () => {
    const f = fixture();
    try {
      let p = f.create();
      f.persist.mockRejectedValueOnce(new Error("unavailable"));
      p.handle(spawn());
      p.handle(event("turn/started", "child", { turn: { id: "turn-1" } }));
      p.handle(usage(7));
      // Await the first failed drain; flush may retry it, so inspect journal.
      await vi.waitFor(() => expect(f.persist).toHaveBeenCalled());
      await Promise.resolve();
      expect(JSON.parse(fs.readFileSync(path.join(f.dir, "codex-children.json"), "utf8")).pending.length).toBeGreaterThan(0);
      p = f.create();
      p.handle(usage(7));
      p.handle(event("turn/started", "child", { turn: { id: "turn-2" } }));
      p.handle(usage(14, "turn-2"));
      await p.flush();
      expect(f.operations.filter(op => op.type === "ensure")).toHaveLength(1);
      const calls = f.operations.filter(op => op.type === "usage");
      expect(calls).toHaveLength(2);
      expect(new Set(calls.map(call => call.observation.callId)).size).toBe(2);
    } finally { f.cleanup(); }
  });
});
