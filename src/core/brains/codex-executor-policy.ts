import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preExecSecurity, type PreExecResult } from "../../tools/infra/security-pipeline.js";
import { sanitizeEnv } from "../../tools/infra/sanitize-env.js";
import { validateKubectlInPipeline } from "../../tools/infra/kubectl-readonly-policy.js";
import { buildSandboxCommand, reapSandboxSession } from "../../tools/infra/sandbox-exec.js";
import { backgroundPgidFile } from "../../tools/infra/bg-session.js";
import { randomUUID } from "node:crypto";
import { authorizeCodexFileCommand } from "./codex-file-command.js";
import { authorizeInfrastructureCommand, type CodexInfrastructureTarget, type InfrastructureOperation } from "./codex-infrastructure.js";
import { extractCommands } from "../../tools/infra/command-validator.js";
import { authorizeSkillScriptCommand, SCRIPT_SECURITY, type NativeSkillScriptGrants } from "./codex-skill-scripts.js";
import type { SensitiveValueSource } from "../../shared/model-output-redactor.js";

type JsonObject = Record<string, unknown>;

export interface CodexExecutorGrants {
  readRoots: readonly string[];
  writeRoots: readonly string[];
  deniedRoots: readonly string[];
  /** A command's cwd does not grant permission to read files there. */
  executionRoots?: readonly string[];
  allowCommands: boolean;
  /** Scoped native file reads/searches may be allowed without shell diagnostics. */
  allowFileCommands?: boolean;
  /** Trusted binding supplied by the credential broker, never by model argv. */
  kubeconfigPath?: string;
  /** Broker-owned refresh at each process launch, including native children. */
  resolveKubeconfig?: () => Promise<string>;
  environment?: Readonly<Record<string, string>>;
  production: boolean;
  infrastructure?: CodexInfrastructureTarget;
  skillScripts?: NativeSkillScriptGrants;
  /** Owner-scoped output gate, including credentials acquired later. */
  redactOutput?: (text: string) => string;
  sensitiveValues?: SensitiveValueSource;
}

export interface AuthorizedCodexRequest {
  params: JsonObject;
  command?: { text: string; security: PreExecResult };
  infrastructure?: InfrastructureOperation;
}

/** Authorizes the upstream exec-server RPC contract, independently of Pi tools.
 * The relay delivers sanitized bytes to the native process manager. */
export class CodexExecutorPolicy {
  private readonly readRoots: string[];
  private readonly writeRoots: string[];
  private readonly deniedRoots: string[];
  private readonly declaredReadRoots: string[];
  private readonly declaredWriteRoots: string[];
  private readonly executionRoots: string[];
  private readonly declaredExecutionRoots: string[];
  private readonly processes = new Set<string>();
  private readonly sandboxSessions = new Map<string, string>();
  private readonly environment: Record<string, string>;
  private readonly allowCommands: boolean;
  private readonly allowFileCommands: boolean;
  private readonly production: boolean;
  private readonly infrastructure?: CodexInfrastructureTarget;
  private readonly skillScripts?: NativeSkillScriptGrants;

  constructor(grants: CodexExecutorGrants) {
    this.readRoots = grants.readRoots.map(canonicalPath);
    this.writeRoots = grants.writeRoots.map(canonicalPath);
    this.deniedRoots = grants.deniedRoots.map(canonicalPath);
    this.declaredReadRoots = grants.readRoots.map((root) => path.resolve(root));
    this.declaredWriteRoots = grants.writeRoots.map((root) => path.resolve(root));
    const executionRoots = grants.executionRoots ?? [...grants.readRoots, ...grants.writeRoots];
    this.executionRoots = executionRoots.map(canonicalPath);
    this.declaredExecutionRoots = executionRoots.map((root) => path.resolve(root));
    this.allowCommands = grants.allowCommands;
    this.allowFileCommands = grants.allowFileCommands ?? grants.allowCommands;
    this.production = grants.production;
    this.infrastructure = grants.infrastructure;
    this.skillScripts = grants.skillScripts ? { ...grants.skillScripts,
      privateRoots: [...new Set([...grants.deniedRoots, ...(grants.skillScripts.privateRoots ?? [])])] } : undefined;
    this.environment = { ...sanitizeEnv({ ...grants.environment }),
      KUBECONFIG: grants.kubeconfigPath ?? "/dev/null" };
  }

