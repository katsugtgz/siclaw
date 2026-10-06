import { describe, expect, it, vi } from "vitest";
const manageSchedule = vi.hoisted(() => vi.fn().mockResolvedValue({ content: [{ type: "text", text: "created" }], details: {} }));
vi.mock("../schedule-service.js", () => ({ manageSchedule }));
import { CodexWorkflow } from "./codex-workflow.js";

describe("native product operations", () => {
  const make = () => new CodexWorkflow({ schedule: true, report: true, sessionId: () => "owner-session",
    active: () => ({ threadId: "root", turnId: "turn" }) });
  const start = (service: CodexWorkflow, id: string, tool: string, threadId = "root") => service.observe({ method: "item/started",
    params: { threadId, turnId: "turn", item: { id, tool, server: "siclaw_workflow", type: "mcpToolCall" } } });
  it("passes only the trusted session identity to the shared schedule service", async () => {
    const service = make(); start(service, "call", "manage_schedule");
    await service.call({ action: "create", name: "test", schedule: "0 9 * * *" }, "call", new AbortController().signal, "manage_schedule");
    expect(manageSchedule).toHaveBeenLastCalledWith({ action: "create", name: "test", schedule: "0 9 * * *" }, "owner-session");
    start(service, "bad", "manage_schedule");
    await expect(service.call({ action: "list", session_id: "attacker" }, "bad", new AbortController().signal, "manage_schedule")).rejects.toThrow("Invalid schedule");
  });
  it("rejects unowned child calls, replayed calls and unsupported capabilities", async () => {
    const service = make(); start(service, "foreign", "manage_schedule", "child");
    await expect(service.call({ action: "list" }, "foreign", AbortSignal.timeout(5), "manage_schedule")).rejects.toThrow();
    start(service, "call", "task_report"); service.observe({ method: "item/completed", params: { threadId: "root", turnId: "turn", item: { id: "call" } } });
    await expect(service.call({ summary: "old" }, "call", AbortSignal.timeout(5), "task_report")).rejects.toThrow();
    expect(new CodexWorkflow({ schedule: false, report: false, sessionId: () => "", active: () => undefined }).tools).toEqual([]);
  });
  it("returns a final report through both native structured and existing text contracts", async () => {
    const service = make(); start(service, "report", "task_report");
    expect(await service.call({ summary: "# Findings\nRead-only checks passed." }, "report", new AbortController().signal, "task_report"))
      .toMatchObject({ content: [{ type: "text", text: "# Findings\nRead-only checks passed." }], structuredContent: { summary: expect.stringContaining("Findings") } });
  });
});
