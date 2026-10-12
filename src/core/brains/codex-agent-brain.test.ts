import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentMailbox } from "../agent-mailbox.js";
import { CodexAgentBrain } from "./codex-agent-brain.js";

const model = { id: "test", name: "Test", provider: "test", api: "openai-responses",
  contextWindow: 8_000, maxTokens: 1_000, reasoning: false };

function steerFixture() {
 const brain=Object.create(CodexAgentBrain.prototype) as any;
 const events:any[]=[];
 Object.assign(brain,{threadId:"root",active:{id:"turn",userMessage:{role:"user",content:"initial"}},promptInFlight:true,
  pendingSteers:[],injectedSteers:[],consumedUserItems:new Set(),steeringFlush:false,messages:[],
  client:{request:vi.fn().mockResolvedValue({})},sessionManager:{appendMessage:vi.fn()},
  emit:(event:any)=>events.push(event),watchMailbox:vi.fn(),transformInput:async(text:string,media:any)=>({text,media})});
 const consume=(id:string,text:string,threadId="root",turnId="turn",method="item/started")=>brain.handleEvent({method,params:{threadId,turnId,item:{type:"userMessage",id,content:[{type:"text",text}]}}});
 return {brain,events,consume};
}

describe("native steer consumption receipts",()=>{
 it("correlates batched identical native inputs and suppresses late events after Stop",async()=>{
  const {brain,events,consume}=steerFixture();consume("original","initial");
  await brain.steer("same",undefined,{messageId:"row-a"});await brain.steer("same",undefined,{messageId:"row-b"});
  const params={threadId:"root",turnId:"turn",item:{type:"userMessage",id:"batch",content:[{type:"text",text:"same"},{type:"text",text:"same"}]}};
  brain.handleEvent({method:"item/started",params});brain.handleEvent({method:"item/completed",params});
  expect(events.filter(e=>e.type==="message_start").map(e=>e.inputMessageId)).toEqual(["row-a","row-b"]);
  await brain.steer("late",undefined,{messageId:"row-late"});brain.abortPending=true;consume("late","late");
  expect(events.filter(e=>e.type==="message_start")).toHaveLength(2);
 });
 it("does not claim consumption on acknowledgement and emits once per native item",async()=>{
  const {brain,events,consume}=steerFixture();consume("initial","initial");
  await brain.steer("next",undefined,{messageId:"row-1"});expect(events).toEqual([]);
  consume("item-1","next");consume("item-1","next","root","turn","item/completed");
  expect(events.filter(e=>e.type==="message_start")).toEqual([expect.objectContaining({inputMessageId:"row-1",message:{role:"user",content:[{type:"text",text:"next"}],timestamp:expect.any(Number)}})]);
 });
 it("keeps identical steers distinct and ignores the original, foreign and stale events",async()=>{
  const {brain,events,consume}=steerFixture();
  await brain.steer("initial",undefined,{messageId:"row-a"});await brain.steer("initial",undefined,{messageId:"row-b"});
  consume("original","initial");consume("foreign","initial","other");consume("stale","initial","root","old");
  expect(events).toHaveLength(0);
  consume("a","initial");consume("b","initial");
  expect(events.filter(e=>e.type==="message_start").map(e=>e.inputMessageId)).toEqual(["row-a","row-b"]);
 });
 it("recognizes consumption before a lost acknowledgement without inviting a retry",async()=>{
  const {brain,events,consume}=steerFixture();consume("original","initial");
  brain.client.request=vi.fn(async()=>{consume("a","next");throw new Error("ack lost")});
  await expect(brain.steer("next",undefined,{messageId:"row-a"})).resolves.toBeUndefined();
  expect(events.filter(e=>e.type==="message_start")).toHaveLength(1);
 });
 it("does not retain refused inputs or claim that clearing an accepted steer retracts it",async()=>{
  const {brain,events}=steerFixture();brain.client.request.mockRejectedValueOnce(new Error("turn ended"));
  await expect(brain.steer("refused")).rejects.toThrow("turn ended");expect(brain.injectedSteers).toHaveLength(0);
  await brain.steer("accepted");brain.followUps=[];
  expect(brain.clearQueue()).toEqual({steering:[],followUp:[]});expect(events).toHaveLength(0);
 });
});

