/** Engine choice belongs to operator configuration, never a chat payload. */
export function configuredAgentEngine(): "pi-agent" | "codex" {
  return process.env.SICLAW_AGENT_ENGINE === "codex" ? "codex" : "pi-agent";
}

/** Input transport support, not permission to read images from files or MCP. */
export function runtimeChatCapabilities() {
  const agentEngine = configuredAgentEngine();
  return { requestModes: ["sync", "async"], agentEngine, nativeImageInput: agentEngine === "codex" };
}
