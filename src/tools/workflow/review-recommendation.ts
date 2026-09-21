import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";

const levels = ["high", "medium", "low", "unknown"] as const;
const reasons = ["unresolved", "user_dissatisfaction", "tool_failure", "repeated_attempt", "uncertain_conclusion", "long_or_complex_path"] as const;

/** An advisory signal, not a verdict or authorization to suppress a review. */
export function createReviewRecommendationTool(refs: Pick<ToolRefs, "turnRef">): ToolDefinition {
  let reportedTurn: number | undefined;
  return {
    name: "report_analysis_recommendation",
    label: "Review recommendation",
    description: "Before your final answer, optionally record once whether this interaction merits later quality review. " +
      "Use high for unresolved problems or uncertain conclusions, medium for a useful improvement opportunity, low for routine resolved work, unknown when unsure. " +
      "Report only observable outcomes, never private reasoning. This is metadata; it does not replace answering the user, and no review is automatically started. " +
      "Do not use during an automated review or for background notifications.",
    parameters: Type.Object({
      analysis_recommendation: Type.Union(levels.map(v => Type.Literal(v))),
      reason_codes: Type.Array(Type.Union(reasons.map(v => Type.Literal(v))), { maxItems: reasons.length, uniqueItems: true }),
      confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      if (signal?.aborted) throw new Error("Review recommendation cancelled");
      const value = input as { analysis_recommendation: typeof levels[number]; reason_codes: string[]; confidence: string };
      // Validate at execution too: direct callers must not bypass bounded metadata.
      if (!levels.includes(value.analysis_recommendation) || !Array.isArray(value.reason_codes) ||
          value.reason_codes.length > reasons.length || new Set(value.reason_codes).size !== value.reason_codes.length ||
          value.reason_codes.some(r => !reasons.includes(r as typeof reasons[number])) ||
          !["high", "medium", "low"].includes(value.confidence)) throw new Error("Invalid review recommendation");
      const turn = refs.turnRef?.current;
      if (turn === undefined) throw new Error("Review recommendation requires an active turn");
      if (reportedTurn === turn) return { content: [{ type: "text", text: "Already recorded for this turn." }], details: { duplicate: true } };
      reportedTurn = turn;
      return {
        content: [{ type: "text", text: "Recommendation recorded. Continue with your final answer." }],
        details: { kind: "analysis_recommendation", analysis_recommendation: value.analysis_recommendation, reason_codes: [...value.reason_codes], confidence: value.confidence },
      };
    },
  };
}
export const registration: ToolEntry = {
  category: "workflow", modes: ["web", "cli", "channel"],
  // Opt-in experiment: no model round or prompt tax on existing deployments.
  available: refs => process.env.SICLAW_REVIEW_RECOMMENDATION === "1" && !refs.isSubagent && !!refs.turnRef,
  create: createReviewRecommendationTool,
};
