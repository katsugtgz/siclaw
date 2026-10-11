import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentEngine, runtimeChatCapabilities } from "./agent-engine.js";

afterEach(() => vi.unstubAllEnvs());
describe("trusted native input capabilities", () => {
  it("declares native image input only for the configured Codex engine", () => {
    vi.stubEnv("SICLAW_AGENT_ENGINE", "codex");
    expect(resolveAgentEngine("codex")).toBe("codex");
    expect(resolveAgentEngine("pi-agent")).toBe("pi-agent");
    expect(runtimeChatCapabilities("codex")).toEqual({ requestModes: ["sync", "async"], agentEngine: "codex", nativeImageInput: true });
  });
  it.each([undefined, null, "", "pi-agent"])("preserves Pi defaults independent of env for %s", (engine) => {
    vi.stubEnv("SICLAW_AGENT_ENGINE", "codex");
    expect(resolveAgentEngine(engine)).toBe("pi-agent");
    expect(runtimeChatCapabilities().nativeImageInput).toBe(false);
  });
  it("refuses invalid stored engines instead of silently falling back", () => {
    expect(() => resolveAgentEngine("unrecognized")).toThrow();
  });
});
