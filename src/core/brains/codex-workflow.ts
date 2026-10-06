import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { manageSchedule, type ManageScheduleParams } from "../schedule-service.js";

/** Product contracts exposed through native MCP, never a Pi tool bridge. */
export class CodexWorkflow {
  readonly tools: Tool[];
  private readonly calls = new Map<string, { tool: string; turnId: string; used?: boolean }>();

  constructor(private readonly options: {
    schedule: boolean; report: boolean; sessionId: () => string;
    active: () => { threadId: string; turnId: string } | undefined;
  }) {
    this.tools = [
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
    const active = this.options.active(), p = event.params;
    if (!active || active.threadId !== p.threadId || active.turnId !== (p.turnId ?? p.turn?.id)) return;
    if (event.method === "item/started" && p.item?.type === "mcpToolCall" && p.item.server === "siclaw_workflow" &&
        this.tools.some(tool => tool.name === p.item.tool)) this.calls.set(p.item.id, { tool: p.item.tool, turnId: active.turnId });
    if (event.method === "item/completed") this.calls.delete(p.item?.id);
    if (event.method === "turn/completed") this.calls.clear();
  }

  async call(args: Record<string, unknown>, callId: string, signal: AbortSignal, name: string) {
    // Native item notifications and HTTP can arrive in either order.
    for (let i = 0; !this.calls.has(callId) && i < 100; i++) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    signal.throwIfAborted();
    const call = this.calls.get(callId), active = this.options.active();
    if (!call || call.used || call.tool !== name || call.turnId !== active?.turnId) throw new Error("Product operation has no active owned turn");
    if (name === "task_report" && this.options.report) {
      if (Object.keys(args).some(key => key !== "summary") || typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 131072) throw new Error("Invalid task report");
      call.used = true;
      return { content: [{ type: "text", text: args.summary }], structuredContent: { summary: args.summary } };
    }
    if (name !== "manage_schedule" || !this.options.schedule || !["create", "update", "delete", "pause", "resume", "rename", "list"].includes(String(args.action)) ||
        Object.entries(args).some(([key, value]) => !["action", "id", "name", "newName", "description", "schedule", "status"].includes(key) || typeof value !== "string" || value.length > 32768) ||
        args.status !== undefined && args.status !== "active" && args.status !== "paused") throw new Error("Invalid schedule operation");
    const sessionId = this.options.sessionId();
    if (!sessionId) throw new Error("Schedule operation has no owning session");
    call.used = true;
    const result = await manageSchedule(args as unknown as ManageScheduleParams, sessionId);
    return { ...result, isError: "error" in result.details && result.details.error === true };
  }
}
