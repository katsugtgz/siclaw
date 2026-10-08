import type { CredentialBroker } from "../../agentbox/credential-broker.js";
import { parseArgs, shellEscape, CONTAINER_SENSITIVE_PATHS, isTrustedCommandExecutable } from "../../tools/infra/command-sets.js";
import { preExecSecurity, type PreExecResult } from "../../tools/infra/security-pipeline.js";
import { acquireSshTarget, sshExecStream } from "../../tools/infra/ssh-client.js";
import { prepareExecEnv, spawnAsync, validateNodeName, validatePodName, validateNamespace, validateContainerName } from "../../tools/infra/exec-utils.js";
import { resolvePodNetnsViaKubectl, resolvePodNetnsViaSsh } from "../../tools/infra/pod-netns-resolve.js";
import { loadConfig } from "../config.js";
import { extractCommands, validateShellOperators } from "../../tools/infra/command-validator.js";
import { getCommandBinary } from "../../tools/infra/command-sets.js";
import { kubectlSubcommand, kubectlConnectionOverride } from "../../tools/infra/kubectl-sanitize.js";
import { authorizeSkillScriptCommand, executeLocalSkillScript, revalidateSkillScript, SCRIPT_SECURITY,
  type AuthorizedSkillScript, type NativeSkillScriptGrants } from "./codex-skill-scripts.js";
import { backgroundPgidFile, wrapBackgroundSession, killRemoteSessionViaSsh, killRemoteSessionViaKubectl, backgroundSessionKillScript } from "../../tools/infra/bg-session.js";
import { ensureDebugPodReady, acquireDebugPod, releaseDebugPod } from "../../tools/infra/debug-pod.js";
import { stdinExecCmd } from "../../tools/infra/exec-utils.js";
import { sanitizeEnv } from "../../tools/infra/sanitize-env.js";
import { fileURLToPath } from "node:url";
import { buildSandboxCommand, reapSandboxSession } from "../../tools/infra/sandbox-exec.js";
import { CodexOutputStream } from "./codex-output-stream.js";
import { consumeNativeOutput, spawnNativeStream, type NativeOutputConsumer } from "./codex-process-stream.js";
import type { SensitiveValueSource } from "../../shared/model-output-redactor.js";
import { requireChannelNamespace } from "../../shared/channel-execution-policy.js";

export type CodexInfrastructureTarget =
  | { kind: "ssh"; broker: CredentialBroker; allowCommands?: boolean }
  | { kind: "host"; name: string; broker: CredentialBroker }
  | { kind: "cluster"; name: string; broker: CredentialBroker; userId: string;
      allowApi: boolean; allowPod: boolean; allowNode: boolean };
interface PodNetnsTarget { pod: string; namespace?: string; container?: string }
export type InfrastructureOperation = (
  | { kind: "host"; host?: string; podNetns?: PodNetnsTarget; command: string; security: PreExecResult }
  | { kind: "pod"; namespace?: string; pod: string; container?: string; command: string; security: PreExecResult }
  | { kind: "node"; node?: string; podNetns?: PodNetnsTarget; command: string; security: PreExecResult }
  | { kind: "local-script"; command: string; security: PreExecResult }
  | { kind: "local-command"; command: string; security: PreExecResult;
      cwd: string; environment: Record<string, string>; production: boolean }
) & { script?: AuthorizedSkillScript };

/** Parses native command syntax. Transport/identity options are never supplied
 * by the model. Kubernetes API reads continue through the normal native server. */
