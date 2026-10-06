import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "../../tools/infra/command-sets.js";
import { argumentPathSecurityError } from "../../tools/infra/argument-path-security.js";
import { extractCommands, validateShellOperators } from "../../tools/infra/command-validator.js";
import type { SkillScriptResolver } from "../../tools/infra/script-resolver.js";
import { sanitizeEnv } from "../../tools/infra/sanitize-env.js";
import type { PreExecResult } from "../../tools/infra/security-pipeline.js";

export type ScriptContext = "local" | "pod" | "node" | "host";
interface ScriptAsset {
  skill: string; filename: string; path: string; contentHash: string; skillMdPath: string; skillMdHash: string; packageHash: string;
  interpreter: "bash" | "python3";
}
export interface NativeSkillScriptGrants {
  resolver: SkillScriptResolver;
  assets: readonly ScriptAsset[];
  allowed: Readonly<Record<ScriptContext, boolean>>;
  privateRoots?: readonly string[];
}
export interface AuthorizedSkillScript extends ScriptAsset {
  args: string[]; timeoutSeconds: number;
}
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const SCRIPT_SECURITY: PreExecResult = { error: null, action: null, hasSensitiveKubectl: false };

function packageHash(root: string): string {
  const hash = createHash("sha256");let count = 0, bytes = 0;
  const visit = (relative: string) => {
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error("Skill package contains an unsupported filesystem entry");
    bytes += stat.isFile() ? stat.size : 0;
    if (++count > 5000 || bytes > 32 * 1024 * 1024) throw new Error("Skill package snapshot exceeds its safety limit");
    hash.update(JSON.stringify([relative, stat.isDirectory() ? "directory" : "file"]));
    if (stat.isDirectory()) for (const child of fs.readdirSync(full).sort()) visit(path.join(relative, child));
    else hash.update(digest(fs.readFileSync(full)));
  };
  visit("");return hash.digest("hex");
}

/** Only the harness-selected materialized assets are executable. The resolver
 * remains authoritative for disabled builtins and bundle precedence at launch. */
export function createNativeSkillScriptGrants(skills: readonly { name: string; filePath: string }[],
  resolver: SkillScriptResolver, allowed: NativeSkillScriptGrants["allowed"]): NativeSkillScriptGrants {
  const assets: ScriptAsset[] = [];
  if (!Object.values(allowed).some(Boolean)) return { resolver, assets, allowed };
  for (const skill of skills) {
    try {
      const filenames = resolver.listSkillScripts(skill.name);
      if (!filenames.length) continue;
      const skillMdPath = fs.realpathSync(skill.filePath);
      const root = path.dirname(skillMdPath);
      const snapshotHash = packageHash(root);
      for (const filename of filenames) {
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.(?:sh|py)$/.test(filename)) continue;
        const resolved = resolver.resolveScript({ skill: skill.name, script: filename });
        if ("error" in resolved || fs.lstatSync(resolved.path).isSymbolicLink()) continue;
        const scriptPath = fs.realpathSync(resolved.path);
        if (scriptPath !== path.join(root, "scripts", filename) || !fs.statSync(scriptPath).isFile()) continue;
        assets.push({ skill: skill.name, filename, path: scriptPath, contentHash: digest(fs.readFileSync(scriptPath)),
          skillMdPath, skillMdHash: digest(fs.readFileSync(skillMdPath)), packageHash: snapshotHash, interpreter: resolved.interpreter });
      }
    } catch { /* Missing/reloading assets never acquire execution authority. */ }
  }
  return { resolver, assets, allowed };
}

