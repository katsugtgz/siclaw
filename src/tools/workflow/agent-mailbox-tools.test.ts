import { describe, expect, it, vi } from "vitest";
import { AgentMailbox } from "../../core/agent-mailbox.js";
import type { ToolRefs } from "../../core/tool-registry.js";
import { createWaitAgentTool, createSendParentMessageTool } from "./agent-mailbox-tools.js";
import { createSpawnSubagentTool } from "./spawn-subagent.js";

describe("asynchronous agent tools", () => {
  it("wait returns activity but leaves the report in the mailbox", async () => {
    const mailbox = new AgentMailbox();
    const tool = createWaitAgentTool({ agentMailbox: () => mailbox } as ToolRefs);
    const waiting = tool.execute("wait", { timeout_ms: 1000 });
    mailbox.post("report");
    expect((await waiting).content).toEqual([{ type: "text", text: '{"outcome":"mail","timed_out":false}' }]);
    expect(mailbox.take()).toBe("report");
  });
  it("wait times out without cancelling a child", async () => {
    const mailbox = new AgentMailbox();
    const tool = createWaitAgentTool({ agentMailbox: () => mailbox } as ToolRefs);
    expect((await tool.execute("wait", { timeout_ms: 1 })).details).toEqual({ outcome: "timeout" });
    expect(mailbox.post("later report")).toBe(true);
  });
  it("child send is scoped by its executor and cannot reopen a finished root", async () => {
    const mailbox = new AgentMailbox();
    const tool = createSendParentMessageTool({ sendParentMessage: message => mailbox.post(message) } as ToolRefs);
    await tool.execute("send", { message: "important finding" });
    expect(mailbox.take()).toBe("important finding");
    mailbox.close();
    expect((await tool.execute("send", { message: "late" })).details).toEqual({ queued: false });
    expect(tool.parameters.properties).not.toHaveProperty("interrupt");
  });
  it("single launches are async on a channel even if an old caller supplies false", async () => {
    const execute = vi.fn(async (..._args: any[]) => ({ status: "launched", jobId: "j", childSessionId: "c" }));
    const tool = createSpawnSubagentTool({ agentMailbox: () => new AgentMailbox(), foregroundSubagentOnly: true,
      spawnSubagentExecutor: execute, sessionIdRef: { current: "p" }, taskListId: "p", userId: "u", agentId: "a" } as unknown as ToolRefs);
    await tool.execute("spawn", { description: "inspect", items: ["inspect node"], run_in_background: false });
    expect(execute.mock.calls[0][0].runInBackground).toBe(true);
    expect(tool.parameters.properties).not.toHaveProperty("run_in_background");
    expect(tool.description).toContain("wait_agent");
  });
});
