import type { ProductServiceResult } from "./resource-list-service.js";

export interface SessionFeedbackParams {
  overallRating: number; summary: string; decisionPoints?: string; strengths?: string;
  improvements?: string; tags?: string; feedbackConversation?: string;
}
export interface SessionFeedbackContext {
  sessionId: string; userId: string; agentId?: string | null;
  persist: (report: Record<string, unknown>) => Promise<{ id: string }>;
}

/** A structured diagnostic report, not a human thumbs-up/down vote or memory. */
export async function saveSessionFeedback(params: SessionFeedbackParams, context: SessionFeedbackContext): Promise<ProductServiceResult> {
  if (!context.userId || context.userId === "unknown") return failed("Cannot save feedback: userId not configured.");
  if (!context.sessionId) return failed("Cannot save feedback: session ID not available.");
  const errors: string[] = [];
  const parse = (name: string, value?: string): unknown => {
    if (!value) return undefined;
    try { return JSON.parse(value); } catch { errors.push(name); return undefined; }
  };
  const report: Record<string, unknown> = { sessionId: context.sessionId, userId: context.userId,
    ...(context.agentId ? { agentId: context.agentId } : {}), overallRating: params.overallRating, summary: params.summary,
    decisionPoints: parse("decisionPoints", params.decisionPoints), strengths: parse("strengths", params.strengths),
    improvements: parse("improvements", params.improvements), tags: parse("tags", params.tags) };
  const conversation = parse("feedbackConversation", params.feedbackConversation);
  const omitted = conversation !== undefined && JSON.stringify(conversation).length > 100 * 1024;
  if (!omitted) report.feedbackConversation = conversation;
  try {
    const value = await context.persist(report);
    if (!value || typeof value.id !== "string" || !value.id) throw new Error("No persistence receipt");
    return { content: [{ type: "text", text: `Feedback saved successfully (id: ${value.id}).${omitted ? " Note: conversation transcript omitted (exceeded size limit)." : ""}${errors.length ? ` Warning: failed to parse ${errors.join(", ")} (saved without these fields).` : ""}` }],
      details: { id: value.id, sessionId: context.sessionId, sessionFeedback: report } };
  } catch {
    return failed("Failed to save feedback: persistence did not acknowledge a stored report. Do not automatically retry an unknown outcome.");
  }
}

function failed(text: string): ProductServiceResult { return { content: [{ type: "text", text }], details: { error: true } }; }
