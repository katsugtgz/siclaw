import { describe, expect, it } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Api } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AgentMailbox } from "./agent-mailbox.js";
import { installMailboxLoop } from "./mailbox-loop.js";
import { createWaitAgentTool } from "../tools/workflow/agent-mailbox-tools.js";
import type { ToolRefs } from "./tool-registry.js";

const model = { id: "test", name: "test", api: "openai-responses", provider: "test", contextWindow: 10000, maxTokens: 1000 } as Model<Api>;
function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
}
const text = (value: string, phase?: string) => ({ type: "text" as const, text: value,
  ...(phase ? { textSignature: JSON.stringify({ v: 1, id: value, phase }) } : {}) });

function fixture(respond: (request: number, stream: ReturnType<typeof createAssistantMessageEventStream>, signal?: AbortSignal) => void) {
  const mailbox = new AgentMailbox();
  const requests: any[] = [];
  const agent = new Agent({ initialState: { model }, convertToLlm: async messages => messages as any,
    streamFn: () => createAssistantMessageEventStream() });
  agent.streamFunction = (_model, context, options) => {
    requests.push(structuredClone(context.messages));
    const stream = createAssistantMessageEventStream();
    respond(requests.length, stream, options?.signal);
    return stream;
  };
  const release = installMailboxLoop({ agent } as AgentSession, mailbox);
  return { mailbox, agent, requests, release };
}

describe("mailbox with the real pi agent loop", () => {
  it("user steering reopens delivery and a stale final boundary does not close it again", async () => {
    const f = fixture((n, stream) => {
      if (n === 1) {
        f.mailbox.defer();
        f.mailbox.post("child update");
        f.agent.steer({ role: "user", content: "also check B", timestamp: Date.now() });
        f.mailbox.steer();
      }
      stream.push({ type: "done", reason: "stop", message: message([text(n === 1 ? "old final" : "updated final")]) });
    });
    await f.agent.prompt("inspect");
    expect(f.requests.length).toBeGreaterThan(1);
    expect(JSON.stringify(f.requests.slice(1))).toContain("child update");
    expect(JSON.stringify(f.requests.slice(1))).toContain("also check B");
    f.release();
  });
  it("preempts at a completed thinking block, not at a thinking delta", async () => {
    const f = fixture((n, stream) => {
      if (n === 1) {
        f.mailbox.post("new finding");
        const partial = message([{ type: "thinking", thinking: "reason", thinkingSignature: "signed" }]);
        stream.push({ type: "start", partial });
        stream.push({ type: "thinking_delta", contentIndex: 0, delta: "reason", partial });
        stream.push({ type: "thinking_end", contentIndex: 0, content: "reason", partial });
        stream.push({ type: "done", reason: "stop", message: message([text("stale")]) });
      } else stream.push({ type: "done", reason: "stop", message: message([text("updated")]) });
    });
    await f.agent.prompt("inspect");
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).toContain("new finding");
    expect(JSON.stringify(f.requests[1])).toContain("signed");
    f.release();
  });
  it("wait wakes on child mail and resumes the same agent run with the body", async () => {
    const f = fixture((n, stream) => {
      stream.push({ type: "done", reason: n === 1 ? "toolUse" : "stop", message: n === 1
        ? message([{ type: "toolCall", id: "wait", name: "wait_agent", arguments: { timeout_ms: 1000 } }], "toolUse")
        : message([text("used the child report")]) });
    });
    const waitTool = createWaitAgentTool({ agentMailbox: () => f.mailbox } as ToolRefs);
    f.agent.state.tools = [{ ...waitTool, execute: async (...args) => {
      const wait = waitTool.execute(...args);
      f.mailbox.post("complete child report");
      return wait;
    } }];
    await f.agent.prompt("delegate");
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).toContain("complete child report");
    expect(JSON.stringify(f.requests[1])).toContain('timed_out');
    f.release();
  });
  it("does not discard an emitted tool call at a later thinking boundary", async () => {
    let calls = 0;
    const f = fixture((n, stream) => {
      if (n === 1) {
        f.mailbox.post("child update");
        const partial = message([{ type: "toolCall", id: "check", name: "check", arguments: {} },
          { type: "thinking", thinking: "continue" }], "toolUse");
        stream.push({ type: "start", partial });
        stream.push({ type: "thinking_end", contentIndex: 1, content: "continue", partial });
        stream.push({ type: "done", reason: "toolUse", message: partial });
      } else stream.push({ type: "done", reason: "stop", message: message([text("complete")]) });
    });
    f.agent.state.tools = [{ name: "check", label: "Check", description: "check", parameters: Type.Object({}),
      execute: async () => { calls++; return { content: [{ type: "text", text: "checked" }], details: {} }; } }];
    await f.agent.prompt("inspect");
    expect(calls).toBe(1);
    expect(JSON.stringify(f.requests[1])).toContain("checked");
    expect(JSON.stringify(f.requests[1])).toContain("child update");
    f.release();
  });
  it("cuts sampling after commentary and gives mail to the next request, without aborting the run", async () => {
    let providerSignal: AbortSignal | undefined;
    const f = fixture((n, stream, signal) => {
      if (n === 1) {
        providerSignal = signal;
        f.mailbox.post("child evidence");
        const partial = message([text("checking", "commentary")]);
        stream.push({ type: "start", partial });
        stream.push({ type: "text_end", contentIndex: 0, content: "checking", partial });
        // A provider may mutate a shared partial after enqueueing an item event.
        partial.content.push(text("unobserved later block", "final_answer"));
        // Stale subsequent output must never reach the parent transcript.
        stream.push({ type: "done", reason: "stop", message: message([text("stale answer")]) });
      } else stream.push({ type: "done", reason: "stop", message: message([text("answer with child evidence")]) });
    });
    await f.agent.prompt("investigate");
    expect(providerSignal?.aborted).toBe(true);
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).toContain("child evidence");
    expect(JSON.stringify(f.agent.state.messages)).not.toContain("stale answer");
    expect(JSON.stringify(f.agent.state.messages)).not.toContain("unobserved later block");
    expect(f.agent.state.messages.some(m => m.role === "assistant" && m.stopReason === "aborted")).toBe(false);
    f.release();
  });
  it.each([undefined, "final_answer"])("does not continue after a %s-phase answer for mail", async phase => {
    const f = fixture((_n, stream) => {
      f.mailbox.post("late result");
      const partial = message([text("final answer", phase)]);
      stream.push({ type: "start", partial });
      stream.push({ type: "text_end", contentIndex: 0, content: "final answer", partial });
      stream.push({ type: "done", reason: "stop", message: partial });
    });
    await f.agent.prompt("investigate");
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(f.agent.state.messages)).not.toContain("late result");
    f.mailbox.close(); f.release();
  });
  it("a tool reopens delivery and results reach the next request without cancelling the tool", async () => {
    let calls = 0;
    const f = fixture((n, stream) => {
      stream.push({ type: "done", reason: n === 1 ? "toolUse" : "stop", message: n === 1
        ? message([{ type: "toolCall", id: "call-1", name: "check", arguments: {} }], "toolUse")
        : message([text("combined answer")]) });
    });
    f.agent.state.tools = [{ name: "check", label: "Check", description: "check", parameters: Type.Object({}), execute: async () => {
      calls++; f.mailbox.post("tool-time child result");
      return { content: [{ type: "text", text: "checked" }], details: {} };
    } }];
    f.mailbox.defer();
    await f.agent.prompt("check");
    expect(calls).toBe(1);
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).toContain("tool-time child result");
    expect(JSON.stringify(f.requests[1])).toContain("checked");
    f.release();
  });
});
