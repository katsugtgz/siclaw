import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { manageSchedule, type ManageScheduleParams } from "../schedule-service.js";
import { listBoundClusters, listBoundHosts, type ProductServiceResult } from "../resource-list-service.js";
import { previewSkillDraft } from "../skill-preview-service.js";
import { saveSessionFeedback, type SessionFeedbackContext, type SessionFeedbackParams } from "../session-feedback-service.js";
import { mcpDigest } from "../mcp-operation-policy.js";
import type { KubeconfigRef } from "../types.js";
import type { ChannelMessageExecutor } from "../tool-registry.js";

export interface CodexWorkflowConfig {
  executionClient?: import("../../agentbox/gateway-client.js").GatewayClient;
  schedule: boolean; report: boolean; sessionId: () => string;
  kubeconfigRef?: KubeconfigRef; clusterList?: boolean; hostList?: boolean; allowClusterProbe?: boolean;
  draftsRoot?: string; feedback?: Omit<SessionFeedbackContext, "sessionId">; channelUpdate?: ChannelMessageExecutor;
}
const string = (maxLength = 32768) => ({ type: "string", maxLength });
const schema = (properties: Record<string, object>, required: string[] = []) => ({ type: "object" as const, additionalProperties: false, properties, required });

/** Product contracts exposed through native MCP, never a Pi tool bridge. */
export class CodexWorkflow {
  readonly tools: Tool[];
  private readonly calls = new Map<string, { tool: string; threadId: string; turnId: string; args: Record<string, unknown>; used: boolean; controller: AbortController }>();
  private closed = false;

  constructor(private readonly options: CodexWorkflowConfig & {
    active: () => { threadId: string; turnId: string } | undefined;
    ownsRead?: (threadId: string, turnId: string) => boolean;
    projectArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
    cwd?: string;
    canFinalize?: () => boolean;
    authorizeTool?: (name: string) => void;
  }) {
    this.tools = [
      ...(options.clusterList && options.kubeconfigRef?.credentialBroker ? [{ name: "cluster_list",
        description: "List/search only clusters bound to this Agent, including administrator metadata and kube-context names. Name is a case-insensitive substring. Default lookup acquires no credential or Kubernetes API access. Ask the user to choose when several clusters match. " +
          (options.allowClusterProbe ? "Opt-in probe=true tests only returned clusters. Only unreachable means connectivity failed; probe_failed can mean local credentials/auth/TLS trouble. Auth/authz with reachable=true means the API answered." : "Probing is unavailable under this metadata-only capability."),
        inputSchema: schema({ name: string(512), probe: { type: "boolean", ...(options.allowClusterProbe ? {} : { enum: [false] }) } }),
        annotations: { readOnlyHint: true, destructiveHint: false } }] : []),
      ...(options.hostList && options.kubeconfigRef?.credentialBroker ? [{ name: "host_list",
        description: "List/search only bound SSH hosts. Query filters name/IP/description; IP-like queries are exact matches. Returns id/name/IP/port/username/auth_type/is_production/jump_host, total and next_cursor. Page capped results with cursor; credentials are never acquired or returned. Max limit 100.",
        inputSchema: schema({ query: string(512), limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: string(4096) }),
        annotations: { readOnlyHint: true, destructiveHint: false } }] : []),
      ...(options.draftsRoot ? [{ name: "skill_preview",
        description: `Render the complete Skill draft under ${options.draftsRoot}/<name> as a preview. Write SKILL.md and all files first; call once. The selected draft directory is then removed. This never publishes, approves, loads or executes proposed code.`,
        inputSchema: schema({ dir: { ...string(4096), minLength: 1 } }, ["dir"]),
        annotations: { readOnlyHint: false, destructiveHint: true } }] : []),
      ...(options.feedback ? [{ name: "save_feedback",
        description: "Save a structured report in this diagnostic session's records after reviewing feedback with the user. Siclaw supplies actor/session identity. This is not a human thumbs-up/down vote or native memory.",
        inputSchema: schema({ overallRating: { type: "integer", minimum: 1, maximum: 5 }, summary: { ...string(), minLength: 1 },
          ...Object.fromEntries(["decisionPoints", "strengths", "improvements", "tags", "feedbackConversation"].map(key => [key, string(128 * 1024)])) }, ["overallRating", "summary"]),
        annotations: { readOnlyHint: false, destructiveHint: false } }] : []),
      ...(options.channelUpdate ? [{ name: "channel_update",
        description: "Send a sparse milestone, final conclusion or artifact note to this session's current IM channel. Siclaw supplies the recipient and applies delivery/coalescing limits. Not for raw tool output, retries, heartbeat text or every small step.",
        inputSchema: schema({ kind: { type: "string", enum: ["milestone", "final", "artifact"] }, text: { ...string(), minLength: 1 } }, ["text"]),
        annotations: { readOnlyHint: false, destructiveHint: false } }] : []),
      ...(options.schedule ? [{ name: "manage_schedule", description:
        "Create, update, delete, pause, resume, rename or list this Agent's scheduled tasks. Operations execute immediately. " +
        "Use the user's language for name/description. Include the exact cluster/namespace or host in a self-contained description. " +
        "Use list to obtain identifiers; pause is reversible, delete is permanent. Report completed operations in past tense.",
        inputSchema: { type: "object" as const, additionalProperties: false, required: ["action"], properties: {
          action: { type: "string", enum: ["create", "update", "delete", "pause", "resume", "rename", "list"] },
          ...Object.fromEntries(["id", "name", "newName", "description", "schedule"].map(key => [key, { type: "string", maxLength: 32768 }])),
          status: { type: "string", enum: ["active", "paused"] },
        } }, annotations: { readOnlyHint: false, destructiveHint: true } }] : []),
      ...(options.report ? [{ name: "task_report", description:
        "Submit the final Markdown findings report for this automated task. Call exactly once at the end; this is the task output delivered to the user.",
        inputSchema: { type: "object" as const, additionalProperties: false, required: ["summary"],
          properties: { summary: { type: "string", minLength: 1, maxLength: 131072 } } },
        annotations: { readOnlyHint: true, destructiveHint: false } }] : []),
    ];
  }

