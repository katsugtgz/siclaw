import type { CredentialBroker } from "../../agentbox/credential-broker.js";
import { parseArgs, shellEscape, CONTAINER_SENSITIVE_PATHS, isTrustedCommandExecutable } from "../../tools/infra/command-sets.js";
import { preExecSecurity, postExecSecurity, type PreExecResult } from "../../tools/infra/security-pipeline.js";
import { acquireSshTarget, sshExec } from "../../tools/infra/ssh-client.js";
import { prepareExecEnv, spawnAsync, validateNodeName, validatePodName } from "../../tools/infra/exec-utils.js";
import { runInDebugPod } from "../../tools/infra/debug-pod.js";
import { loadConfig } from "../config.js";
import type { ToolOutputData } from "../../tools/infra/security-pipeline.js";
import { extractCommands } from "../../tools/infra/command-validator.js";
import { getCommandBinary } from "../../tools/infra/command-sets.js";
import { redactText, buildRedactionConfig } from "../../shared/output-redactor.js";
import { redactDataDocument } from "../../tools/infra/kubectl-sanitize.js";
import { kubectlSubcommand, kubectlConnectionOverride } from "../../tools/infra/kubectl-sanitize.js";

export type CodexInfrastructureTarget =
  | { kind: "ssh"; broker: CredentialBroker }
  | { kind: "host"; name: string; broker: CredentialBroker }
  | { kind: "cluster"; name: string; broker: CredentialBroker; userId: string;
      allowApi: boolean; allowPod: boolean; allowNode: boolean };
export type InfrastructureOperation =
  | { kind: "host"; host?: string; command: string; security: PreExecResult }
  | { kind: "pod"; namespace?: string; pod: string; container?: string; command: string; security: PreExecResult }
  | { kind: "node"; node: string; command: string; security: PreExecResult };

/** Parses native command syntax. Transport/identity options are never supplied
 * by the model. Kubernetes API reads continue through the normal native server. */
