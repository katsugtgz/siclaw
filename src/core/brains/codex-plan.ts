import { getOrCreateLedger } from "../task-ledger.js";
import type { SessionEventEmitter } from "../tool-registry.js";

/** Codex owns the checklist. The Siclaw ledger is only a projection for the
 * existing session event stream and Portal plan panel. */
export function projectCodexPlan(
  taskListId: string,
  emit: SessionEventEmitter,
  value: unknown,
): void {
  if (!Array.isArray(value)) return;
  const plan: Array<{ step: string; status: "pending" | "in_progress" | "completed" }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return;
    const { step, status } = item as Record<string, unknown>;
    if (typeof step !== "string" || !step.trim() ||
        (status !== "pending" && status !== "inProgress" && status !== "completed")) return;
    plan.push({ step: step.trim(), status: status === "inProgress" ? "in_progress" : status });
  }

  const ledger = getOrCreateLedger(taskListId);
  ledger.clear();
  emit({ kind: "task_event", taskListId, action: "reset" });
  for (const item of plan) {
    const task = ledger.create({ subject: item.step, description: "" });
    ledger.update(task.id, { status: item.status });
    emit({ kind: "task_event", taskListId, action: "upsert", task: { ...task } });
  }
}
