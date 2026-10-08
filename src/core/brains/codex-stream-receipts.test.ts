import { describe, expect, it } from "vitest";
import { CodexStreamReceipts } from "./codex-stream-receipts.js";

const threadId = "01a1175e-6ec0-7d32-8695-f511724846d3";
const turnId = "4c943852-3db6-44bb-a8a5-89dd451f0543";
describe("native text receipt diagnostics", () => {
  it("counts notifications and retries without retaining any content", () => {
    let now = 10;
    const counts = new CodexStreamReceipts(() => now);
    counts.observe("turn/started", { threadId, turn: { id: turnId } });
    now = 20;
    counts.observe("item/agentMessage/delta", { threadId, turnId, delta: "fixture-secret-body" });
    counts.observe("error", { threadId, turnId, willRetry: true, error: { message: "fixture-secret-error" } });
    now = 30;
    const result = counts.observe("turn/completed", { threadId, turn: { id: turnId } });
    expect(result).toMatchObject({ startedAtMs: 10, firstTextDeltaAtMs: 20, lastTextDeltaAtMs: 20,
      completedAtMs: 30, textDeltas: 1, nativeRetries: 1 });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(counts.observe("turn/completed", { threadId, turnId })).toBeUndefined();
  });
  it("does not log malformed identifiers, stale turns or private reasoning", () => {
    const counts = new CodexStreamReceipts();
    counts.observe("turn/started", { threadId: "fixture-secret", turnId });
    expect(counts.observe("turn/completed", { threadId: "fixture-secret", turnId })).toBeUndefined();
    counts.observe("turn/started", { threadId, turnId });
    counts.observe("item/reasoning/textDelta", { threadId, turnId, delta: "private" });
    const result = counts.observe("turn/completed", { threadId, turnId });
    expect(result?.textDeltas).toBe(0);
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