export function authorizeInfrastructureCommand(command: string, target: CodexInfrastructureTarget): InfrastructureOperation | undefined {
  if (target.kind === "host") return { kind: "host", command, security: authorizeRemoteCommand(command, "host") };
  const args = parseArgs(command);
  if (target.kind === "ssh") {
    if (getCommandBinary(args[0] ?? "") !== "ssh") return;
    const host = args[1];
    if (!host || host.startsWith("-") || /[\s@/:;|&<>`]/.test(host)) throw new Error("Select a bound SSH host name or id; connection options are not authorized");
    const offset = args[2] === "--" ? 3 : 2;
    const remote = args.slice(offset);
    let inner: string;
    if (remote.length === 1) inner = remote[0];
    else {
      if (!remote.length || !validRemoteBinary(remote[0]) || remote.some(arg => /[;|&<>`\n\r]|\$\(/.test(arg))) {
        throw new Error("Invalid noninteractive SSH command");
      }
      inner = [remote[0], ...remote.slice(1).map(shellEscape)].join(" ");
    }
    return { kind: "host", host, command: inner, security: authorizeRemoteCommand(inner, "host") };
  }
  if (getCommandBinary(args[0] ?? "") !== "kubectl") {
    if (!target.allowApi) throw new Error("This environment only authorizes node or Pod diagnostics");
    return;
  }
  // Only exact standalone transport forms. Compound outer commands fall back
  // to the API validator, which rejects exec/debug in every pipeline stage.
  const verb = kubectlSubcommand(args.slice(1));
  if (verb !== "exec" && verb !== "debug") {
    if (!target.allowApi) throw new Error("Kubernetes API access is not authorized");
    return;
  }
  if (kubectlConnectionOverride(args.slice(1))) throw new Error("Kubernetes connection or identity overrides are not authorized");
  let namespace: string | undefined;
  let namespaceSeen = false;
  let container: string | undefined;
  const selection: string[] = [];
  const delimiter = args.indexOf("--", 1);
  if (delimiter < 0) throw new Error("Native remote execution requires an explicit -- command boundary");
  let verbSeen = false;
  for (let index = 1; index < delimiter; index++) {
    const arg = args[index];
    if (arg === verb && !verbSeen) { verbSeen = true; continue; }
    if (["-n", "--namespace"].includes(arg) || arg.startsWith("--namespace=")) {
      if (namespaceSeen) throw new Error("Duplicate namespace selection");
      namespaceSeen = true;
      namespace = arg.startsWith("--namespace=") ? arg.slice(12) : args[++index];
    } else if (["-c", "--container"].includes(arg) || arg.startsWith("--container=")) {
      if (verb !== "exec" || container) throw new Error("Container selection is not authorized");
      container = arg.startsWith("--container=") ? arg.slice(12) : args[++index];
      if (!container || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(container)) throw new Error("Invalid container selection");
    } else if (arg.startsWith("-")) throw new Error("Native remote transport options are not authorized");
    else selection.push(arg);
  }
  if (!verbSeen || selection.length !== 1) throw new Error("Exactly one remote target must be selected");
  const remote = args.slice(delimiter + 1);
  let inner: string;
  if (["sh", "bash", "/bin/sh", "/bin/bash"].includes(remote[0])) {
    if (remote.length !== 3 || !["-c", "-lc"].includes(remote[1])) throw new Error("Interactive remote shells are not authorized");
    inner = remote[2];
  } else {
    if (!remote.length) throw new Error("Missing remote diagnostic command");
    if (remote.some(arg => /[;|&<>`\n\r]|\$\(/.test(arg))) throw new Error("Compound transport commands are not authorized");
    if (!validRemoteBinary(remote[0])) throw new Error("Remote command binary must be a whitelisted name or a system path");
    inner = [remote[0], ...remote.slice(1).map(shellEscape)].join(" ");
  }
  if (verb === "debug") {
    if (!target.allowNode || namespaceSeen || !selection[0].startsWith("node/")) {
      throw new Error("Only an authorized kubectl debug node/<name> -- command is supported");
    }
    const node = selection[0].slice(5);
    const error = validateNodeName(node);
    if (error) throw new Error(error);
    return { kind: "node", node, command: inner, security: authorizeRemoteCommand(inner, "node") };
  }
  if (!target.allowPod || namespaceSeen && (!namespace || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespace))) throw new Error("Pod namespace is not authorized");
  const pod = selection.shift()?.replace(/^pods?\//, "") ?? "";
  const error = validatePodName(pod);
  if (error) throw new Error(error);
  return { kind: "pod", namespace, pod, container, command: inner, security: authorizeRemoteCommand(inner, "pod") };
}

function validRemoteBinary(binary: string): boolean {
  return /^[a-zA-Z0-9_./+-]+$/.test(binary) && isTrustedCommandExecutable(binary);
}

function authorizeRemoteCommand(command: string, context: "host" | "node" | "pod"): PreExecResult {
  // Native transport restrictions do not define another command whitelist.
  // Pi and Codex resolve names, flags, extras and sensitive paths through the
  // same preExecSecurity/COMMANDS policy below.
  for (const part of extractCommands(command)) {
    const binary = parseArgs(part)[0] ?? "";
    if (!isTrustedCommandExecutable(binary) || /^\s*[a-zA-Z_][a-zA-Z0-9_]*=/.test(part)) {
      throw new Error("Remote executable path or environment override is not authorized");
    }
  }
  const security = preExecSecurity(command, { context, sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS,
    blockPipeline: context === "pod", analyzeTarget: context === "pod" ? "single" : "last-in-pipeline" });
  if (security.error) throw new Error(security.error);
  return security;
}

/** Credential acquisition and platform transport, independent of Pi tools.
 * Re-authorize against the current broker inventory before every launch. */
export async function executeInfrastructureOperation(target: CodexInfrastructureTarget, operation: InfrastructureOperation,
  signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let result: { stdout: string; stderr: string; exitCode: number | null; truncated?: boolean };
  const bounded = ["timeout", "-s", "TERM", "-k", "5", "60", "/bin/sh", "-c", operation.command];
  if ((target.kind === "host" || target.kind === "ssh") && operation.kind === "host") {
    const hosts = await target.broker.refreshHosts();
    const name = target.kind === "host" ? target.name : operation.host;
    const selected = hosts.find(host => host.name === name || host.id === name);
    if (!selected) throw new Error("SSH host binding is no longer authorized");
    // Force a credential request instead of trusting an old credential cache.
    await target.broker.acquireHost(selected.name, "native-readonly-ssh");
    const host = await acquireSshTarget(target.broker, selected.name, "native-readonly-ssh");
    result = await sshExec(host, bounded.map(shellEscape).join(" "), { timeoutMs: 65_000, signal });
  } else if (target.kind === "cluster" && operation.kind !== "host") {
    const clusters = await target.broker.refreshClusters();
    if (!clusters.some(cluster => cluster.name === target.name)) throw new Error("Cluster binding is no longer authorized");
    await target.broker.acquireCluster(target.name, "native-readonly-infrastructure", { bypassCache: true });
    const acquired = await target.broker.ensureCluster(target.name, "native-readonly-infrastructure");
    if (!acquired.path) throw new Error("Authorized cluster credential is unavailable");
    const env = prepareExecEnv(undefined, acquired.path);
    const defaultNamespace = acquired.meta.contexts?.find(context => context.name === acquired.meta.current_context)?.namespace || "default";
    if (operation.kind === "pod") {
      const namespace = operation.namespace || defaultNamespace;
      // GET authorizes the exact selected target; no selector/default workload
      // can silently resolve to a different Pod.
      await spawnAsync("kubectl", [...env.kubeconfigArgs, "-n", namespace, "get", "pod", operation.pod, "-o", "name"],
        10_000, env.childEnv, signal);
      const args = [...env.kubeconfigArgs, "-n", namespace, "exec", operation.pod,
        ...(operation.container ? ["-c", operation.container] : []), "--", ...bounded];
      try { result = { ...await spawnAsync("kubectl", args, 65_000, env.childEnv, signal), exitCode: 0 }; }
      catch (error) {
        const e = error as { stdout?: string; stderr?: string; code?: number; truncated?: boolean };
        result = { stdout: e.stdout ?? "", stderr: e.stderr ?? "Remote execution failed", exitCode: typeof e.code === "number" ? e.code : 1, truncated: e.truncated };
      }
    } else {
      await spawnAsync("kubectl", [...env.kubeconfigArgs, "get", "node", operation.node, "-o", "name"], 10_000, env.childEnv, signal);
      const config = loadConfig();
      result = await runInDebugPod({ nodeName: operation.node, userId: target.userId,
        clusterKey: `${target.name}:${acquired.path}`, image: process.env.SICLAW_DEBUG_IMAGE || acquired.meta.debug_image || config.debugImage,
        namespace: config.debugNamespace,
        requireExistingNamespace: true,
        command: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--root", "--wd", "--", ...bounded] },
      env, { timeoutMs: 65_000, signal });
    }
  } else throw new Error("Native infrastructure target mismatch");
  if (result.truncated) return { stdout: "Output suppressed: infrastructure output exceeded its safety limit.", stderr: "", exitCode: 1 };
  // Sanitize before private IPC as well as at the native executor output gate.
  let data: ToolOutputData | undefined;
  postExecSecurity(result.stdout, operation.security.action, { stderr: result.stderr,
    hasSensitiveKubectl: operation.security.hasSensitiveKubectl, outputMode: "data", onOutputData: value => { data = value; } });
  if (!data) throw new Error("Native infrastructure output sanitization failed");
  const redaction = buildRedactionConfig();
  return { stdout: redactText(redactDataDocument(data.text).text, redaction),
    stderr: redactText(redactDataDocument(data.stderr ?? "").text, redaction), exitCode: result.exitCode ?? 1 };
}