  observe(event: { method: string; params: Record<string, any> }): void {
    const p = event.params, item = p.item;
    if (event.method === "item/completed" && typeof item?.id === "string") { this.remove(item.id); return; }
    if (event.method === "turn/completed") {
      for (const [id, call] of this.calls) if (call.threadId === p.threadId && call.turnId === (p.turnId ?? p.turn?.id)) this.remove(id);
      return;
    }
    if (this.closed || event.method !== "item/started" || item?.type !== "mcpToolCall" || item.server !== "siclaw_workflow" ||
        typeof item.id !== "string" || !item.id || typeof p.threadId !== "string" || typeof p.turnId !== "string" ||
        this.calls.has(item.id) || this.calls.size >= 256 || !this.tools.some(tool => tool.name === item.tool) || !this.owns(p.threadId, p.turnId, item.tool)) return;
    let args = item.arguments ?? {};
    try { if (typeof args === "string") args = JSON.parse(args); mcpDigest(args); } catch { return; }
    if (!args || typeof args !== "object" || Array.isArray(args)) return;
    this.calls.set(item.id, { tool: item.tool, threadId: p.threadId, turnId: p.turnId,
      args: structuredClone(args), used: false, controller: new AbortController() });
  }

  private owns(threadId: string, turnId: string, name: string): boolean {
    const active = this.options.active();
    return active?.threadId === threadId && active.turnId === turnId ||
      ["cluster_list", "host_list"].includes(name) && this.options.ownsRead?.(threadId, turnId) === true;
  }

  async call(args: Record<string, unknown>, callId: string, signal: AbortSignal, name: string) {
    // Native item notifications and HTTP can arrive in either order.
    for (let i = 0; !this.calls.has(callId) && !this.closed && i < 100; i++) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const call = this.calls.get(callId);
    const check = () => {
      this.options.authorizeTool?.(name);
      signal.throwIfAborted();
      if (this.closed || !call || this.calls.get(callId) !== call || call.controller.signal.aborted || call.tool !== name ||
          !this.owns(call.threadId, call.turnId, name) || mcpDigest(this.options.projectArguments?.(call.args) ?? call.args) !== mcpDigest(args))
        throw new Error("Product operation has no active owned turn or matching arguments");
    };
    check();
    if (call!.used) throw new Error("Product call was already dispatched");
    this.validate(name, args);
    call!.used = true;
    const bounded = AbortSignal.any([signal, call!.controller.signal]);
    const result = await this.execute(args, name, bounded);
    check();
    return result;
  }

