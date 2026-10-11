import fs from "node:fs";
import path from "node:path";
import { resolveAgentEngine, type AgentEngine } from "../shared/agent-engine.js";

export class SessionEngineMismatchError extends Error {
  readonly code = "SESSION_ENGINE_MISMATCH";
  constructor() { super("This conversation belongs to a different Agent engine. Restore its engine or start a new conversation."); }
}

/** Private, conversation-owned marker. An Agent setting cannot reinterpret another engine's history. */
export function claimSessionEngine(directory: string, agentId: string, sessionId: string, engine: AgentEngine): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const marker = path.join(directory, "agent-engine.json");
  const mismatch = () => new SessionEngineMismatchError();
  const read = () => {
    const fd = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid conversation engine marker");
      const value = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (value.version !== 1 || value.agentId !== agentId || value.sessionId !== sessionId ||
          !["pi-agent", "codex"].includes(value.engine)) throw new Error("Conversation engine ownership mismatch");
      return resolveAgentEngine(value.engine);
    } finally { fs.closeSync(fd); }
  };
  try {
    if (read() !== engine) throw mismatch();
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const legacyEngine = fs.existsSync(path.join(directory, "codex-thread.json")) ? "codex"
    : fs.readdirSync(directory).some(name => name.endsWith(".jsonl")) ? "pi-agent" : undefined;
  if (legacyEngine && legacyEngine !== engine) throw mismatch();
  try {
    fs.writeFileSync(marker, JSON.stringify({ version: 1, agentId, sessionId, engine }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (read() !== engine) throw mismatch();
  }
}
