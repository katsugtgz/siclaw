import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preExecSecurity, type PreExecResult } from "../../tools/infra/security-pipeline.js";
import { sanitizeEnv } from "../../tools/infra/sanitize-env.js";
import { validateKubectlInPipeline } from "../../tools/infra/kubectl-readonly-policy.js";
import { buildSandboxCommand } from "../../tools/infra/sandbox-exec.js";

type JsonObject = Record<string, unknown>;

export interface CodexExecutorGrants {
  readRoots: readonly string[];
  writeRoots: readonly string[];
  deniedRoots: readonly string[];
  allowCommands: boolean;
  /** Trusted binding supplied by the credential broker, never by model argv. */
  kubeconfigPath?: string;
  environment?: Readonly<Record<string, string>>;
  production: boolean;
}

export interface AuthorizedCodexRequest {
  params: JsonObject;
  command?: { text: string; security: PreExecResult };
}

/** Authorizes the upstream exec-server RPC contract, independently of Pi tools.
 * This component must be paired with an output policy in the execution relay;
 * it is intentionally not wired into the production brain yet. */
export class CodexExecutorPolicy {
  private readonly readRoots: string[];
  private readonly writeRoots: string[];
  private readonly deniedRoots: string[];
  private readonly declaredReadRoots: string[];
  private readonly declaredWriteRoots: string[];
  private readonly processes = new Set<string>();
  private readonly environment: Record<string, string>;
  private readonly allowCommands: boolean;
  private readonly production: boolean;

  constructor(grants: CodexExecutorGrants) {
    this.readRoots = grants.readRoots.map(canonicalPath);
    this.writeRoots = grants.writeRoots.map(canonicalPath);
    this.deniedRoots = grants.deniedRoots.map(canonicalPath);
    this.declaredReadRoots = grants.readRoots.map((root) => path.resolve(root));
    this.declaredWriteRoots = grants.writeRoots.map((root) => path.resolve(root));
    this.allowCommands = grants.allowCommands;
    this.production = grants.production;
    this.environment = { ...sanitizeEnv({ ...grants.environment }),
      KUBECONFIG: grants.kubeconfigPath ?? "/dev/null" };
  }

  authorize(method: string, input: unknown): AuthorizedCodexRequest {
    if (!isObject(input)) throw new Error("Invalid native executor request");
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
      case "process/signal":
      case "process/terminate":
        this.assertProcess(params.processId);
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

  releaseProcess(processId: string): void { this.processes.delete(processId); }

  private authorizeStart(params: JsonObject): AuthorizedCodexRequest {
    if (!this.allowCommands) throw new Error("Native commands are not authorized");
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
    params.cwd = this.authorizePath(params.cwd, false);
    const command = argv[2];
    const security = preExecSecurity(command, { context: "local", extraAllowed: new Set(["kubectl"]),
      pipelineValidators: [validateKubectlInPipeline], analyzeTarget: "auto" });
    if (security.error) throw new Error(security.error);
    // The executor owns process mechanics. Siclaw supplies immutable policy,
    // the sanitized environment and its existing OS identity boundary.
    params.argv = ["/bin/bash", "-c", this.production
      ? buildSandboxCommand(command, { timeoutS: 60 }) : command];
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
    return { params, command: { text: command, security } };
  }

  private assertProcess(id: unknown): void {
    if (typeof id !== "string" || !this.processes.has(id)) {
      throw new Error("Native process does not belong to this session");
    }
  }

  private authorizePath(value: unknown, write: boolean): string {
    if (typeof value !== "string") throw new Error("Invalid native filesystem path");
    const uri = new URL(value);
    if (uri.protocol !== "file:" || (uri.hostname && uri.hostname !== "localhost")) {
      throw new Error("Native filesystem path must be local");
    }
    const requested = path.resolve(fileURLToPath(uri));
    const canonical = canonicalPath(requested);
    const roots = write ? this.writeRoots : [...this.readRoots, ...this.writeRoots];
    const declared = write ? this.declaredWriteRoots
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
