import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sshExecStream: vi.fn(), acquireSshTarget: vi.fn(), spawnAsync: vi.fn(), spawnNativeStream: vi.fn(),
  ensureDebugPodReady: vi.fn(), acquireDebugPod: vi.fn(), releaseDebugPod: vi.fn(), killRemoteSessionViaKubectl: vi.fn(),
  resolvePodNetnsViaKubectl: vi.fn(), resolvePodNetnsViaSsh: vi.fn() }));
vi.mock("../../tools/infra/pod-netns-resolve.js", () => ({ resolvePodNetnsViaKubectl: mocks.resolvePodNetnsViaKubectl,
  resolvePodNetnsViaSsh: mocks.resolvePodNetnsViaSsh }));
vi.mock("../../tools/infra/ssh-client.js", () => ({ sshExecStream: mocks.sshExecStream, acquireSshTarget: mocks.acquireSshTarget }));
vi.mock("../../tools/infra/exec-utils.js", async original => ({ ...await original<object>(), spawnAsync: mocks.spawnAsync }));
vi.mock("../../tools/infra/debug-pod.js", async original => ({ ...await original<object>(), ensureDebugPodReady: mocks.ensureDebugPodReady,
  acquireDebugPod: mocks.acquireDebugPod, releaseDebugPod: mocks.releaseDebugPod }));