  private validate(name: string, args: Record<string, unknown>): void {
    const tool = this.tools.find(tool => tool.name === name);
    if (!tool) throw new Error("Product capability is unavailable");
    const fields = tool.inputSchema.properties ?? {};
    if (Object.keys(args).some(key => !Object.hasOwn(fields, key))) throw new Error("Product arguments contain an unsupported field");
    for (const key of tool.inputSchema.required ?? []) if (!Object.hasOwn(args, key)) throw new Error("Required product argument missing");
    for (const [key, value] of Object.entries(args)) {
      const rule = fields[key] as Record<string, any>;
      if (rule.type === "string" && (typeof value !== "string" || value.length > rule.maxLength || rule.minLength && !value.trim()) ||
          rule.type === "boolean" && typeof value !== "boolean" ||
          rule.type === "integer" && (!Number.isInteger(value) || (value as number) < rule.minimum || (value as number) > rule.maximum) ||
          rule.enum && !rule.enum.includes(value)) throw new Error("Invalid product argument");
    }
  }

  private async execute(args: Record<string, unknown>, name: string, signal: AbortSignal) {
    if ((name === "task_report" || name === "channel_update" && args.kind === "final") && this.options.canFinalize?.() === false)
      throw new Error("Owned native child executions are still running; use native waiting before submitting the final report");
    if (name === "cluster_list") return nativeResult(await listBoundClusters(this.options.kubeconfigRef!, args,
      { refresh: true, allowProbe: this.options.allowClusterProbe === true, signal }));
    if (name === "host_list") return nativeResult(await listBoundHosts(this.options.kubeconfigRef!, args, signal));
    if (name === "skill_preview") return nativeResult(previewSkillDraft(args.dir as string,
      { draftsRoot: this.options.draftsRoot!, cwd: this.options.cwd, signal }));
    if (name === "save_feedback") return nativeResult(await saveSessionFeedback(args as unknown as SessionFeedbackParams,
      { ...this.options.feedback!, sessionId: this.options.sessionId() }));
    if (name === "channel_update") {
      const sessionId = this.options.sessionId();
      if (!sessionId) throw new Error("Channel update has no owning session");
      const result = await this.options.channelUpdate!({ sessionId, kind: (args.kind ?? "milestone") as "milestone" | "final" | "artifact", text: args.text as string });
      return { content: [{ type: "text" as const, text: result.message }], structuredContent: { delivered: result.delivered } };
    }
    if (name === "task_report" && this.options.report) {
      if (Object.keys(args).some(key => key !== "summary") || typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 131072) throw new Error("Invalid task report");
      return { content: [{ type: "text", text: args.summary }], structuredContent: { summary: args.summary } };
    }
    if (name !== "manage_schedule" || !this.options.schedule || !["create", "update", "delete", "pause", "resume", "rename", "list"].includes(String(args.action)) ||
        Object.entries(args).some(([key, value]) => !["action", "id", "name", "newName", "description", "schedule", "status"].includes(key) || typeof value !== "string" || value.length > 32768) ||
        args.status !== undefined && args.status !== "active" && args.status !== "paused") throw new Error("Invalid schedule operation");
    const sessionId = this.options.sessionId();
    if (!sessionId) throw new Error("Schedule operation has no owning session");
    const result = this.options.executionClient
      ? await manageSchedule(args as unknown as ManageScheduleParams, sessionId, this.options.executionClient)
      : await manageSchedule(args as unknown as ManageScheduleParams, sessionId);
    return { ...result, isError: "error" in result.details && result.details.error === true };
  }
  cancel(): void { for (const id of this.calls.keys()) this.remove(id); }
  close(): void { this.closed = true; this.cancel(); }
  private remove(id: string): void { this.calls.get(id)?.controller.abort(); this.calls.delete(id); }
}

function nativeResult(result: ProductServiceResult) {
  return { content: result.content, structuredContent: result.details, isError: result.details.error === true };
}
