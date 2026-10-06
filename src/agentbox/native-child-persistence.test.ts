import { describe, expect, it, vi } from "vitest";
import { createNativeChildSink } from "./native-child-persistence.js";
import type { NativeChildOperation } from "../core/brains/codex-child-projection.js";

describe("native child persistence boundary", () => {
  it("creates owned lineage, redacts transcript and reconciles a committed append whose acknowledgement was lost", async () => {
    const rows: Array<{ role: string; content: string; metadata: Record<string, unknown> }> = [];
    const sends: unknown[] = [];
    let loseAck = true;
    const gateway = { fetchSessionHistory: vi.fn(async () => ({ sessionId: "child", messages: [...rows] })),
      sendDelegationPersistenceEvent: vi.fn(async (event: any) => {
        sends.push(event);
        if (event.type === "delegation.append_message") {
          rows.push(event.message);
          if (loseAck) { loseAck = false; throw new Error("timeout after commit"); }
        }
        return { ok: true };
      }) };
    const sink = createNativeChildSink({ gateway, rootSessionId: "root", agentId: "agent", userId: "owner",
      redact: text => text.replaceAll("secret", "[REDACTED]"), recordUsage: vi.fn(), activity: vi.fn() });
    const child = { sessionId: "child", delegationId: "spawn", title: "native task" };
    await sink.persist({ key: "ensure", child, type: "ensure" });
    const message: NativeChildOperation = { key: "event-1", child, type: "message", role: "assistant", content: "secret" };
    await expect(sink.persist(message)).rejects.toThrow("timeout after commit");
    await sink.persist(message);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("[REDACTED]");
    expect(rows[0].metadata.native_projection_key).toBe("event-1");
    expect(sends[0]).toMatchObject({ type: "delegation.ensure_session", agentId: "agent", userId: "owner",
      origin: "subagent", lineage: { parentSessionId: "root", delegationId: "spawn" } });
    expect(gateway.fetchSessionHistory).toHaveBeenCalledTimes(2);
  });

  it("propagates rejected creation and completion persistence instead of claiming success", async () => {
    const gateway = { fetchSessionHistory: vi.fn(async () => ({ sessionId: "root", messages: [] })),
      sendDelegationPersistenceEvent: vi.fn(async () => ({ ok: false })) };
    const sink = createNativeChildSink({ gateway, rootSessionId: "root", agentId: "agent", userId: "owner",
      redact: text => text, recordUsage: vi.fn(), activity: vi.fn() });
    const child = { sessionId: "child", delegationId: "spawn", title: "native task" };
    await expect(sink.persist({ key: "ensure", child, type: "ensure" })).rejects.toThrow("session persistence rejected");
    await expect(sink.persist({ key: "status", child, type: "status", status: "done", summary: "report" }))
      .rejects.toThrow("message persistence rejected");
  });
});
