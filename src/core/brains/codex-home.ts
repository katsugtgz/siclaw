import path from "node:path";
import { createHash } from "node:crypto";

/** Native storage belongs to one owner and selected Skill authorization set.
 * The same scope shares Codex's own memories/state across conversations. */
export function codexHomeForScope(userDataDir: string, scope: {
  agentId: string | null; userId?: string; sessionId: string;
  skills: readonly {name: string; filePath: string}[];
}): string {
  const owner = {agentId: scope.agentId, userId: scope.userId?.trim() || `session:${scope.sessionId}`,
    skills: scope.skills.map((skill) => [skill.name, path.resolve(skill.filePath)]).sort()};
  const key = createHash("sha256").update(JSON.stringify(owner)).digest("hex");
  return path.join(userDataDir, "agent", "codex", key);
}
