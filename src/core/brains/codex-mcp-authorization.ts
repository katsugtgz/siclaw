import { mcpDigest } from "../mcp-operation-policy.js";
import type { McpOperation, McpOperationAuthorizer } from "../../shared/mcp-authorization.js";

/** A private proxy bearer authenticates transport, not model authority. Match
 * every external call to a live, owned native item before contacting Runtime. */
export class CodexMcpAuthorization {
  private readonly calls = new Map<string, { server: string; name: string; threadId: string; turnId: string;
    args: Record<string, unknown>; used: boolean; controller: AbortController }>();
  private readonly waiters = new Map<string, () => void>();
  private closed = false;

  constructor(private readonly options: {
    owns: (threadId: string, turnId: string) => boolean;
    projectArguments: (server: string, name: string, args: Record<string, unknown>) => Record<string, unknown>;
    authorize?: McpOperationAuthorizer;
  }) {}

  observe(event: { method: string; params: Record<string, unknown> }): void {
    const params = event.params, item = params.item as Record<string, unknown> | undefined;
    if (event.method === "turn/completed") {
      for (const [id, call] of this.calls) if (call.threadId === params.threadId) this.remove(id);
      return;
    }
    if (!item || typeof item.id !== "string") return;
    if (event.method === "item/completed") { this.remove(item.id); return; }
    if (this.closed || event.method !== "item/started" || item.type !== "mcpToolCall" || this.calls.size >= 256 || this.calls.has(item.id) ||
        typeof params.threadId !== "string" || typeof params.turnId !== "string" || !this.options.owns(params.threadId, params.turnId) ||
        typeof item.server !== "string" || typeof item.tool !== "string") return;
    let args = item.arguments;
    try { if (typeof args === "string") args = JSON.parse(args); } catch { return; }
    if (!args || typeof args !== "object" || Array.isArray(args)) return;
    this.calls.set(item.id, { server: item.server, name: item.tool, threadId: params.threadId, turnId: params.turnId,
      args: structuredClone(args) as Record<string, unknown>, used: false, controller: new AbortController() });
    this.waiters.get(item.id)?.();
  }

  readonly authorize: McpOperationAuthorizer = async (operation, signal, phase) => {
    // This API currently authorizes native tool items. Resource/prompt reads
    // need a separately verified native attribution contract, not a guessed owner.
    if (this.closed || !this.options.authorize || operation.kind !== "tool" || !operation.callId) throw new Error("MCP call has no live authorization authority");
    if (phase === "before" && !this.calls.has(operation.callId)) {
      if (this.waiters.size >= 256 || this.waiters.has(operation.callId)) throw new Error("MCP call attribution unavailable");
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); this.waiters.delete(operation.callId); resolve(); };
        const timer = setTimeout(finish, 2000); this.waiters.set(operation.callId, finish);
        signal.addEventListener("abort", finish, { once: true }); if (signal.aborted) finish();
      });
    }
    const call = this.calls.get(operation.callId);
    const check = () => {
      signal.throwIfAborted();
      if (this.closed || !call || this.calls.get(operation.callId) !== call || call.controller.signal.aborted ||
          !this.options.owns(call.threadId, call.turnId) || call.server !== operation.server || call.name !== operation.name ||
          mcpDigest(this.options.projectArguments(call.server, call.name, call.args)) !== mcpDigest(operation.arguments)) throw new Error("MCP operation is not bound to the owned native item");
    };
    check();
    if (phase === "before") {
      if (call!.used) throw new Error("MCP call was already dispatched");
      call!.used = true;
    } else if (!call!.used) throw new Error("MCP result has no prior authorization");
    const bounded = AbortSignal.any([signal, call!.controller.signal]);
    const permit = await this.options.authorize(operation, bounded, phase);
    check();
    return permit;
  };

  cancel(): void {
    for (const id of this.calls.keys()) this.remove(id);
    for (const finish of this.waiters.values()) finish();
  }
  close(): void { this.closed = true; this.cancel(); }
  private remove(id: string): void { this.calls.get(id)?.controller.abort(); this.calls.delete(id); this.waiters.get(id)?.(); }
}
