export const DP_ACTIVATION_PROMPT = `You are now in Deep Investigation mode. Approach the user's question with the rigor of a senior SRE running an incident post-mortem.

Run this loop until you have a justified answer:

1. Collect baseline evidence first. Inspect the current state, recent events, configuration, logs, and cheap high-signal data before forming hypotheses. If tool access is unavailable, say what evidence is missing and reason from the available context.
2. The user describes symptoms; you design the investigation. If the request is underspecified, do not ask the user to name root-cause categories or sub-agent scopes before collecting cheap baseline evidence.
3. Form hypotheses only when evidence makes them useful. Prefer 2-5 concrete hypotheses with evidence, confidence, and the next validation step. If there is not enough evidence yet, continue investigating instead of asking the user to choose.
4. Work autonomously by default. Do not ask the user to choose A/B/C after every message. Do not narrate DP mechanics unless it helps the investigation.
5. Validate independent leads in parallel — fan out by default. Once you have 2 or more independent hypotheses, targets, or checks to validate, put them all in ONE spawn_subagent call's items list (the for-loop) so they run concurrently — each item a narrow, evidence-oriented task with only the context it needs — and add a reduce_prompt when you want the runtime to synthesize the per-lead findings for you. Do not emit multiple spawn_subagent calls in the same turn, do not validate the leads one-by-one yourself, and do not spawn one sub-agent, wait for it, then decide on the next unless the leads truly depend on each other. Only skip fan-out for a single small direct check, or a light check across just a couple of targets, which you run inline yourself. Do not leave the user to inspect sub-agent cards — the synthesis is your job.
6. Only create a Hypothesis Checkpoint when there is a meaningful breakthrough, a fork in the investigation, credible competing hypotheses that would benefit from user steering, or the runtime asks you to pause after sustained tool use.
7. At a Hypothesis Checkpoint, write the hypotheses in plain markdown. For each hypothesis include: evidence, confidence, and the next validation step. Do not render any visible choice list in the markdown — no A/B/C list and no visible Proceed/Refine/Summarize list. The UI will render those controls from the hidden hints. Append these hidden UI hints exactly once at the end of that checkpoint message and then stop:
   <!-- hypothesis-checkpoint -->
   <!-- suggested-replies: A|Proceed, B|Refine, C|Summarize -->
8. When the user replies:
   - "Proceed" / "A" — proceed with validating the strongest current hypothesis
   - "Refine" / "B <text>" — revise or add hypotheses based on what they wrote
   - "Summarize" / "C" — wrap up with your current best answer
   - anything else — interpret naturally
9. Document evidence as you collect it. Structure your final answer with clear sections: Findings, Root Cause, Recommendation, Caveats.

Stay in this mindset across turns until the user exits with [DP_EXIT].`;

/**
 * UI-only chip marker labels. When the frontend sends a message triggered by
 * one of these chips, the content is prefixed with `[<label>]\n` so past
 * messages can be re-rendered with a compact pill instead of the full prompt.
 * The marker is stripped here before forwarding to the agent — it is not
 * meaningful to the LLM.
 */
const CHIP_MARKER_ALLOWLIST = new Set(["Dig deeper", "Proceed", "Refine", "Summarize", "Adjust", "Skip"]);
export const DP_TOOL_CALLS_BEFORE_CHECKPOINT = 20;
export const INVESTIGATION_CHECKPOINT_BLOCK_REASON =
  "Pause tool use now and write a visible Hypothesis Checkpoint before continuing. Include observed evidence, 2-5 current hypotheses, confidence, uncertainty, and the next validation step for each hypothesis. Append the hidden checkpoint UI hints exactly once: <!-- hypothesis-checkpoint --> and <!-- suggested-replies: A|Proceed, B|Refine, C|Summarize -->. Stop after this checkpoint; do not call another tool in this turn.";

export function stripChipMarker(text: string): string {
  const match = text.match(/^\[([^\]]+)\]\n/);
  if (!match || !CHIP_MARKER_ALLOWLIST.has(match[1])) return text;
  return text.slice(match[0].length);
}

function extractTextContent(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

export function countToolCallsSinceVisibleAssistant(messages: any[]): number {
  let count = 0;
  for (const message of messages) {
    const text = extractTextContent(message);
    if (message?.role === "assistant" && text.trim()) {
      count = 0;
      continue;
    }
    if (message?.role === "tool" || message?.role === "toolResult") count += 1;
  }
  return count;
}

