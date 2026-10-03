import { afterEach, describe, expect, it } from "vitest";
import { getOrCreateLedger, resetLedgers } from "../task-ledger.js";
import { projectCodexPlan } from "./codex-plan.js";

afterEach(resetLedgers);

describe("Codex native plan projection", () => {
  it("replaces the visible plan and ledger with each complete native snapshot", () => {
    const events: Record<string, unknown>[] = [];
    const emit = (event: Record<string, unknown>) => events.push(event);
    const ledger = getOrCreateLedger("session-1");
    ledger.create({ subject: "old Pi task", description: "" });

    projectCodexPlan("session-1", emit, [
      { step: "Inspect logs", status: "completed" },
      { step: "Verify cause", status: "inProgress" },
    ]);
    expect(ledger.snapshot().map(({ subject, status }) => ({ subject, status }))).toEqual([
      { subject: "Inspect logs", status: "completed" },
      { subject: "Verify cause", status: "in_progress" },
    ]);
    expect(events.map((event) => event.action)).toEqual(["reset", "upsert", "upsert"]);
    expect(events[1]).toMatchObject({ kind: "task_event", taskListId: "session-1",
      task: { subject: "Inspect logs", status: "completed" } });

    projectCodexPlan("session-1", emit, [{ step: "Finish report", status: "pending" }]);
    expect(ledger.snapshot().map((task) => task.subject)).toEqual(["Finish report"]);
    expect(events.slice(3).map((event) => event.action)).toEqual(["reset", "upsert"]);
  });

  it("ignores malformed notifications without destroying the previous plan", () => {
    const events: Record<string, unknown>[] = [];
    const ledger = getOrCreateLedger("session-2");
    ledger.create({ subject: "keep", description: "" });
    projectCodexPlan("session-2", (event) => events.push(event), [
      { step: "valid", status: "pending" }, { step: "invalid", status: "unknown" },
    ]);
    expect(ledger.snapshot().map((task) => task.subject)).toEqual(["keep"]);
    expect(events).toEqual([]);
  });
});
