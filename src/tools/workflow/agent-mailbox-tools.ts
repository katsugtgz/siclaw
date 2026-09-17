import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";

export function createWaitAgentTool(refs: ToolRefs): ToolDefinition {
  return {
    name: "wait_agent",
    label: "Wait for Agent",
    description: "Wait for a child message or completion only when its result is needed for your next step. " +
      "Otherwise continue independent work. Mail is delivered separately into the current conversation. " +
      "Timeout does not stop a child. This tool does not retrieve reports or launch another agent.",
    parameters: Type.Object({ timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })) }),
    async execute(_id, params, signal) {
      const mailbox = refs.agentMailbox?.();
      if (!mailbox) throw new Error("No active parent turn mailbox");
      mailbox.reopen();
      const timeout = Math.max(1, Math.min(60_000, (params as { timeout_ms?: number }).timeout_ms ?? 30_000));
      const outcome = await mailbox.wait(timeout, signal);
      return { content: [{ type: "text", text: JSON.stringify({ outcome, timed_out: outcome === "timeout" }) }], details: { outcome } };
    },
  };
}

export function createSendParentMessageTool(refs: ToolRefs): ToolDefinition {
  return {
    name: "send_message",
    label: "Message Parent",
    description: "Send the parent a material finding or blocker while you continue working. " +
      "Your final result is delivered automatically; do not send routine progress or duplicate it here. " +
      "Delivery is queued at a safe boundary, not a hard interrupt. Cannot restart a finished parent.",
    parameters: Type.Object({ message: Type.String({ minLength: 1 }) }),
    async execute(_id, params) {
      const message = (params as { message: string }).message.trim();
      if (!message) throw new Error("Message must not be empty");
      const queued = refs.sendParentMessage?.(message) ?? false;
      return { content: [{ type: "text", text: JSON.stringify({ queued }) }], details: { queued } };
    },
  };
}

export const waitAgentRegistration: ToolEntry = {
  category: "workflow", modes: ["web", "cli", "channel"],
  available: refs => Boolean(refs.agentMailbox), create: createWaitAgentTool,
};
export const sendParentMessageRegistration: ToolEntry = {
  category: "workflow", available: refs => Boolean(refs.sendParentMessage), create: createSendParentMessageTool,
};