  authorize(method: string, input: unknown): AuthorizedCodexRequest {
    if (!isObject(input)) throw new Error("Invalid native executor request");
    if (this.infrastructure?.kind === "host" && method.startsWith("fs/")) throw new Error("SSH environment filesystem RPCs are not authorized");
    const params = { ...input };
    switch (method) {
      case "initialize":
      case "initialized":
      case "environment/info":
      case "environment/status":
        return { params };
      case "process/start":
        return this.authorizeStart(params);
      case "process/read":
        this.assertProcess(params.processId);
        return { params };
      case "process/signal":
      case "process/terminate":
        this.assertProcess(params.processId);
        this.reap(String(params.processId));
        return { params };
      case "process/write":
        this.assertProcess(params.processId);
        // Native write_stdin may poll an existing process. Interactive input
        // requires a separate reviewed grant, since it can introduce commands.
        if (params.chunk !== "") throw new Error("Native process input is not authorized");
        return { params };
      case "fs/readFile":
      case "fs/getMetadata":
      case "fs/canonicalize":
      case "fs/readDirectory":
        params.path = this.authorizePath(params.path, false);
        return { params };
      case "fs/writeFile":
      case "fs/createDirectory":
        params.path = this.authorizePath(params.path, true);
        return { params };
      case "fs/remove":
        params.path = this.authorizePath(params.path, true);
        if (params.recursive === true || this.writeRoots.includes(fileURLToPath(String(params.path)))) {
          throw new Error("Recursive or workspace-root removal is not authorized");
        }
        return { params };
      case "fs/copy":
        params.sourcePath = this.authorizePath(params.sourcePath, false);
        params.destinationPath = this.authorizePath(params.destinationPath, true);
        if (params.recursive === true) throw new Error("Recursive native copy is not authorized");
        return { params };
      default:
        // Includes new upstream methods and file streams until their lifetime,
        // handle ownership, output policy and access semantics are implemented.
        throw new Error(`Native executor method is not authorized: ${method}`);
    }
  }

  releaseProcess(processId: string): void {
    this.processes.delete(processId);
    this.sandboxSessions.delete(processId);
  }

  stopAll(): void { for (const id of this.processes) this.reap(id); }

  private reap(id: string): void {
    const file = this.sandboxSessions.get(id);
    if (file) reapSandboxSession(file);
  }

