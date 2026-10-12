/** Notification receipt counters, not HTTP/LLM timings or billing telemetry. */
export class CodexStreamReceipts {
  private readonly turns = new Map<string, {
    threadId: string; turnId: string; startedAtMs: number;
    firstTextDeltaAtMs?: number; lastTextDeltaAtMs?: number;
    textDeltas: number; nativeRetries: number;
  }>();

  constructor(private readonly now: () => number = Date.now) {}

  observe(method: string, params: Record<string, unknown>) {
    const turn = params.turn as Record<string, unknown> | undefined;
    const threadId = params.threadId, turnId = params.turnId ?? turn?.id;
    // Never log arbitrary upstream values, text, errors, URLs or headers.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof threadId !== "string" || typeof turnId !== "string" || !uuid.test(threadId) || !uuid.test(turnId)) return;
    const key = `${threadId}:${turnId}`;
    if (method === "turn/started") {
      if (this.turns.size >= 128) this.turns.delete(this.turns.keys().next().value!);
      this.turns.set(key, { threadId, turnId, startedAtMs: this.now(), textDeltas: 0, nativeRetries: 0 });
      return;
    }
    const receipt = this.turns.get(key);
    if (!receipt) return;
    if (method === "item/agentMessage/delta") {
      receipt.firstTextDeltaAtMs ??= this.now();
      receipt.lastTextDeltaAtMs = this.now();
      receipt.textDeltas++;
    } else if (method === "error" && params.willRetry === true) receipt.nativeRetries++;
    else if (method === "turn/completed") {
      this.turns.delete(key);
      return { ...receipt, completedAtMs: this.now() };
    }
  }
}
