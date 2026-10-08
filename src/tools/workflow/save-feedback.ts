import type { ToolEntry } from "../../core/tool-registry.js";
/**
 * save_feedback tool — saves a structured report in this session's records.
 * This is independent of human thumbs-up/down votes and memory.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../core/config.js";
import { GatewayClient } from "../../agentbox/gateway-client.js";

import { saveSessionFeedback, type SessionFeedbackParams, type SessionFeedbackContext } from "../../core/session-feedback-service.js";


export function createSaveFeedbackTool(
  sessionIdRef: { current: string },
  context?: Omit<SessionFeedbackContext, "sessionId">,
): ToolDefinition {
  return {
    name: "save_feedback",
    label: "Save Session Feedback",
    description: `Save a structured feedback report for the current diagnostic session.
Call this after completing the interactive feedback review with the user.
The report includes overall rating, decision point evaluations, strengths, improvements, and tags.`,
    parameters: Type.Object({
      overallRating: Type.Integer({
        minimum: 1,
        maximum: 5,
        description: "Overall session rating (1=poor, 5=excellent)",
      }),
      summary: Type.String({
        description: "Brief summary of the feedback (1-3 sentences)",
      }),
      decisionPoints: Type.Optional(Type.String({
        description: "JSON array of decision point evaluations: [{ step: number, description: string, wasCorrect: boolean, comment?: string, idealAction?: string }]",
      })),
      strengths: Type.Optional(Type.String({
        description: "JSON array of strengths identified: string[]",
      })),
      improvements: Type.Optional(Type.String({
        description: "JSON array of improvements suggested: string[]",
      })),
      tags: Type.Optional(Type.String({
        description: 'JSON array of category tags: string[] (e.g. "wrong-skill", "slow-path", "missing-check")',
      })),
      feedbackConversation: Type.Optional(Type.String({
        description: "JSON summary of the feedback dialogue (optional)",
      })),
    }),
    async execute(_toolCallId, rawParams, signal) {
      signal?.throwIfAborted();
      const cfg = loadConfig();
      return saveSessionFeedback(rawParams as SessionFeedbackParams, { sessionId: sessionIdRef.current,
        userId: context?.userId ?? cfg.userId ?? "", agentId: context?.agentId ?? process.env.SICLAW_AGENT_ID,
        persist: context?.persist ?? (async report => {
          const client = new GatewayClient({ gatewayUrl: cfg.server.gatewayUrl || `http://localhost:${cfg.server.port}` });
          return client.toClientLike().request("/api/internal/feedback", "POST", report) as Promise<{ id: string }>;
        }) });
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createSaveFeedbackTool(refs.sessionIdRef, refs.feedbackContext),
};
