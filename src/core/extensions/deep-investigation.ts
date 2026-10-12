import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MutableDpStateRef } from "../types.js";

/**
 * Deep Investigation extension — lightweight mode flag.
 *
 * DP is a USER-OWNED MODE: it turns ON when the user sends a message with
 * the `[Deep Investigation]` prefix and OFF only when the user sends `[DP_EXIT]`.
 *
 * While ON, the first marker-bearing message is rewritten to prepend a
 * prompt addendum that nudges the model toward divergent / rigorous
 * reasoning. Subsequent turns rely on conversation history to keep the
 * model in that mindset — no state machine, no per-turn prompt injection,
 * no dedicated tools, no specialized UI cards.
 *
 * All heavy mechanics (propose_hypotheses / deep_search / end_investigation
 * tools, dpStatus state machine, checklist, custom cards, dp_status SSE
 * event, DP_CONFIRM / DP_ADJUST / DP_SKIP / DP_REINVESTIGATE markers) were
 * removed in the Apr 2026 refactor — see
 * docs/design/2026-04-24-dp-mode-refactor-design.md. The current DP baseline
 * is single-agent plus optional `spawn_subagent` batch fan-out (items list) for
 * independent parallel checks (design: 2026-05-29-subagents-background-task-ledger.md;
 * unified single-tool merge: 2026-07-subagent-group.md).
 */

import { DP_ACTIVATION_PROMPT, INVESTIGATION_CHECKPOINT_BLOCK_REASON,
  DP_TOOL_CALLS_BEFORE_CHECKPOINT, stripChipMarker, countToolCallsSinceVisibleAssistant } from "../investigation-mode.js";

export default function deepInvestigationExtension(
  api: ExtensionAPI,
  _memoryRef?: unknown,
  dpStateRef?: MutableDpStateRef,
): void {
  let dpActive = false;
  let toolCallsSinceVisibleAssistant = 0;

  function setActive(next: boolean): void {
    dpActive = next;
    if (dpStateRef) dpStateRef.active = next;
  }

  function persistState(): void {
    api.appendEntry("dp-mode", { active: dpActive });
  }

  function enableDpMode(): void {
    if (dpActive) return;
    setActive(true);
    persistState();
  }

  function disableDpMode(): void {
    if (!dpActive) return;
    setActive(false);
    persistState();
  }

  // --- [Deep Investigation] marker: activate + inject prompt preamble ---
  //
  // First occurrence (dpActive=false): turn on the mode and transform the
  // message to include the activation preamble. Subsequent occurrences
  // while already active: just strip the marker — the model stays in DP
  // via conversation history.

  api.on("input", async (event) => {
    const marker = "[Deep Investigation]\n";
    if (!event.text.startsWith(marker)) return { action: "continue" as const };

    // Also strip any chip marker (Adjust / Skip / Proceed / Dig deeper) that
    // the frontend may have prefixed after the DP marker — those are
    // UI-only hints and must not leak into the prompt.
    const userText = stripChipMarker(event.text.slice(marker.length).trim());
    if (!userText) {
      enableDpMode();
      return { action: "handled" as const };
    }

    if (!dpActive) {
      enableDpMode();
      return {
        action: "transform" as const,
        text: `${DP_ACTIVATION_PROMPT}\n\n---\n\n${userText}`,
      };
    }

    return { action: "transform" as const, text: userText };
  });

  // --- [DP_EXIT] marker: deactivate ---

  api.on("input", async (event) => {
    const hasPrefix = event.text.startsWith("[DP_EXIT]\n");
    const bareMarker = event.text.trim() === "[DP_EXIT]";
    if (!hasPrefix && !bareMarker) return { action: "continue" as const };

    const userText = hasPrefix ? event.text.slice("[DP_EXIT]\n".length).trim() : "";
    disableDpMode();
    return {
      action: "transform" as const,
      text: userText
        ? `The user has exited Deep Investigation mode. ${userText}`
        : "The user has exited Deep Investigation mode.",
    };
  });

  // --- Prefix-chip marker: strip UI-only hint ---
  //
  // Handles non-DP cases like `[Dig deeper]\n...`. (In DP mode the marker is
  // already stripped inside the `[Deep Investigation]` handler above before
  // the activation preamble is prepended — the handler-chain transform would
  // otherwise not see the marker, since it gets buried in the middle.)

  api.on("input", async (event) => {
    const stripped = stripChipMarker(event.text);
    if (stripped === event.text) return { action: "continue" as const };
    return { action: "transform" as const, text: stripped };
  });

  // --- session_start: restore dpActive from persisted entries ---

  api.on("session_start", async (_event, ctx) => {
    setActive(false);
    toolCallsSinceVisibleAssistant = 0;

    // Restore from the latest dp-mode entry. Accepts the new `{active}` shape
    // plus the two legacy shapes (`{enabled}` and `{dpStatus}`) so sessions
    // persisted under the pre-refactor architecture restore correctly.
    const entries = ctx.sessionManager.getEntries();
    const entry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "dp-mode")
      .pop() as { data?: { active?: boolean; enabled?: boolean; dpStatus?: string } } | undefined;

    if (!entry?.data) return;
    if (entry.data.active === true) setActive(true);
    else if (entry.data.enabled === true) setActive(true);
    else if (entry.data.dpStatus && entry.data.dpStatus !== "idle") setActive(true);
  });

  // --- context filter: strip UI-only custom messages ---

  const DP_FILTER_TYPES = new Set(["dp-mode"]);
  api.on("context", async (event) => {
    toolCallsSinceVisibleAssistant = dpActive ? countToolCallsSinceVisibleAssistant(event.messages) : 0;
    return {
      messages: event.messages.filter((m: any) => !DP_FILTER_TYPES.has(m.customType)),
    };
  });

  // --- hypothesis checkpoint barrier ---
  //
  // History-derived, not a DP state machine. After sustained tool use without a
  // visible assistant message, pause and require a Hypothesis Checkpoint before
  // spending more tools. The context hook above resets the counter whenever an
  // assistant text message appears.

  api.on("tool_call", async () => {
    if (!dpActive) return {};
    if (toolCallsSinceVisibleAssistant >= DP_TOOL_CALLS_BEFORE_CHECKPOINT) {
      return {
        block: true,
        reason: INVESTIGATION_CHECKPOINT_BLOCK_REASON,
      };
    }
    return {};
  });
}