  private authorizeStart(params: JsonObject): AuthorizedCodexRequest {
    const id = params.processId;
    if (typeof id !== "string" || !id || this.processes.has(id)) {
      throw new Error("Invalid native process identity");
    }
    const argv = params.argv;
    if (!Array.isArray(argv) || argv.length !== 3 ||
        !["/bin/bash", "/bin/sh", "/bin/zsh"].includes(argv[0]) ||
        !["-c", "-lc"].includes(argv[1]) || typeof argv[2] !== "string") {
      throw new Error("Native executor command form is not authorized");
    }
    if (params.tty === true || params.shellSnapshot) {
      throw new Error("Interactive native execution is not authorized");
    }
    if (params.arg0) throw new Error("Native argv0 override is not authorized");
    // A shell assignment could otherwise override the broker's immutable
    // KUBECONFIG/PATH even though the RPC environment is sanitized.
    if (extractCommands(argv[2]).some(command => /^\s*[a-zA-Z_][a-zA-Z0-9_]*=/.test(command))) throw new Error("Native shell environment overrides are not authorized");
    params.cwd = this.authorizePath(params.cwd, false, true);
    const script = authorizeSkillScriptCommand(argv[2], fileURLToPath(String(params.cwd)), "local", this.skillScripts);
    const infrastructure: InfrastructureOperation | undefined = script
      ? { kind: "local-script", command: argv[2], script, security: SCRIPT_SECURITY }
      : this.infrastructure ? authorizeInfrastructureCommand(argv[2], this.infrastructure, this.skillScripts,
        fileURLToPath(String(params.cwd))) : undefined;
    const fileCommand = infrastructure ? undefined : authorizeCodexFileCommand(argv[2], fileURLToPath(String(params.cwd)), (uri, directory) => {
      const authorized = this.authorizePath(uri, false);
      if (directory && this.deniedRoots.some((root) => within(root, fileURLToPath(authorized)))) {
        throw new Error("Native directory search overlaps a denied path");
      }
      return authorized;
    });
    const command = fileCommand ?? argv[2];
    if (!infrastructure && (fileCommand ? !this.allowFileCommands : !this.allowCommands)) throw new Error("Native commands are not authorized");
    const security: PreExecResult = infrastructure ? infrastructure.security : fileCommand ? { error: null, action: null, hasSensitiveKubectl: false }
      : preExecSecurity(command, { context: "local", extraAllowed: new Set(["kubectl"]),
      pipelineValidators: [validateKubectlInPipeline], analyzeTarget: "auto" });
    if (security.error) throw new Error(security.error);
    // The executor owns process mechanics. Siclaw supplies immutable policy,
    // the sanitized environment and its existing OS identity boundary.
    const pgidFile = this.production ? backgroundPgidFile(randomUUID()) : undefined;
    params.argv = ["/bin/bash", "-c", this.production
      ? buildSandboxCommand(command, { pgidFile }) : command];
    params.env = { ...this.environment };
    params.envPolicy = { inherit: "none", ignoreDefaultExcludes: false,
      exclude: [], set: {}, includeOnly: [] };
    // Unified exec requests a writable pipe even when the model only polls.
    // Close it at launch; process/write is independently restricted above.
    params.pipeStdin = false;
    // Upstream filesystem sandbox intent remains intact. If the production
    // sandbox prevents the UID transition, the relay must reject execution;
    // it must not silently remove sandbox intent or elevate capabilities.
    this.processes.add(id);
    if (pgidFile) this.sandboxSessions.set(id, pgidFile);
    return { params, command: { text: command, security }, infrastructure };
  }

  /** Trusted transport rewrite after native command authorization. Reuses the
   * same sandbox identity and process-group cleanup as ordinary native exec. */
  setTransportCommand(params: JsonObject, command: string): void {
    this.assertProcess(params.processId);
    const pgidFile = this.sandboxSessions.get(String(params.processId));
    params.argv = ["/bin/bash", "-c", this.production ? buildSandboxCommand(command, { pgidFile }) : command];
  }

  private assertProcess(id: unknown): void {
    if (typeof id !== "string" || !this.processes.has(id)) {
      throw new Error("Native process does not belong to this session");
    }
  }

  private authorizePath(value: unknown, write: boolean, execution = false): string {
    if (typeof value !== "string") throw new Error("Invalid native filesystem path");
    const uri = new URL(value);
    if (uri.protocol !== "file:" || (uri.hostname && uri.hostname !== "localhost")) {
      throw new Error("Native filesystem path must be local");
    }
    const requested = path.resolve(fileURLToPath(uri));
    const canonical = canonicalPath(requested);
    const roots = execution ? this.executionRoots : write ? this.writeRoots : [...this.readRoots, ...this.writeRoots];
    const declared = execution ? this.declaredExecutionRoots : write ? this.declaredWriteRoots
      : [...this.declaredReadRoots, ...this.declaredWriteRoots];
    const requestedRoot = [...declared, ...roots].find((root) => within(requested, root));
    if (!requestedRoot || !roots.some((root) => within(canonical, root)) ||
        this.deniedRoots.some((root) => within(canonical, root) || within(requested, root))) {
      throw new Error("Native filesystem path is outside the session grant");
    }
    if (write) assertNoWriteLinks(requested, requestedRoot);
    return pathToFileURL(canonical).href;
  }
}

function within(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function assertNoWriteLinks(target: string, root: string): void {
  let current = root;
  for (const component of ["", ...path.relative(root, target).split(path.sep)]) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Native workspace links are not writable");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

/** Resolve existing ancestors too, so new files cannot escape through a link. */
function canonicalPath(value: string): string {
  let ancestor = path.resolve(value);
  const missing: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Cannot resolve native filesystem root");
    // A dangling link must not be treated as a path that has not been created.
    try {
      if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error("Dangling native filesystem link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...missing);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
