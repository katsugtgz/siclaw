import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentMailbox } from "../agent-mailbox.js";
import { CodexAgentBrain } from "./codex-agent-brain.js";

const model = { id: "test", name: "Test", provider: "test", api: "openai-responses",
  contextWindow: 8_000, maxTokens: 1_000, reasoning: false };

describe("CodexAgentBrain compatibility", () => {
  it("enables native update_plan and forwards its app-server notification", () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    const onPlanUpdate = vi.fn();
    brain.threadId = "thread-1";
    brain.nativePlanEnabled = true;
    brain.onPlanUpdate = onPlanUpdate;
    brain.currentProviderConfig = () => ({ baseUrl: "http://127.0.0.1:2/v1" });
    expect(brain.codexConfig().tools.update_plan.enabled).toBe(true);
    expect(brain.codexConfig().features.memories).toBe(true);
    expect(brain.codexConfig().memories).toMatchObject({use_memories:true,dedicated_tools:true});
    brain.handleEvent({ method: "turn/plan/updated", params: { threadId: "other",
      plan: [{ step: "ignored", status: "pending" }] } });
    brain.handleEvent({ method: "turn/plan/updated", params: { threadId: "thread-1",
      plan: [{ step: "verify", status: "inProgress" }] } });
    expect(onPlanUpdate).toHaveBeenCalledExactlyOnceWith([{ step: "verify", status: "inProgress" }]);
  });

  it("does not reject a long session based on lifetime token usage", () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    brain.totalUsage = { input: 80_000, output: 20_000, cacheRead: 0, cacheWrite: 0, total: 100_000 };
    brain.contextTokens = 2_000;
    expect(brain.checkContextFitForModelPrompt(model, "a short question").ok).toBe(true);
    expect(brain.checkContextFitForModelPrompt(model, "x".repeat(24_000)).ok).toBe(false);
  });

  it("steers active-turn background evidence and saves a hidden mailbox message", async () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    const request = vi.fn().mockResolvedValue({});
    const appendMessage = vi.fn();
    brain.client = { request };
    brain.threadId = "thread-1";
    brain.active = { id: "turn-1" };
    brain.messages = [];
    brain.sessionManager = { appendMessage };
    const mailbox = new AgentMailbox();
    brain.setMailbox(mailbox);
    mailbox.post("child found the cause");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1", expectedTurnId: "turn-1",
      input: [{ type: "text", text: "[Siclaw background task result]\nchild found the cause" }],
    }));
    await vi.waitFor(() => expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: "custom", customType: "agent_mailbox", content: "child found the cause", display: false,
    })));
    brain.setMailbox(undefined);
    mailbox.close();
  });

  it("defers evidence after a final answer and reopens it when a tool starts", async () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    const request = vi.fn().mockResolvedValue({});
    brain.client = { request };
    brain.threadId = "thread-1";
    brain.active = { id: "turn-1" };
    brain.messages = [];
    brain.listeners = new Set();
    brain.toolsetsByName = new Map();
    brain.toolItems = new Map();
    brain.sessionManager = { appendMessage: vi.fn() };
    const mailbox = new AgentMailbox();
    mailbox.defer();
    brain.setMailbox(mailbox);
    mailbox.post("late finding");
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    brain.handleEvent({ method: "item/started", params: { threadId: "thread-1",
      item: { type: "mcpToolCall", server: "siclaw", id: "call-1", tool: "inspect", arguments: {} } } });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    brain.setMailbox(undefined);
    mailbox.close();
  });

  it("keeps steering sent while Codex is still starting its turn", async () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    const request = vi.fn().mockResolvedValue({});
    const appendMessage = vi.fn();
    brain.client = { request };
    brain.threadId = "thread-1";
    brain.promptInFlight = true;
    brain.pendingSteers = [];
    brain.steeringFlush = false;
    brain.messages = [];
    brain.sessionManager = { appendMessage };
    const accepted = brain.steer("add this evidence");
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    brain.active = { id: "turn-1" };
    await brain.flushSteers();
    await accepted;
    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1", expectedTurnId: "turn-1",
      input: [{ type: "text", text: "add this evidence" }],
    });
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({ role: "user", content: "add this evidence" }));
  });

  it("persists native Codex token usage once per model call", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-codex-usage-"));
    try {
      const brain = new (CodexAgentBrain as any)(
        { getSessionDir: () => dir, getEntries: () => [] },
        { grants: { readRoots: [], writeRoots: [], deniedRoots: [], allowCommands: false, production: false } }, "", new Map(), dir, [],
      ) as any;
      const record = vi.fn();
      brain.registerProvider("test", { baseUrl: "https://example.test/v1", apiKey: "redacted",
        usageIdentity: { configId: "cfg-1", name: "Test provider", sourceKind: "api",
          sourceId: "source-1", sourceName: "Test source" },
        models: [{ id: "test", cost: { input: 1, output: 2, cacheRead: 0.5 } }] });
      await brain.setModel(model);
      brain.threadId = "thread-usage";
      brain.llmCalls.setUsageSink({ context: () => ({ sessionId: "session-1", executionRole: "root" }), record });
      const event = { method: "thread/tokenUsage/updated", params: { threadId: "thread-usage",
        tokenUsage: { total: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2, totalTokens: 15 },
          last: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2, totalTokens: 15 },
          modelContextWindow: 8_000 } } };
      brain.handleEvent(event);
      brain.handleEvent(event);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "session-1", phase: "finished",
        model: expect.objectContaining({ configId: "cfg-1", requestedId: "test" }),
        usageEvidence: expect.objectContaining({ rawUsage: {
          input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 2 },
        } }),
      }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries an empty completed turn with Pi-compatible retry events", async () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    const events: any[] = [];
    brain.closed = false;
    brain.model = model;
    brain.followUps = [];
    brain.pendingSteers = [];
    brain.listeners = new Set([(event: any) => events.push(event)]);
    brain.transformInput = vi.fn().mockResolvedValue({ text: "Hi", media: undefined });
    brain.ensureThread = vi.fn().mockResolvedValue(undefined);
    brain.sleepRetry = vi.fn().mockResolvedValue(undefined);
    brain.runTurn = vi.fn().mockImplementation(async () => {
      brain.lastTurnHadContent = brain.runTurn.mock.calls.length > 1;
    });
    await brain.prompt("Hi");
    expect(brain.runTurn).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual(["auto_retry_start", "auto_retry_end"]);
    expect(events[1].success).toBe(true);
  });

  it("keeps Codex commentary distinct from the final answer", () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    const events: any[] = [];
    brain.threadId = "thread-1";
    brain.model = model;
    brain.listeners = new Set([(event: any) => events.push(event)]);
    brain.assistantTexts = new Map();
    brain.messages = [];
    brain.sessionManager = { appendMessage: vi.fn() };
    brain.mailbox = new AgentMailbox();
    for (const [id, phase] of [["comment", "commentary"], ["final", "final_answer"]]) {
      brain.handleEvent({ method: "item/started", params: { threadId: "thread-1",
        item: { type: "agentMessage", id, phase } } });
      brain.handleEvent({ method: "item/completed", params: { threadId: "thread-1",
        item: { type: "agentMessage", id, phase, text: id } } });
    }
    const messages = events.filter((event) => event.type === "message_end").map((event) => event.message);
    expect(JSON.parse(messages[0].content[0].textSignature).phase).toBe("commentary");
    expect(JSON.parse(messages[1].content[0].textSignature).phase).toBe("final_answer");
  });
});
