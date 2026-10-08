import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";

export interface CodexHomeOwner { agentId: string | null; userId?: string; sessionId: string }
const ownerIdentity = (scope: CodexHomeOwner) => ({ agentId: scope.agentId,
  userId: scope.userId?.trim() || `session:${scope.sessionId}` });

/** Private metadata stamp, never an execution grant or model input. */
export function codexHomeOwnerKey(scope: CodexHomeOwner): string {
  return createHash("sha256").update(JSON.stringify(ownerIdentity(scope))).digest("hex");
}

/** Native storage belongs to one owner and selected Skill authorization set.
 * The same scope shares Codex's own memories/state across conversations. */
export function codexHomeForScope(userDataDir: string, scope: {
  agentId: string | null; userId?: string; sessionId: string;
  skills: readonly {name: string; filePath: string}[];
}): string {
  const owner = {...ownerIdentity(scope),
    skills: scope.skills.map((skill) => [skill.name, path.resolve(skill.filePath)]).sort()};
  const key = createHash("sha256").update(JSON.stringify(owner)).digest("hex");
  return path.join(userDataDir, "agent", "codex", key);
}

/** Resume an existing conversation in its original native home, without DB or
 * memory copying. Old sidecars had only rolloutPath: verify the directory's
 * original scope hash using the current owner and historical link metadata. */
export function restoreCodexHomeForSession(userDataDir: string, owner: CodexHomeOwner,
  saved: { home?: unknown; ownerKey?: unknown; rolloutPath?: unknown }): string | undefined {
  const namespace = path.resolve(userDataDir, "agent", "codex");
  let candidate: string | undefined;
  if (saved.ownerKey !== undefined && saved.ownerKey !== codexHomeOwnerKey(owner))
    throw new Error("Native conversation belongs to a different owner");
  if (typeof saved.home === "string") candidate = path.resolve(saved.home);
  else if (typeof saved.rolloutPath === "string") {
    const parts = path.relative(namespace, path.resolve(saved.rolloutPath)).split(path.sep);
    if (/^[a-f0-9]{64}$/.test(parts[0] ?? "") && parts[1] === "sessions") candidate = path.join(namespace, parts[0]);
  }
  if (!candidate) return undefined;
  if (path.dirname(candidate) !== namespace || !/^[a-f0-9]{64}$/.test(path.basename(candidate)))
    throw new Error("Native conversation home is outside the owner namespace");
  if (!fs.existsSync(candidate) || fs.lstatSync(candidate).isSymbolicLink() || !fs.statSync(candidate).isDirectory() ||
      fs.realpathSync(candidate) !== path.join(fs.realpathSync(namespace), path.basename(candidate)))
    throw new Error("Native conversation home is unavailable or redirected");
  if (saved.ownerKey === undefined) {
    const historicalSkills: Array<{ name: string; filePath: string }> = [];
    const root = path.join(candidate, "skills");
    let projection: fs.Stats | undefined;
    try { projection = fs.lstatSync(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (projection) {
      if (projection.isSymbolicLink() || !projection.isDirectory())
        throw new Error("Native historical Skill projection is redirected");
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isSymbolicLink() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
        const target = fs.readlinkSync(path.join(root, entry.name));
        if (!path.isAbsolute(target)) throw new Error("Native historical Skill projection is ambiguous");
        historicalSkills.push({ name: entry.name, filePath: path.join(target, "SKILL.md") });
      }
    }
    if (path.resolve(codexHomeForScope(userDataDir, { ...owner, skills: historicalSkills })) !== candidate)
      throw new Error("Native conversation owner could not be verified");
  }
  return candidate;
}
