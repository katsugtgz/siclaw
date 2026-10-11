export type AgentEngine = "pi-agent" | "codex";

/** Read only trusted Agent configuration, never process-global env or chat input. */
export function resolveAgentEngine(value: unknown): AgentEngine {
  if (value === undefined || value === null || value === "") return "pi-agent";
  if (value === "pi-agent" || value === "codex") return value;
  throw new Error("Unsupported Agent engine configuration");
}

/** Input transport support, not permission to read images from files or MCP. */
export function runtimeChatCapabilities(agentEngine: AgentEngine = "pi-agent") {
  return { requestModes: ["sync", "async"], agentEngine, nativeImageInput: agentEngine === "codex" };
}
