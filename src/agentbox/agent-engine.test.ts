import { afterEach, expect, it, vi } from "vitest";
import { createToolsHandler } from "./sync-handlers.js";
import { AgentBoxSessionManager } from "./session.js";

afterEach(() => vi.unstubAllEnvs());

it("resolves two Agent engines concurrently through their own authenticated clients", async () => {
  vi.stubEnv("SICLAW_AGENT_ENGINE", "codex");
  const pi = new AgentBoxSessionManager(), codex = new AgentBoxSessionManager();
  pi.agentId = "pi-agent"; codex.agentId = "codex-agent";
  const piRequest = vi.fn(async () => ({ agentEngine: "pi-agent" }));
  const codexRequest = vi.fn(async () => ({ agentEngine: "codex", webSearchMode: "live" }));
  pi.gatewayClient = { toClientLike: () => ({ request: piRequest }) } as any;
  codex.gatewayClient = { toClientLike: () => ({ request: codexRequest }) } as any;
  expect(await Promise.all([pi.resolveAgentEngine(), codex.resolveAgentEngine()])).toEqual(["pi-agent", "codex"]);
  expect(pi.agentEngineState).toBe("pi-agent"); expect(codex.agentEngineState).toBe("codex");
  expect(pi.webSearchModeState).toBe("disabled"); expect(codex.webSearchModeState).toBe("live");
  expect(process.env.SICLAW_AGENT_ENGINE).toBe("codex");
  piRequest.mockRejectedValueOnce(new Error("control plane unavailable"));
  await expect(pi.resolveAgentEngine()).rejects.toThrow(/unavailable/);
  expect(codex.agentEngineState).toBe("codex");
});

it("reloads engine selection only on the owning Agent state", async () => {
  const pi = { allowedToolsState: [] as string[] | null, agentEngineState: "pi-agent" as const };
  const codex = { allowedToolsState: [] as string[] | null, agentEngineState: "codex" as const };
  await Promise.all([
    createToolsHandler(pi, null).materialize({ allowedTools: [], agentType: "custom", agentEngine: "pi-agent" }),
    createToolsHandler(codex, null).materialize({ allowedTools: [], agentType: "custom", agentEngine: "codex" }),
  ]);
  expect(pi.agentEngineState).toBe("pi-agent"); expect(codex.agentEngineState).toBe("codex");
});
