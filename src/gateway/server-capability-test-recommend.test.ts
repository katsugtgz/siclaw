import { afterEach, describe, expect, it, vi } from "vitest";

const posts = vi.hoisted(() => [] as Array<{ path: string; body: unknown; timeoutMs?: number }>);

vi.mock("./chat-repo.js", () => ({
  validTraceId: (v: unknown) => (typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? v : undefined),
  warnTraceBindFailure: vi.fn(),
  ensureChatSession: vi.fn(async () => {}),
  appendMessage: vi.fn(async () => "msg-id"),
  bindMessageTraceId: vi.fn(async () => {}),
  updateMessage: vi.fn(async () => {}),
  incrementMessageCount: vi.fn(async () => {}),
}));
vi.mock("./output-redactor.js", () => ({ buildRedactionConfigForModelConfig: vi.fn(() => ({})) }));
vi.mock("./sse-consumer.js", () => ({
  consumeAgentSse: vi.fn(async () => ({ resultText: "", taskReportText: "", errorMessage: "", eventCount: 0, durationMs: 0 })),
}));
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    async postJson(path: string, body: unknown, timeoutMs?: number) {
      posts.push({ path, body, timeoutMs });
      if (path.startsWith("/test-session/")) {
        return { test_session_id: "test-1", snapshot_hash: "snapshot", consumer_fingerprint: "fingerprint", pages: 1 };
      }
      if (path.startsWith("/test-recommendation/")) {
        return {
          ok: true,
          question: "What is the retry limit?",
          reference_answer: "Three attempts.",
          evidence_paths: ["raw/policy.md"],
        };
      }
      if (path.startsWith("/test-reference-assist/")) {
        if ((body as { mode?: string }).mode === "polish") {
          return {
            ok: true,
            mode: "polish",
            polished_answer: "Retry no more than three times.",
            evidence_paths: ["raw/policy.md"],
            warnings: ["The draft overstated the retry limit."],
          };
        }
        return {
          ok: true,
          mode: "suggest",
          candidates: [
            { style: "concise", answer: "Three attempts.", evidence_paths: ["raw/policy.md"] },
            { style: "complete", answer: "Retry at most three times.", evidence_paths: ["raw/policy.md"] },
          ],
        };
      }
      return { ok: true };
    }
    async getJson() { return {}; }
    async *streamPath() { await new Promise(() => {}); }
  },
}));
vi.mock("./capability/materialize.js", () => ({
  materializeCapabilityInputs: vi.fn(async () => ({ locale: "en", llm: undefined, settings: undefined })),
}));

const { startRuntime } = await import("./server.js");

function fakeFrontendClient() {
  return {
    request: vi.fn(async () => ({})), onCommand: vi.fn(), emitEvent: vi.fn(), close: vi.fn(),
  } as any;
}

function fakeAgentBoxManager() {
  return {
    setCertManager: vi.fn(), setSpawnEnvResolver: vi.fn(), setPersistenceResolver: vi.fn(),
    getAsync: vi.fn(async () => null),
    getOrCreate: vi.fn(async (runId: string) => ({ boxId: `agentbox-${runId}`, endpoint: "https://10.0.0.9:3000", agentId: runId })),
    stop: vi.fn(async () => {}), list: vi.fn(() => []), cleanup: vi.fn(async () => {}),
  } as any;
}

let server: Awaited<ReturnType<typeof startRuntime>> | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  posts.length = 0;
  vi.clearAllMocks();
});