describe("CodexAgentBrain compatibility", () => {
  it.each([true,false,undefined])("projects the native memory toggle %s into generation, recall and tools",enabled=>{
    const brain=Object.create(CodexAgentBrain.prototype) as any;
    brain.native={codexMemoryEnabled:enabled,grants:{writeRoots:[],allowCommands:false}};
    brain.currentProviderConfig=()=>({baseUrl:"http://127.0.0.1:2/v1"});
    const config=brain.codexConfig();
    expect(config.features.memories).toBe(enabled!==false);
    expect(config.memories).toMatchObject({use_memories:enabled!==false,generate_memories:enabled!==false,dedicated_tools:enabled!==false});
  });
  it.each([undefined, "disabled", "enabled", "cached", "live"])("projects search mode %s independently of shell/network grants", mode => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    brain.native = { webSearchMode: mode, grants: { writeRoots: [], allowCommands: false } };
    brain.currentProviderConfig = () => ({ baseUrl: "http://127.0.0.1:2/v1" });
    expect(brain.codexConfig().web_search).toBe(mode==="enabled"?undefined:mode??"disabled");
    if(mode==="enabled")expect(Object.hasOwn(brain.codexConfig(),"web_search")).toBe(false);
    expect(brain.codexConfig().model_providers.siclaw_model.supports_standalone_web_search).toBe(Boolean(mode && mode !== "disabled"));
    expect(brain.codexConfig().features.shell_tool).toBe(false);
    expect(brain.codexConfig().features.browser_use).toBe(false);
  });
  it("projects native search metadata through redaction into both live events and history", () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    const events: any[] = [], history: any[] = [];
    brain.threadId = "root"; brain.active = { toolNames: new Set() }; brain.toolItems = new Map();
    brain.listeners = new Set([(e: any) => events.push(e)]); brain.appendCache = (m: any) => history.push(m);
    brain.native = { grants: { redactOutput: (s: string) => s.replaceAll("canary-secret", "[REDACTED]") } };
    const item = { id: "search-1", type: "webSearch", query: "kubernetes canary-secret", action: { type: "search", query: "canary-secret" } };
    brain.handleEvent({ method: "item/started", params: { threadId: "root", item } });
    brain.handleEvent({ method: "item/completed", params: { threadId: "root", item: { ...item, status: "completed" } } });
    expect(events.filter(e => e.type.startsWith("tool_execution_"))).toHaveLength(2);
    expect(events.at(-1).toolName).toBe("web_search");
    expect(JSON.stringify([events, history])).not.toContain("canary-secret");
    expect(history.at(-1).toolName).toBe("web_search");
  });
  it("ends unfinished search activity as an error when the native turn fails", () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    const events: any[] = [], history: any[] = [];
    brain.threadId = "root"; brain.active = { id: "turn", reject: vi.fn(), resolve: vi.fn() };
    brain.toolItems = new Map([["search-1", { name: "web_search", args: {} }]]);
    brain.listeners = new Set([(e: any) => events.push(e)]); brain.appendCache = (m: any) => history.push(m);
    brain.native = { grants: { redactOutput: (s: string) => s } }; brain.persistThread = vi.fn();
    brain.handleEvent({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "failed", error: { message: "Search endpoint unavailable" } } } });
    expect(events.find(e => e.type === "tool_execution_end")).toMatchObject({ toolName: "web_search", isError: true });
    expect(brain.toolItems.size).toBe(0); expect(history[0].isError).toBe(true);
  });
  it.each([true, false])("Stop cancels owned executor handles, not only model waiting (active turn: %s)", async active => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    const order: string[] = [];
    const executor = { cancelProcesses: vi.fn(() => order.push("executor")) };
    const cluster = { cancelProcesses: vi.fn(() => order.push("cluster")) };
    brain.executor = executor; brain.clusterExecutors = new Map([["cluster:test", cluster]]);
    brain.pendingSteers = []; brain.followUps = []; brain.promptInFlight = true;
    brain.requestScopes = new Set([{ cancel: vi.fn(async () => { order.push("child"); }) }]);
    brain.threadId = "owned-root";
    brain.active = active ? { id: "active-turn" } : undefined;
    brain.client = { request: vi.fn(async () => { order.push("interrupt"); }) };
    await brain.abort();
    expect(executor.cancelProcesses).toHaveBeenCalledOnce();
    expect(cluster.cancelProcesses).toHaveBeenCalledOnce();
    expect(order.slice(0, 2)).toEqual(["executor", "cluster"]);
    expect(brain.abortPending).toBe(true);
  });
  it("resumes by native thread id without an unsupported rollout path parameter", async () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    const request=vi.fn().mockResolvedValue({thread:{id:"saved-thread",path:"/native/history"}});
    brain.ensureClient=async()=>({request});brain.threadId="saved-thread";brain.rolloutPath="/prior/history";
    brain.codexConfig=()=>({});brain.cwd="/workspace";brain.systemPrompt="scoped";
    brain.persistThread=vi.fn();
    await brain.ensureThread();
    expect(request.mock.calls[0]).toEqual(["thread/resume",{threadId:"saved-thread",model:undefined,modelProvider:"siclaw_model",config:{},cwd:"/workspace",sandbox:"read-only",approvalPolicy:"never",developerInstructions:"scoped"}]);
    expect(brain.persistThread).toHaveBeenCalledOnce();
  });
  it("keeps an error-only native MCP reason in events and persisted tool results", () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    const events: any[] = [], messages: any[] = [];
    brain.threadId = "root"; brain.active = { toolNames: new Set() };
    brain.toolItems = new Map(); brain.toolsetsByName = new Map(); brain.listeners = new Set([(event: any) => events.push(event)]);
    brain.appendCache = (message: any) => messages.push(message);
    brain.native = { grants: { redactOutput: (text: string) => text.replaceAll("private-secret", "[REDACTED]") } };
    brain.handleEvent({ method: "item/started", params: { threadId: "root", item: { id: "call", type: "mcpToolCall", tool: "read", arguments: {} } } });
    brain.handleEvent({ method: "item/completed", params: { threadId: "root", item: { id: "call", type: "mcpToolCall", status: "failed", error: { message: "Safe failure private-secret" } } } });
    expect(events.find(event => event.type === "tool_execution_end").result.content[0].text).toBe("Safe failure [REDACTED]");
    expect(messages.find(message => message.role === "toolResult").content[0].text).toBe("Safe failure [REDACTED]");
  });
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
        { getSessionDir: () => dir, getSessionId: () => "test-session", getEntries: () => [], getBranch: () => [] },
        { grants: { readRoots: [], writeRoots: [], deniedRoots: [], allowCommands: false, production: false } }, "", new Map(), dir, [],
      ) as any;
      const record = vi.fn();
      brain.registerProvider("test", { baseUrl: "https://example.test/v1", apiKey: "redacted",
        usageIdentity: { configId: "cfg-1", name: "Test provider", sourceKind: "api",
          sourceId: "source-1", sourceName: "Test source" },
        models: [{ id: "test", cost: { input: 1, output: 2, cacheRead: 0.5 } }] });
      await brain.setModel(model);
      brain.threadId = "thread-usage";
      brain.active = { id: "live-turn", started: true };
      brain.llmCalls.setUsageSink({ context: () => ({ sessionId: "session-1", executionRole: "root" }), record });
      const event = { method: "thread/tokenUsage/updated", params: { threadId: "thread-usage", turnId: "live-turn",
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

  it("does not bill a restored historical token snapshot as another model call", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-codex-restored-usage-"));
    try {
      const brain = new (CodexAgentBrain as any)(
        { getSessionDir: () => dir, getSessionId: () => "test-session", getEntries: () => [], getBranch: () => [] },
        { grants: { readRoots: [], writeRoots: [], deniedRoots: [], allowCommands: false, production: false } },
        "", new Map(), dir, [],
      ) as any;
      const record = vi.fn();
      brain.registerProvider("test", { baseUrl: "https://example.test/v1", apiKey: "fixture", models: [{ id: "test" }] });
      await brain.setModel(model);
      brain.threadId = "restored-thread";
      brain.llmCalls.setUsageSink({ context: () => ({ sessionId: "session-1", executionRole: "root" }), record });
      const snapshot = (turnId: string, total: number) => ({ method: "thread/tokenUsage/updated", params: {
        threadId: "restored-thread", turnId, tokenUsage: {
          total: { totalTokens: total }, last: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        },
      } });
      brain.handleEvent(snapshot("old-turn", 100));
      expect(record).not.toHaveBeenCalled();
      brain.active = { id: "new-turn", started: true };
      brain.handleEvent(snapshot("old-turn", 100));
      brain.handleEvent(snapshot("new-turn", 100));
      expect(record).not.toHaveBeenCalled();
      brain.handleEvent(snapshot("new-turn", 115));
      brain.handleEvent(snapshot("new-turn", 115));
      expect(record).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends original user images to native input without echoing bytes into public history", async () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    Object.assign(brain, { requestScopes: new Set(), rootTurnOwners: new Map(), childTurnOwners: new Map(),
      closed: false, model, followUps: [], pendingSteers: [], listeners: new Set(),
      executor: { resumeProcesses: vi.fn() }, clusterExecutors: new Map() });
    brain.transformInput = vi.fn().mockResolvedValue({ text: "Inspect the image", media: { images: [{ mimeType: "image/png", data: "aGVsbG8=" }] } });
    brain.ensureThread = vi.fn().mockResolvedValue(undefined);
    brain.runTurn = vi.fn().mockImplementation(async () => { brain.lastTurnHadContent = true; brain.lastToolNames = new Set(); });
    await brain.prompt("Inspect the image");
    const [input, publicMessage] = brain.runTurn.mock.calls[0];
    expect(input).toContainEqual({ type: "image", url: "data:image/png;base64,aGVsbG8=" });
    expect(publicMessage.content).toBe("Inspect the image");
    expect(JSON.stringify(publicMessage)).not.toContain("aGVsbG8=");
    expect(brain.executor.resumeProcesses).toHaveBeenCalledOnce();
  });

  it("retries an empty completed turn with Pi-compatible retry events", async () => {
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    brain.requestScopes = new Set(); brain.rootTurnOwners = new Map(); brain.childTurnOwners = new Map();
    brain.executor = { resumeProcesses: vi.fn() }; brain.clusterExecutors = new Map();
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
