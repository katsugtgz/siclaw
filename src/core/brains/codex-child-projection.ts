import fs from "node:fs";
import { projectCodexMcpResult } from "./codex-mcp-result.js";
import { appendKnowledgeSourceCitations, knowledgeCitationsMetadata, type KnowledgeSourceCitation } from "../../shared/knowledge-citations.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { UsageObservation, UsageSink } from "../../shared/model-usage.js";

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => typeof v === "string" ? v : "";

export interface NativeChildInfo {
  sessionId: string;
  parentSessionId?: string;
  delegationId: string;
  title: string;
  traceId?: string;
}
export type NativeChildOperation = { key: string; child: NativeChildInfo } & (
  | { type: "ensure" }
  | { type: "message"; role: "user" | "assistant" | "tool"; content: string;
      toolName?: string; toolInput?: string; metadata?: ObjectValue; outcome?: "success" | "error" }
  | { type: "status"; status: "running" | "done" | "failed" | "cancelled"; summary: string }
  | { type: "usage"; observation: UsageObservation }
);
export interface NativeChildSink {
  persist(operation: NativeChildOperation): Promise<void>;
  /** Keeps a parent resident while its native children are still running. */
  activity(sessionId: string, running: boolean): void;
}
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "key" | "child"> : never;
interface Child extends NativeChildInfo {
  threadId: string;
  parentThreadId: string;
  modelId: string;
  provider: string;
  context: ReturnType<UsageSink["context"]>;
  turnId?: string;
  active: boolean;
  totalTokens: number;
  summary: string;
  lastStatus?: string;
}
interface Journal { version: 1; children: Child[]; done: string[]; pending: NativeChildOperation[] }