export function authorizeInfrastructureCommand(command: string, target: CodexInfrastructureTarget,
  scripts?: NativeSkillScriptGrants, cwd = "/"): InfrastructureOperation | undefined {
  const authorize = (inner: string, context: "host" | "node" | "pod") => {
    const script = authorizeSkillScriptCommand(inner, cwd, context, scripts);
    if (script && (validateShellOperators(command) || extractCommands(command).length !== 1)) {
      throw new Error("Skill script transport requires one literal command without shell operators");
    }
    return script ? { security: SCRIPT_SECURITY, script } : { security: authorizeRemoteCommand(inner, context) };
  };
  if (target.kind === "host") {
    const policy=authorize(command,"host");target.broker.requireChannelOperation(policy.script ? "scripts" : "ssh_exec");
    return { kind: "host", command, ...policy };
  }
  const args = parseArgs(command);
  if (target.kind === "ssh") {
    if (getCommandBinary(args[0] ?? "") !== "ssh") return;
    const host = args[1];
    if (!host || host.startsWith("-") || /[\s@/:;|&<>`]/.test(host)) throw new Error("Select a bound SSH host name or id; connection options are not authorized");
    let offset = args[2] === "--" ? 3 : 2;
    let podNetns: PodNetnsTarget | undefined;
    if (args[2]?.startsWith("--") && args[2] !== "--") {
      const delimiter = args.indexOf("--", 2);
      if (delimiter < 0) throw new Error("SSH Pod selection requires an explicit -- command boundary");
      const values: Record<string, string> = {};
      for (let index = 2; index < delimiter; index++) {
        const [flag, ...inline] = args[index].split("=");
        if (!["--pod", "--namespace", "--container"].includes(flag) || Object.hasOwn(values, flag))
          throw new Error("SSH connection options and duplicate Pod selectors are not authorized");
        const value = inline.length ? inline.join("=") : args[++index];
        if (!value || index >= delimiter || value.startsWith("-")) throw new Error("Missing SSH Pod selector value");
        values[flag] = value;
      }
      if (!values["--pod"]) throw new Error("SSH namespace/container selection requires --pod");
      podNetns = { pod: values["--pod"], namespace: values["--namespace"], container: values["--container"] };
      validatePodNetnsTarget(podNetns);
      offset = delimiter + 1;
    }
    const remote = args.slice(offset);
    let inner: string;
    if (remote.length === 1) inner = remote[0];
    else {
      if (!remote.length || !validRemoteBinary(remote[0]) || !isScriptInterpreter(remote[0]) && remote.some(arg => /[;|&<>`\n\r]|\$\(/.test(arg))) {
        throw new Error("Invalid noninteractive SSH command");
      }
      inner = [remote[0], ...remote.slice(1).map(shellEscape)].join(" ");
    }
    const policy = authorize(inner, "host");
    target.broker.requireChannelOperation(policy.script ? "scripts" : "ssh_exec");
    if (podNetns) requireChannelNamespace(target.broker.getChannelPolicy(), podNetns.namespace ?? "default");
    if (target.allowCommands === false && !policy.script) throw new Error("SSH commands are not authorized by this script-only grant");
    return { kind: "host", host, ...(podNetns ? { podNetns } : {}), command: inner, ...policy };
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
      if (container) throw new Error("Duplicate container selection");
      container = arg.startsWith("--container=") ? arg.slice(12) : args[++index];
      if (!container || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(container)) throw new Error("Invalid container selection");
    } else if (arg.startsWith("-")) throw new Error("Native remote transport options are not authorized");
    else selection.push(arg);
  }
  if (!verbSeen || selection.length !== 1) throw new Error("Exactly one remote target must be selected");
  const remote = args.slice(delimiter + 1);
  let inner: string;
  if (["sh", "bash", "/bin/sh", "/bin/bash"].includes(remote[0]) && ["-c", "-lc"].includes(remote[1])) {
    if (remote.length !== 3 || !["-c", "-lc"].includes(remote[1])) throw new Error("Interactive remote shells are not authorized");
    inner = remote[2];
  } else {
    if (!remote.length) throw new Error("Missing remote diagnostic command");
    if (!isScriptInterpreter(remote[0]) && remote.some(arg => /[;|&<>`\n\r]|\$\(/.test(arg))) throw new Error("Compound transport commands are not authorized");
    if (!validRemoteBinary(remote[0])) throw new Error("Remote command binary must be a whitelisted name or a system path");
    inner = [remote[0], ...remote.slice(1).map(shellEscape)].join(" ");
  }
  if (verb === "debug") {
    if (target.broker.getChannelPolicy()) throw new Error("Privileged node/network-namespace debug is not authorized by a namespace-scoped channel policy");
    const policy = authorize(inner, "node");
    if (!target.allowNode && !policy.script) throw new Error("Node diagnostics are not authorized");
    if (/^pods?\//.test(selection[0])) {
      const podNetns = { pod: selection[0].replace(/^pods?\//, ""), namespace, container };
      validatePodNetnsTarget(podNetns);
      return { kind: "node", podNetns, command: inner, ...policy };
    }
    if (namespaceSeen || container || !selection[0].startsWith("node/"))
      throw new Error("Select kubectl debug node/<name> or pod/<name>; helper configuration is platform-owned");
    const node = selection[0].slice(5);
    const error = validateNodeName(node);
    if (error) throw new Error(error);
    return { kind: "node", node, command: inner, ...policy };
  }
  const policy = authorize(inner, "pod");
  target.broker.requireChannelOperation(policy.script ? "scripts" : "pod_exec");
  requireChannelNamespace(target.broker.getChannelPolicy(),namespace ?? "default");
  if ((!target.allowPod && !policy.script) || namespaceSeen && (!namespace || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespace))) throw new Error("Pod namespace is not authorized");
  const pod = selection.shift()?.replace(/^pods?\//, "") ?? "";
  const error = validatePodName(pod);
  if (error) throw new Error(error);
  return { kind: "pod", namespace, pod, container, command: inner, ...policy };
}

function validatePodNetnsTarget(target: PodNetnsTarget): void {
  const error = validatePodName(target.pod) ??
    (target.namespace !== undefined ? validateNamespace(target.namespace) : null) ??
    (target.container !== undefined ? validateContainerName(target.container) : null);
  if (error) throw new Error(error);
}

function validRemoteBinary(binary: string): boolean {
  return /^[a-zA-Z0-9_./+-]+$/.test(binary) && isTrustedCommandExecutable(binary);
}

function isScriptInterpreter(binary: string): boolean {
  return ["bash", "sh", "python3", "/bin/bash", "/bin/sh", "/usr/bin/python3", "timeout"].includes(binary);
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
 * Re-authorize current resource bindings before each launch. With an output
 * consumer (the production relay), no process output is retained here. */
export async function executeInfrastructureOperation(target: CodexInfrastructureTarget | undefined, operation: InfrastructureOperation,
  signal: AbortSignal, scripts?: NativeSkillScriptGrants, environment?: NodeJS.ProcessEnv,
  resolveKubeconfig?: () => Promise<string>, redactOutput?: (text: string) => string,
  stream?: { output: (channel: "stdout" | "stderr", text: string) => Promise<void>; sensitiveValues?: SensitiveValueSource },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  signal.throwIfAborted();
  const stdout = new CodexOutputStream(operation.security.action, redactOutput, stream?.sensitiveValues);
  const stderr = new CodexOutputStream(null, redactOutput, stream?.sensitiveValues);
  const result = { stdout: "", stderr: "", exitCode: 1 };
  const emit = async (channel: "stdout" | "stderr", text: string) => {
    if (!text) return;
    if (stream) await stream.output(channel, text);
    else result[channel] += text; // Convenience for focused executor tests only.
  };
  const output: NativeOutputConsumer = async (channel, bytes) => emit(channel, (channel === "stdout" ? stdout : stderr).push(bytes));
  const content = operation.script ? revalidateSkillScript(operation.script, scripts) : undefined;
  if (operation.kind === "local-command") {
    const env = { ...operation.environment };
    if (resolveKubeconfig) {
      const path = await resolveKubeconfig();
      if (!path) throw new Error("Authorized cluster credentials are unavailable");
      env.KUBECONFIG = path;
    }
    const pgidFile = operation.production ? backgroundPgidFile("native-command") : undefined;
    const reap = () => { if (pgidFile) reapSandboxSession(pgidFile); };
    signal.addEventListener("abort", reap, { once: true });
    try {
      result.exitCode = await spawnNativeStream("/bin/bash", ["-c", operation.production
        ? buildSandboxCommand(operation.command, { pgidFile }) : operation.command], {
        cwd: fileURLToPath(operation.cwd), env, signal, output,
      });
    } finally { signal.removeEventListener("abort", reap); }
  } else if (operation.kind === "local-script") {
    if (!operation.script || content === undefined || !scripts?.allowed.local) throw new Error("Local Skill script is not authorized");
    const kubeconfig = resolveKubeconfig ? await resolveKubeconfig() : "/dev/null";
    result.exitCode = await executeLocalSkillScript(operation.script, content,
      { ...sanitizeEnv((environment ?? {}) as Record<string, string>), KUBECONFIG: kubeconfig, SICLAW_DEBUG_IMAGE: loadConfig().debugImage }, signal, output);
  } else {
    if (!target || operation.script && (!scripts?.allowed[operation.kind] || content === undefined)) throw new Error("Remote execution is not authorized");
    result.exitCode = await executeRemoteOperation(target, operation, content, signal, output);
  }
  await emit("stdout", stdout.finish());
  await emit("stderr", stderr.finish());
  return result;
}

async function executeRemoteOperation(target: CodexInfrastructureTarget,
  operation: Exclude<InfrastructureOperation, { kind: "local-command" | "local-script" }>, content: string | undefined,
  signal: AbortSignal, output: NativeOutputConsumer): Promise<number> {
  const script = operation.script;
  const pgidFile = backgroundPgidFile("native-remote");
  let inner = script ? stdinExecCmd(script.interpreter, script.args.map(shellEscape).join(" "))
    : ["/bin/sh", "-c", operation.command].map(shellEscape).join(" ");
  if (script?.timeoutSeconds !== undefined) inner = `timeout -s TERM -k 5 ${script.timeoutSeconds} ${inner}`;
  let wrapped = wrapBackgroundSession(inner, pgidFile);
  if (operation.kind === "host" && (target.kind === "ssh" || target.kind === "host")) {
    const name = target.kind === "host" ? target.name : operation.host;
    const hosts = await target.broker.refreshHosts();
    const host = hosts.find(value => value.name === name || value.id === name);
    if (!host) throw new Error("SSH host binding is no longer authorized");
    const reason = script ? "native-skill-script" : "native-readonly-ssh";
    await target.broker.acquireHost(host.name, reason);
    const ssh = await acquireSshTarget(target.broker, host.name, reason);
    const kill = () => killRemoteSessionViaSsh({ target: ssh, pgidFile });
    signal.addEventListener("abort", kill, { once: true });
    try {
      signal.throwIfAborted();
      if (operation.podNetns) {
        const resolved = await resolvePodNetnsViaSsh({ target: ssh, ...operation.podNetns,
          namespace: operation.podNetns.namespace ?? "default", signal });
        signal.throwIfAborted();
        if ("error" in resolved) throw new Error(resolved.error);
        const current = await target.broker.refreshHosts();
        signal.throwIfAborted();
        if (!current.some(value => value.name === host.name && value.id === host.id))
          throw new Error("SSH host binding is no longer authorized");
        // Keep the process-group record in the HOST namespace. Only the sealed
        // diagnostic/script enters the Pod netns, so Stop can always reap it.
        wrapped = wrapBackgroundSession(`ip netns exec ${shellEscape(resolved.netns)} sh -c ${shellEscape(inner)}`, pgidFile);
      }
      const handle = await sshExecStream(ssh, wrapped, { signal, stdin: content });
      // A silent SSH peer may never acknowledge channel close. End the local
      // output readers too so an aborted sealed operation cannot keep the
      // HTTP service/environment alive while the fresh remote reaper runs.
      const closeOutput = () => { handle.abort(); handle.stdout.destroy(); handle.stderr.destroy(); };
      signal.addEventListener("abort", closeOutput, { once: true });
      try {
        if (signal.aborted) { closeOutput(); signal.throwIfAborted(); }
        const [done] = await Promise.all([handle.done, consumeNativeOutput(handle.stdout, handle.stderr, output)]);
        if (typeof done.exitCode !== "number" || done.signal) kill();
        return done.exitCode ?? 1;
      } catch (error) { kill(); closeOutput(); throw error; }
      finally { signal.removeEventListener("abort", closeOutput); }
    } finally { signal.removeEventListener("abort", kill); }
  }
  if (target.kind !== "cluster" || !["pod", "node"].includes(operation.kind)) throw new Error("Native execution target mismatch");
  const clusters = await target.broker.refreshClusters();
  if (!clusters.some(value => value.name === target.name)) throw new Error("Cluster binding is no longer authorized");
  const reason = script ? "native-skill-script" : "native-readonly-infrastructure";
  await target.broker.acquireCluster(target.name, reason, { bypassCache: true });
  const acquired = await target.broker.ensureCluster(target.name, reason);
  if (!acquired.path) throw new Error("Authorized cluster credential is unavailable");
  const env = prepareExecEnv(undefined, acquired.path);
  let namespace: string, pod: string, prefix: string[] = [], release: (() => void) | undefined;
  if (operation.kind === "pod") {
    namespace = operation.namespace || acquired.meta.contexts?.find(value => value.name === acquired.meta.current_context)?.namespace || "default";
    pod = operation.pod;
    await spawnAsync("kubectl", [...env.kubeconfigArgs, "-n", namespace, "get", "pod", pod, "-o", "name"], 10000, env.childEnv, signal);
  } else if (operation.kind === "node") {
    const config = loadConfig(), clusterKey = `${target.name}:${acquired.path}`;
    const image = process.env.SICLAW_DEBUG_IMAGE || acquired.meta.debug_image || config.debugImage;
    let nodeName = operation.node, netns: string | undefined;
    if (operation.podNetns) {
      const resolved = await resolvePodNetnsViaKubectl({ ...operation.podNetns,
        namespace: operation.podNetns.namespace ?? acquired.meta.contexts?.find(value => value.name === acquired.meta.current_context)?.namespace ?? "default",
        env, userId: target.userId, clusterKey, image, debugNamespace: config.debugNamespace,
        requireExistingNamespace: true, enterHostRoot: true, signal });
      signal.throwIfAborted();
      if ("error" in resolved) throw new Error(resolved.error);
      nodeName = resolved.node; netns = resolved.netns;
      const current = await target.broker.refreshClusters();
      signal.throwIfAborted();
      if (!current.some(value => value.name === target.name)) throw new Error("Cluster binding is no longer authorized");
    } else {
      if (!nodeName) throw new Error("Missing node diagnostic target");
      await spawnAsync("kubectl", [...env.kubeconfigArgs, "get", "node", nodeName, "-o", "name"], 10000, env.childEnv, signal);
    }
    if (!nodeName) throw new Error("Missing resolved node diagnostic target");
    const spec = { userId: target.userId, nodeName, clusterKey,
      namespace: config.debugNamespace, requireExistingNamespace: true, command: [],
      image };
    const helper = await ensureDebugPodReady(spec, env, { signal });
    namespace = helper.namespace; pod = helper.podName;
    const pinned = acquireDebugPod(spec);
    if (pinned !== pod) {
      if (pinned) releaseDebugPod(spec, pinned);
      throw new Error("Diagnostic helper changed before execution");
    }
    release = () => releaseDebugPod(spec, pod);
    prefix = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--root", "--wd", "--"];
    if (netns) wrapped = wrapBackgroundSession(`ip netns exec ${shellEscape(netns)} sh -c ${shellEscape(inner)}`, pgidFile);
  } else throw new Error("Native execution target mismatch");
  const scopedTransport=target.broker.registerChannelPodTransport?.(target.name,namespace,pod,
    operation.kind==="pod"?operation.container??"":"",[...prefix,"sh","-c",wrapped],Boolean(script),[...prefix,"sh","-c",backgroundSessionKillScript(pgidFile)]);
  const kill = () => scopedTransport ? scopedTransport.kill() : killRemoteSessionViaKubectl({ kubeconfigArgs: env.kubeconfigArgs,
    childEnv: env.childEnv as Record<string, string>, namespace, podName: pod, pgidFile, nsenterPrefix: prefix,
    ...(operation.kind === "pod" && operation.container ? { container: operation.container } : {}) });
  signal.addEventListener("abort", kill, { once: true });
  try {
    signal.throwIfAborted();
    if (operation.kind === "node" && operation.podNetns) {
      // Helper preparation may await a new Job. Recheck after pinning too,
      // before the diagnostic launch, and release that exact pin on denial.
      const current = await target.broker.refreshClusters();
      signal.throwIfAborted();
      if (!current.some(value => value.name === target.name)) throw new Error("Cluster binding is no longer authorized");
    }
    const args = [...env.kubeconfigArgs, "-n", namespace, "exec", ...(script ? ["-i"] : []), pod,
      ...(operation.kind === "pod" && operation.container ? ["-c", operation.container] : []),
      "--", ...prefix, "sh", "-c", wrapped];
    const code = await spawnNativeStream("kubectl", args, { env: env.childEnv, signal, stdin: content, output });
    if (code !== 0) kill(); // A lost kubectl channel must also reap its remote session.
    return code;
  } catch (error) {
    kill(); throw error;
  } finally { signal.removeEventListener("abort", kill); scopedTransport?.finish(); release?.(); }
}
