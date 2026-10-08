import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredAgentEngine, runtimeChatCapabilities } from "./agent-engine.js";

afterEach(() => vi.unstubAllEnvs());
describe("trusted native input capabilities", () => {
  it("declares native image input only for the configured Codex engine", () => {
    vi.stubEnv("SICLAW_AGENT_ENGINE", "codex");
    expect(configuredAgentEngine()).toBe("codex");
    expect(runtimeChatCapabilities()).toEqual({ requestModes: ["sync", "async"], agentEngine: "codex", nativeImageInput: true });
  });
  it.each([undefined, "pi-agent", "unrecognized"])("preserves Pi behavior for %s", (engine) => {
    vi.stubEnv("SICLAW_AGENT_ENGINE", engine);
    expect(configuredAgentEngine()).toBe("pi-agent");
    expect(runtimeChatCapabilities().nativeImageInput).toBe(false);
  });
});