describe("capability.testRecommend", () => {
  it("refreshes test configuration on each question without respawning the authoring box", async () => {
    const frontend = fakeFrontendClient();
    const manager = fakeAgentBoxManager();
    let llm = { engine: "pi_agent", execution: { roles: { blue: { model: { id: "first" }, api_key: "private-key" } } } };
    frontend.request.mockImplementation(async (method: string, params: any) =>
      method === "capability.fetchInput" && params.ref === "test-model" ? { llm } : {});
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: manager, frontendClient: frontend, credentialService: { attachGrants: () => {}, resolveActorResources: async () => ({ clusters: [], hosts: [] }) } as any,
    });
    const started = await server.rpcMethods.get("capability.start")!({ profile: "kb-compile", org_id: "org-1", correlation_id: "attempt-1" }) as { run_id: string };
    await server.rpcMethods.get("capability.testStart")!({ run_id: started.run_id });
    expect((posts.find(post => post.path.startsWith("/test-session/"))!.body as any).llm).toEqual(llm);
    llm = { ...llm, execution: { roles: { blue: { model: { id: "second" }, api_key: "new-private-key" } } } };
    await server.rpcMethods.get("capability.testMessage")!({ run_id: started.run_id, test_session_id: "test-1", message: "question" });
    expect(posts.at(-1)).toMatchObject({ path: "/test-message/test-1", body: { message: "question", llm } });
    expect(manager.getOrCreate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(frontend.emitEvent.mock.calls)).not.toContain("private-key");
  });
  it("runs an explicit recommendation on the authoring box with a bounded long timeout", async () => {
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: fakeAgentBoxManager(), frontendClient: fakeFrontendClient(), credentialService: { attachGrants: () => {}, resolveActorResources: async () => ({ clusters: [], hosts: [] }) } as any,
    });
    const start = server.rpcMethods.get("capability.start")!;
    const started = await start({ profile: "kb-compile", org_id: "org-1", correlation_id: "attempt-1" }) as { run_id: string };
    const recommend = server.rpcMethods.get("capability.testRecommend")!;

    await expect(recommend({ run_id: started.run_id })).resolves.toEqual({
      run_id: started.run_id,
      question: "What is the retry limit?",
      reference_answer: "Three attempts.",
      evidence_paths: ["raw/policy.md"],
    });
    expect(posts).toContainEqual({
      path: `/test-recommendation/${started.run_id}`,
      body: {},
      timeoutMs: 210_000,
    });
  });
});

describe("capability.testReferenceAssist", () => {
  it("runs a bounded reference-answer assist call on the authoring box", async () => {
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: fakeAgentBoxManager(), frontendClient: fakeFrontendClient(), credentialService: { attachGrants: () => {}, resolveActorResources: async () => ({ clusters: [], hosts: [] }) } as any,
    });
    const start = server.rpcMethods.get("capability.start")!;
    const started = await start({ profile: "kb-compile", org_id: "org-1", correlation_id: "attempt-1" }) as { run_id: string };
    const assist = server.rpcMethods.get("capability.testReferenceAssist")!;

    await expect(assist({
      run_id: started.run_id,
      mode: "suggest",
      question: "What is the retry limit?",
    })).resolves.toEqual({
      run_id: started.run_id,
      mode: "suggest",
      candidates: [
        { style: "concise", answer: "Three attempts.", evidence_paths: ["raw/policy.md"] },
        { style: "complete", answer: "Retry at most three times.", evidence_paths: ["raw/policy.md"] },
      ],
    });
    expect(posts).toContainEqual({
      path: `/test-reference-assist/${started.run_id}`,
      body: { mode: "suggest", question: "What is the retry limit?" },
      timeoutMs: 615_000,
    });
  });

  it("strips the box envelope from a polished answer response", async () => {
    server = await startRuntime({
      config: { port: 0, internalPort: 0, host: "127.0.0.1", serverUrl: "", portalSecret: "" } as any,
      agentBoxManager: fakeAgentBoxManager(), frontendClient: fakeFrontendClient(), credentialService: { attachGrants: () => {}, resolveActorResources: async () => ({ clusters: [], hosts: [] }) } as any,
    });
    const start = server.rpcMethods.get("capability.start")!;
    const started = await start({ profile: "kb-compile", org_id: "org-1", correlation_id: "attempt-1" }) as { run_id: string };
    const assist = server.rpcMethods.get("capability.testReferenceAssist")!;

    await expect(assist({
      run_id: started.run_id,
      mode: "polish",
      question: "What is the retry limit?",
      draft_answer: "Retry five times.",
    })).resolves.toEqual({
      run_id: started.run_id,
      mode: "polish",
      polished_answer: "Retry no more than three times.",
      evidence_paths: ["raw/policy.md"],
      warnings: ["The draft overstated the retry limit."],
    });
    expect(posts).toContainEqual({
      path: `/test-reference-assist/${started.run_id}`,
      body: {
        mode: "polish",
        question: "What is the retry limit?",
        draft_answer: "Retry five times.",
      },
      timeoutMs: 615_000,
    });
  });
});