vi.mock("../../tools/infra/bg-session.js", async original => ({ ...await original<object>(), killRemoteSessionViaKubectl: mocks.killRemoteSessionViaKubectl }));
vi.mock("./codex-process-stream.js", async original => ({ ...await original<object>(), spawnNativeStream: mocks.spawnNativeStream }));
import { createNativeSkillScriptGrants } from "./codex-skill-scripts.js";
import { authorizeInfrastructureCommand, executeInfrastructureOperation } from "./codex-infrastructure.js";
import { createSkillScriptResolver } from "../../tools/infra/script-resolver.js";
const roots: string[] = [];
beforeEach(() => { Object.values(mocks).forEach(mock => mock.mockReset());mocks.spawnAsync.mockResolvedValue({ stdout: "QUERY_OK", stderr: "" });
  mocks.spawnNativeStream.mockResolvedValue(0);
  mocks.resolvePodNetnsViaKubectl.mockResolvedValue({ node: "node-a", netns: "cni-script" });
  mocks.resolvePodNetnsViaSsh.mockResolvedValue({ netns: "cni-script" });
  mocks.ensureDebugPodReady.mockResolvedValue({ podName: "helper", namespace: "sicore-test" });mocks.acquireDebugPod.mockReturnValue("helper"); });
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-script-transport-")));roots.push(root);
  const skill = path.join(root, "resolved", "query");fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "name: query");
  const file = path.join(skill, "scripts", "read.py"), content = "print('QUERY_OK')\n";fs.writeFileSync(file, content);
  const resolver = createSkillScriptResolver({ skillsBaseDir: root, resolvedSkillsDir: path.join(root, "resolved"), builtinDirs: [] });
  const scripts = createNativeSkillScriptGrants([{ name: "query", filePath: path.join(skill, "SKILL.md") }], resolver,
    { local: false, node: true, pod: true, host: true });
  const broker = { getChannelPolicy:()=>undefined,requireChannelOperation:vi.fn(),refreshClusters: vi.fn().mockResolvedValue([{ name: "bound" }]), acquireCluster: vi.fn(),
    ensureCluster: vi.fn().mockResolvedValue({ path: "/trusted/actor.kubeconfig", meta: {} }),
    refreshHosts: vi.fn().mockResolvedValue([{ name: "host" }]), acquireHost: vi.fn() } as any;
  return { root, file, content, scripts, broker, cluster: { kind: "cluster" as const, name: "bound", broker, userId: "reader",
    allowApi: false, allowPod: false, allowNode: false } };
}
describe("native script transport service", () => {
  it("preserves separate node/host script-only grants and sealed stdin inside a Pod netns", async () => {
    const f = fixture();
    const node = authorizeInfrastructureCommand(`kubectl -n test debug pod/pod-a -- python3 ${f.file} literal`, f.cluster, f.scripts, f.root)!;
    await executeInfrastructureOperation(f.cluster, node, new AbortController().signal, f.scripts);
    const call = mocks.spawnNativeStream.mock.calls.at(-1)!;
    expect(call[1]).toContain("-i"); expect(call[1].at(-1)).toContain("ip netns exec");
    expect(call[1].at(-1)).toContain("cni-script"); expect(call[2].stdin).toBe(f.content);
    expect(mocks.resolvePodNetnsViaKubectl.mock.calls[0][0]).toMatchObject({ pod: "pod-a", namespace: "test", requireExistingNamespace: true });
    const ssh = { kind: "ssh" as const, broker: f.broker, allowCommands: false };
    mocks.acquireSshTarget.mockResolvedValue({ host: "192.0.2.1" });
    const { Readable } = await import("node:stream");
    mocks.sshExecStream.mockResolvedValue({ stdout: Readable.from([]), stderr: Readable.from([]), done: Promise.resolve({ exitCode: 0 }), abort: vi.fn() });
    const host = authorizeInfrastructureCommand(`ssh host --pod pod-a --namespace test -- python3 ${f.file} literal`, ssh, f.scripts, f.root)!;
    await executeInfrastructureOperation(ssh, host, new AbortController().signal, f.scripts);
    expect(mocks.sshExecStream.mock.calls[0][1]).toContain("ip netns exec");
    expect(mocks.sshExecStream.mock.calls[0][2].stdin).toBe(f.content);
    for (const [target, command] of [[f.cluster, `kubectl debug pod/pod-a -- python3 ${f.file}`],
      [ssh, `ssh host --pod pod-a -- python3 ${f.file}`]] as const) {
      expect(() => authorizeInfrastructureCommand(command, target, { ...f.scripts, allowed: { ...f.scripts.allowed, node: false, host: false } }, f.root)).toThrow();
    }
  });
  it("sends sealed Python bytes to exact Pod/container stdin with literal arguments", async () => {
    const f = fixture();const op = authorizeInfrastructureCommand(`kubectl -n sicore-test exec pod-a -c main -- python3 ${f.file} 'foo;literal'`, f.cluster, f.scripts, f.root)!;
    const result = await executeInfrastructureOperation(f.cluster, op, new AbortController().signal, f.scripts);
    expect(result.exitCode).toBe(0);
    const call = mocks.spawnNativeStream.mock.calls.at(-1)!;expect(call[1]).toEqual(expect.arrayContaining(["-i", "pod-a", "-c", "main"]));
    expect(op.script?.args).toEqual(["foo;literal"]);expect(call[1].at(-1)).toContain("python3 -");expect(call[2].stdin).toBe(f.content);
  });
  it("pins the operator-owned node helper and releases it after remote failure", async () => {
    const f = fixture();const op = authorizeInfrastructureCommand(`kubectl debug node/node-a -- python3 ${f.file}`, f.cluster, f.scripts, f.root)!;
    mocks.spawnNativeStream.mockImplementationOnce(async (_binary, _args, options) => {
      await options.output("stdout", Buffer.from("PARTIAL")); await options.output("stderr", Buffer.from("usage error")); return 2;
    });
    const result = await executeInfrastructureOperation(f.cluster, op, new AbortController().signal, f.scripts);
    expect(result.exitCode).toBe(2);expect(result.stderr).toContain("usage error");
    expect(mocks.ensureDebugPodReady.mock.calls[0][0]).toMatchObject({ nodeName: "node-a", requireExistingNamespace: true });
    expect(mocks.spawnNativeStream.mock.calls.at(-1)![1]).toEqual(expect.arrayContaining(["nsenter", "--root", "--wd"]));
    expect(mocks.releaseDebugPod).toHaveBeenCalledWith(expect.objectContaining({ nodeName: "node-a" }), "helper");
  });
  it("uses the same selected container for remote Stop cleanup", async () => {
    const f = fixture(), stop = new AbortController();
    const op = authorizeInfrastructureCommand(`kubectl -n sicore-test exec pod-a -c main -- python3 ${f.file}`, f.cluster, f.scripts, f.root)!;
    mocks.spawnNativeStream.mockImplementationOnce(async () => { stop.abort();return 1; });
    await executeInfrastructureOperation(f.cluster, op, stop.signal, f.scripts);
    expect(mocks.killRemoteSessionViaKubectl).toHaveBeenCalledWith(expect.objectContaining({ namespace: "sicore-test", podName: "pod-a", container: "main" }));
  });
  it("refuses revoked resources and changed assets before execution", async () => {
    const f = fixture();const target = { kind: "ssh" as const, broker: f.broker, allowCommands: false };
    const op = authorizeInfrastructureCommand(`ssh host -- python3 ${f.file}`, target, f.scripts, f.root)!;
    f.broker.refreshHosts.mockResolvedValue([]);
    await expect(executeInfrastructureOperation(target, op, new AbortController().signal, f.scripts)).rejects.toThrow(/no longer authorized/);
    expect(mocks.sshExecStream).not.toHaveBeenCalled();expect(f.broker.acquireHost).not.toHaveBeenCalled();
    fs.appendFileSync(f.file, "print('unreviewed')\n");
    await expect(executeInfrastructureOperation(target, op, new AbortController().signal, f.scripts)).rejects.toThrow(/changed/);
    expect(mocks.acquireSshTarget).not.toHaveBeenCalled();
  });
});
