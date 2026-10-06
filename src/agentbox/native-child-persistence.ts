import type { NativeChildSink, NativeChildOperation } from "../core/brains/codex-child-projection.js";
import type { GatewayClient } from "./gateway-client.js";
import type { UsageObservation } from "../shared/model-usage.js";
import type { DelegationAppendMessagePayload } from "../shared/delegation-persistence.js";

/** Reuses Runtime-owned persistence and ownership checks. No Pi child runner,
 * tool definitions, prompt injection or direct Gateway/Portal DB imports. */
export function createNativeChildSink(options: {
  gateway: Pick<GatewayClient, "sendDelegationPersistenceEvent" | "fetchSessionHistory">;
  rootSessionId: string; agentId: string; userId: string;
  redact(text: string): string;
  recordUsage(observation: UsageObservation): void;
  activity(sessionId: string, running: boolean): void;
}): NativeChildSink {
  const known = new Map<string, Set<string>>();
  async function appendOnce(key: string, message: DelegationAppendMessagePayload): Promise<void> {
    let keys = known.get(message.sessionId);
    if (!keys) {
      const history = await options.gateway.fetchSessionHistory(message.sessionId);
      keys = new Set(history.messages.flatMap(row => {
        const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
        return meta && typeof meta.native_projection_key === "string" ? [meta.native_projection_key] : [];
      }));
      known.set(message.sessionId, keys);
    }
    if (keys.has(key)) return;
    try {
      const result = await options.gateway.sendDelegationPersistenceEvent({ type: "delegation.append_message",
        message: { ...message, metadata: { ...message.metadata, native_projection_key: key } } });
      if (!result.ok) throw new Error("Native child message persistence rejected");
      keys.add(key);
    } catch (error) {
      // A timeout may follow a committed append. Re-read before a retry rather
      // than assuming the first append failed; the durable journal retains it.
      known.delete(message.sessionId);
      throw error;
    }
  }
  return {
    activity: options.activity,
    async persist(operation: NativeChildOperation): Promise<void> {
      const child = operation.child;
      const parentSessionId = child.parentSessionId ?? options.rootSessionId;
      const lineage = { parentSessionId, parentAgentId: options.agentId,
        delegationId: child.delegationId, targetAgentId: options.agentId };
      if (operation.type === "ensure") {
        const result = await options.gateway.sendDelegationPersistenceEvent({ type: "delegation.ensure_session",
          sessionId: child.sessionId, agentId: options.agentId, userId: options.userId,
          title: options.redact(child.title).slice(0, 100), origin: "subagent", lineage });
        if (!result.ok) throw new Error("Native child session persistence rejected");
      } else if (operation.type === "usage") {
        // ensure_session is ordered ahead of usage; Runtime can resolve owner.
        options.recordUsage(operation.observation);
      } else if (operation.type === "message") {
        const redactMetadata = operation.metadata
          ? JSON.parse(options.redact(JSON.stringify(operation.metadata))) as Record<string, unknown> : undefined;
        await appendOnce(operation.key, { sessionId: child.sessionId, parentSessionId,
          delegationId: child.delegationId, targetAgentId: options.agentId, fromAgentId: options.agentId,
          traceId: child.traceId, role: operation.role, content: options.redact(operation.content),
          toolName: operation.toolName, toolInput: operation.toolInput ? options.redact(operation.toolInput) : undefined,
          metadata: redactMetadata, outcome: operation.outcome });
      } else if (operation.status !== "running") {
        const summary = options.redact(operation.summary);
        await appendOnce(operation.key, { sessionId: parentSessionId, parentSessionId,
          delegationId: child.delegationId, targetAgentId: options.agentId, fromAgentId: options.agentId,
          traceId: child.traceId, role: "user", content: summary,
          metadata: { kind: "delegation_event", native_subagent: true, source: "system_notification",
            event_type: `delegation.${operation.status}`, status: operation.status,
            delegation_id: child.delegationId, child_session_id: child.sessionId,
            target_agent_id: options.agentId, scope: options.redact(child.title) } });
        const result = await options.gateway.sendDelegationPersistenceEvent({ type: "delegation.emit_chat_event",
          sessionId: parentSessionId, event: { type: "subagent_done", sessionId: parentSessionId,
            job_id: child.delegationId, status: operation.status, is_group: false } });
        if (!result.ok) throw new Error("Native child completion notification rejected");
      }
    },
  };
}