/** Literal argv grammar, not an interpreter exception in the command whitelist. */
export function authorizeSkillScriptCommand(command: string, cwd: string, context: ScriptContext,
  grants?: NativeSkillScriptGrants): AuthorizedSkillScript | undefined {
  const args = parseArgs(command);
  let offset = 0, timeoutSeconds = 180;
  if (args[0] === "timeout") {
    if (!/^\d+$/.test(args[1] ?? "") || Number(args[1]) < 1 || Number(args[1]) > 300) {
      throw new Error("Skill script timeout must be an integer from 1 to 300 seconds");
    }
    timeoutSeconds = Number(args[1]); offset = 2;
  }
  const interpreter = args[offset];
  if (!["bash", "sh", "python3", "/bin/bash", "/bin/sh", "/usr/bin/python3"].includes(interpreter)) return;
  const scriptArg = args[offset + 1];
  if (!scriptArg || scriptArg.startsWith("-")) return;
  const shellError = validateShellOperators(command);
  if (shellError || extractCommands(command).length !== 1 || /[\0\n\r]/.test(command)) {
    throw new Error("Skill script execution requires one literal command without shell operators");
  }
  if (!grants?.allowed[context]) throw new Error(`Skill script execution is not authorized in ${context}`);
  let filename: string;
  try {
    const requested = path.resolve(cwd, scriptArg);
    if (fs.lstatSync(requested).isSymbolicLink()) throw new Error();
    filename = fs.realpathSync(requested);
  } catch { throw new Error("Script is not an executable asset of this Agent's loaded Skills"); }
  const asset = grants.assets.find(value => value.path === filename);
  if (!asset) throw new Error("Script is not an executable asset of this Agent's loaded Skills");
  if (asset.interpreter === "python3" ? !["python3", "/usr/bin/python3"].includes(interpreter)
    : !["bash", "sh", "/bin/bash", "/bin/sh"].includes(interpreter)) throw new Error("Skill script interpreter does not match its asset type");
  const authorized = { ...asset, args: args.slice(offset + 2), timeoutSeconds };
  const argumentError = argumentPathSecurityError(authorized.args, { cwd, privateRoots: grants.privateRoots });
  if (argumentError) throw new Error(argumentError);
  revalidateSkillScript(authorized, grants);
  return authorized;
}

export function revalidateSkillScript(script: AuthorizedSkillScript, grants?: NativeSkillScriptGrants): string {
  if (!grants?.assets.some(asset => asset.path === script.path && asset.contentHash === script.contentHash &&
    asset.skillMdHash === script.skillMdHash)) throw new Error("Skill script grant has been revoked");
  const resolved = grants.resolver.resolveScript({ skill: script.skill, script: script.filename });
  if ("error" in resolved || fs.lstatSync(resolved.path).isSymbolicLink() || fs.realpathSync(resolved.path) !== script.path ||
    fs.realpathSync(script.skillMdPath) !== script.skillMdPath || digest(fs.readFileSync(script.skillMdPath)) !== script.skillMdHash ||
    digest(resolved.content) !== script.contentHash || packageHash(path.dirname(script.skillMdPath)) !== script.packageHash) {
    throw new Error("Skill asset changed or was disabled; reload the approved Skill before execution");
  }
  return resolved.content;
}

/** Reviewed local assets have Pi's agentbox identity and scoped cluster env.
 * A private package copy pins the main bytes and retains sibling imports. */
export async function executeLocalSkillScript(script: AuthorizedSkillScript, content: string,
  environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number; truncated?: boolean }> {
  if (signal.aborted) throw new Error("Skill script execution aborted");
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "native-skill-"));
  fs.chmodSync(snapshot, 0o700);
  const root = path.dirname(script.skillMdPath), packageRoot = path.join(snapshot, script.skill);
  try {
    let count = 0, bytes = 0;
    fs.cpSync(root, packageRoot, { recursive: true, filter: source => {
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error("Skill package contains an unsupported filesystem entry");
      bytes += stat.isFile() ? stat.size : 0;
      if (++count > 5000 || bytes > 32 * 1024 * 1024) throw new Error("Skill package snapshot exceeds its safety limit");
      return true;
    } });
    if (packageHash(packageRoot) !== script.packageHash) throw new Error("Skill package changed while taking its execution snapshot");
    const pinned = path.join(packageRoot, "scripts", script.filename);
    fs.chmodSync(pinned, 0o600);
    fs.writeFileSync(pinned, content, { mode: 0o600 });
    return await new Promise((resolve, reject) => {
      const child = spawn(script.interpreter, [pinned, ...script.args], { detached: true,
        env: sanitizeEnv(environment as Record<string, string>), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", size = 0, truncated = false;
      const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      const capture = (text: string, error: boolean) => {
        size += Buffer.byteLength(text);
        if (size > 8 * 1024 * 1024) { truncated = true; stdout = stderr = ""; kill(); }
        else if (!truncated) { if (error) stderr += text; else stdout += text; }
      };
      child.stdout.on("data", text => capture(text, false)); child.stderr.on("data", text => capture(text, true));
      const timer = setTimeout(kill, script.timeoutSeconds * 1000);
      signal.addEventListener("abort", kill, { once: true });
      child.once("error", error => { clearTimeout(timer); signal.removeEventListener("abort", kill); reject(error); });
      child.once("close", code => { clearTimeout(timer); signal.removeEventListener("abort", kill);
        resolve({ stdout, stderr, exitCode: code ?? 1, truncated }); });
      if (signal.aborted) kill();
    });
  } finally { fs.rmSync(snapshot, { recursive: true, force: true }); }
}