/** Stable opaque keys make outbox retries safe without exposing native thread IDs. */
export function nativeProjectionKey(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Read-only projection of native child execution. Never creates, resumes,
 * interrupts or supplies input to a child. Only a native spawn/activity item
 * from this root or an already owned descendant can establish ownership. */
export class CodexChildProjection {
  private readonly children = new Map<string, Child>();
  private readonly done = new Set<string>();
  private pending: NativeChildOperation[] = [];
  private readonly early = new Map<string, Array<{ method: string; params: ObjectValue }>>();
  private earlyBytes = 0;
  private sink?: NativeChildSink;
  private draining?: Promise<void>;
  private error?: Error;
  private readonly file: string;
  private readonly knowledgeSources = new Map<string, KnowledgeSourceCitation[]>();

  constructor(directory: string, private readonly root: () => string | undefined,
    private readonly context: () => ReturnType<UsageSink["context"]>,
    private readonly model: () => { id: string; provider: string },
    private readonly usage: (child: Child, params: ObjectValue, callId: string) => UsageObservation | undefined,
    private readonly inspect?: (threadId: string, parentThreadId: string) => Promise<string>,
    private readonly redact?: (text: string) => string) {
    this.file = path.join(directory, "codex-children.json");
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as Journal;
      if (saved.version !== 1 || !Array.isArray(saved.children) || !Array.isArray(saved.pending) || !Array.isArray(saved.done)) {
        throw new Error("Invalid native child projection journal");
      }
      for (const child of saved.children) this.children.set(child.threadId, { ...child, active: false, turnId: undefined });
      for (const key of saved.done) this.done.add(key);
      this.pending = saved.pending;
    }
  }

  setSink(sink: NativeChildSink): void {
    this.sink = sink;
    this.startDrain();
  }

  ownsActive(threadId: string): boolean { return this.children.get(threadId)?.active === true; }
  setKnowledgeSources(threadId: string, sources: KnowledgeSourceCitation[]): void {
    if (this.ownsActive(threadId)) this.knowledgeSources.set(threadId, sources);
  }

  /** Called before the root-only public stream filter. */
  handle(event: { method: string; params: ObjectValue }): void {
    const threadId = text(event.params.threadId);
    if (!threadId) return;
    const ownedParent = threadId === this.root() || this.children.has(threadId);
    const item = object(event.params.item) ? event.params.item : undefined;
    if (ownedParent && item && ["item/started", "item/completed"].includes(event.method)) {
      if (item.type === "collabAgentToolCall") {
        const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
        if (item.tool === "spawnAgent" && item.status !== "failed") {
          for (const id of receivers) if (text(id)) this.anchor(text(id), threadId, text(item.id), text(item.prompt), text(item.model));
        }
        for (const id of receivers) {
          const child = this.children.get(text(id));
          if (!child) continue;
          if (["sendInput", "followupTask", "resumeAgent"].includes(text(item.tool)) && item.status !== "failed") {
            child.context = { ...(this.children.get(threadId)?.context ?? this.context()) };
            this.save(); // Capture before the native child can complete its first response.
          }
          const states = object(item.agentsStates) ? item.agentsStates : {};
          const value = states[text(id)];
          const state = object(value) ? value : {};
          if (state.status === "completed") this.status(child, "done", text(state.message), text(item.id));
          else if (state.status === "errored") this.status(child, "failed", text(state.message), text(item.id));
          else if (item.tool === "closeAgent" && child.active) this.status(child, "cancelled", child.summary, text(item.id));
        }
      } else if (item.type === "subAgentActivity") {
        const id = text(item.agentThreadId);
        if (item.kind === "started" && id) this.anchor(id, threadId, text(item.id), text(item.agentPath), "");
        const child = this.children.get(id);
        if (child && item.kind === "interacted") child.context = { ...this.context() };
        if (child && item.kind === "completed") this.status(child, "done", child.summary, text(item.id));
        if (child && item.kind === "interrupted") this.status(child, "cancelled", child.summary, text(item.id));
      }
    }
    if (threadId === this.root()) return;
    const child = this.children.get(threadId);
    if (child) this.childEvent(child, event);
    else if (["turn/started", "turn/completed", "item/completed", "thread/tokenUsage/updated"].includes(event.method)) {
      // Auto-attached native listeners can deliver child events before the
      // parent's spawn result. Hold a bounded buffer; unrelated/internal
      // threads never establish ownership and never reach the sink.
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (this.early.size >= 64 && !this.early.has(threadId) || this.earlyBytes + bytes > 2_000_000) {
        this.early.clear(); this.earlyBytes = 0;
      }
      const events = this.early.get(threadId) ?? [];
      if (events.length < 256 && bytes < 256_000) {
        events.push(event); this.early.set(threadId, events); this.earlyBytes += bytes;
      }
    }
  }

  /** UI metadata only; the model continues to receive untouched native output. */
  details(item: ObjectValue): ObjectValue | undefined {
    const id = item.type === "subAgentActivity" ? text(item.agentThreadId)
      : Array.isArray(item.receiverThreadIds) ? text(item.receiverThreadIds[0]) : "";
    const child = this.children.get(id);
    if (!child) return undefined;
    return { native_subagent: true, child_session_id: child.sessionId, job_id: child.delegationId,
      scope: child.title, status: child.active ? "launched" : child.lastStatus ?? "done" };
  }

  private anchor(threadId: string, parentThreadId: string, delegationId: string, title: string, modelId: string): void {
    if (!delegationId || threadId === this.root() || this.children.has(threadId)) return;
    const parent = this.children.get(parentThreadId);
    const child: Child = { sessionId: randomUUID(), parentSessionId: parent?.sessionId,
      delegationId, title: title.slice(0, 500) || "Native sub-agent", threadId, parentThreadId,
      modelId: modelId || parent?.modelId || this.model().id, provider: parent?.provider || this.model().provider,
      context: { ...(parent?.context ?? this.context()) },
      active: false, totalTokens: 0, summary: "" };
    this.children.set(threadId, child);
    this.enqueue(child, "ensure", { type: "ensure" });
    this.status(child, "running", "", "spawn");
    const buffered = this.early.get(threadId) ?? [];
    this.early.delete(threadId);
    this.earlyBytes -= buffered.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
    for (const event of buffered) this.childEvent(child, event);
    this.save();
  }

  private childEvent(child: Child, event: { method: string; params: ObjectValue }): void {
    const p = event.params;
    const turn = object(p.turn) ? p.turn : {};
    if (event.method === "turn/started") {
      this.knowledgeSources.delete(child.threadId);
      child.turnId = text(turn.id);
      this.status(child, "running", "", child.turnId);
    } else if (event.method === "item/completed" && object(p.item)) {
      const item = p.item;
      const key = `item:${text(item.id)}`;
      if (item.type === "agentMessage") {
        const sources = item.phase === "commentary" ? [] : this.knowledgeSources.get(child.threadId) ?? [];
        const content = appendKnowledgeSourceCitations(text(item.text), sources);
        if (content) {
          if (item.phase !== "commentary") child.summary = content;
          this.enqueue(child, key, { type: "message", role: "assistant", content,
            metadata: { phase: item.phase, assistant_item: { api: "openai-responses", model: child.modelId },
              ...(sources.length ? { knowledge_citations: knowledgeCitationsMetadata(sources) } : {}) } });
        }
      } else if (item.type === "userMessage" && Array.isArray(item.content)) {
        const content = item.content.filter(object).map(block => text(block.text)).join("\n");
        if (content) this.enqueue(child, key, { type: "message", role: "user", content });
      } else if (["commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall"].includes(text(item.type))) {
        const toolName = item.type === "commandExecution" ? "exec_command" : item.type === "fileChange" ? "apply_patch" : text(item.tool);
        const result = item.type === "mcpToolCall" ? projectCodexMcpResult(item, this.redact) : object(item.result) ? item.result : {};
        const failed = item.status === "failed" || item.status === "declined" || result.isError === true || typeof item.exitCode === "number" && item.exitCode !== 0;
        const content = text(item.aggregatedOutput) || (Array.isArray(result.content)
          ? result.content.filter(object).map(block => text(block.text)).join("\n") : "");
        this.enqueue(child, key, { type: "message", role: "tool", toolName, content,
          toolInput: text(item.command) || (item.arguments ? JSON.stringify(item.arguments) : undefined),
          metadata: { ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}), ...this.details(item) },
          outcome: failed ? "error" : "success" });
      }
    } else if (event.method === "thread/tokenUsage/updated" && object(p.tokenUsage)) {
      const total = object(p.tokenUsage.total) ? Number(p.tokenUsage.total.totalTokens) : 0;
      if (Number.isFinite(total) && total > child.totalTokens) {
        // A replay cannot become a new call. Persisted totals also fence repeats
        // after an app-server or AgentBox restart.
        if (child.active && child.turnId === p.turnId) {
          const observation = this.usage(child, p.tokenUsage, nativeProjectionKey(`${child.threadId}:usage:${total}`));
          if (observation) this.enqueue(child, `usage:${total}`, { type: "usage", observation });
        }
        child.totalTokens = total;
        this.save();
      }
    } else if (event.method === "turn/completed") {
      child.turnId = undefined;
      this.status(child, turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "cancelled" : "done",
        child.summary, text(turn.id));
    }
  }

  private status(child: Child, status: "running" | "done" | "failed" | "cancelled", summary: string, eventId: string): void {
    const running = status === "running";
    if (child.active !== running) { child.active = running; this.sink?.activity(child.sessionId, running); }
    if (child.lastStatus === status) return;
    child.lastStatus = status;
    this.enqueue(child, `status:${eventId}:${status}`, { type: "status", status, summary });
  }

  private enqueue(child: Child, key: string, value: WithoutEnvelope<NativeChildOperation>): void {
    const id = nativeProjectionKey(`${child.threadId}:${key}`);
    if (this.done.has(id) || this.pending.some(operation => operation.key === id)) return;
    if (this.pending.length >= 2048) throw new Error("Native child projection backlog is full");
    const info: NativeChildInfo = { sessionId: child.sessionId, parentSessionId: child.parentSessionId,
      delegationId: child.delegationId, title: child.title, traceId: child.context.traceId };
    this.pending.push({ ...value, child: info, key: id } as NativeChildOperation);
    this.save();
    this.startDrain();
  }

  private startDrain(): void {
    if (!this.sink || this.draining || !this.pending.length) return;
    this.error = undefined;
    this.draining = (async () => {
      while (this.pending.length && this.sink) {
        const operation = this.pending[0]!;
        const child = [...this.children.values()].find(value => value.sessionId === operation.child.sessionId)!;
        if (operation.type === "ensure" && this.inspect) child.modelId = await this.inspect(child.threadId, child.parentThreadId);
        if (operation.type === "usage") {
          operation.observation.model.requestedId = child.modelId;
          operation.observation.responseModel = child.modelId;
        }
        await this.sink.persist(operation);
        this.done.add(operation.key);
        this.pending.shift();
        this.save();
      }
    })().catch(() => {
      this.error = new Error("Native child projection persistence is unavailable");
      console.warn("[codex-agent] native child projection remains pending");
    }).finally(() => {
      this.draining = undefined;
      if (this.pending.length && !this.error) this.startDrain();
    });
  }

  async flush(): Promise<void> {
    this.startDrain();
    while (this.draining) await this.draining;
    if (this.sink && this.error) throw this.error;
  }

  private save(): void {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    const journal: Journal = { version: 1, children: [...this.children.values()], done: [...this.done], pending: this.pending };
    fs.writeFileSync(tmp, JSON.stringify(journal), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
