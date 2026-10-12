import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  sshExec: vi.fn(), sshExecStream: vi.fn(), acquireSshTarget: vi.fn(), resolveContainerNetns: vi.fn(),
  runInDebugPod: vi.fn(), ensureDebugPodReady: vi.fn(), acquireDebugPod: vi.fn(), releaseDebugPod: vi.fn(),
  spawnNativeStream: vi.fn(), killRemoteSessionViaSsh: vi.fn(), killRemoteSessionViaKubectl: vi.fn(),
}));
vi.mock("../config.js", () => ({ loadConfig: () => ({ debugNamespace: "prepared-debug", debugImage: "operator-debug" }) }));
vi.mock("../../tools/infra/ssh-client.js", () => ({ sshExec: mocks.sshExec, sshExecStream: mocks.sshExecStream, acquireSshTarget: mocks.acquireSshTarget }));
vi.mock("../../tools/infra/exec-utils.js", async original => ({ ...await original<object>(), resolveContainerNetns: mocks.resolveContainerNetns }));
vi.mock("../../tools/infra/debug-pod.js", () => ({ runInDebugPod: mocks.runInDebugPod,
  ensureDebugPodReady: mocks.ensureDebugPodReady, acquireDebugPod: mocks.acquireDebugPod, releaseDebugPod: mocks.releaseDebugPod }));
vi.mock("../../tools/infra/bg-session.js", async original => ({ ...await original<object>(),
  killRemoteSessionViaSsh: mocks.killRemoteSessionViaSsh, killRemoteSessionViaKubectl: mocks.killRemoteSessionViaKubectl }));
vi.mock("./codex-process-stream.js", async original => ({ ...await original<object>(), spawnNativeStream: mocks.spawnNativeStream }));
import { authorizeInfrastructureCommand, executeInfrastructureOperation, type CodexInfrastructureTarget } from "./codex-infrastructure.js";

function inspect(netns: string | null): string {
  return JSON.stringify({ info: { runtimeSpec: { linux: { namespaces: [
    { type: "network", ...(netns === null ? {} : { path: `/var/run/netns/${netns}` }) },
  ] } } } });
}
function fixture() {
  const broker = { getChannelPolicy:()=>undefined,requireChannelOperation:vi.fn(),refreshClusters: vi.fn().mockResolvedValue([{ name: "bound" }]), acquireCluster: vi.fn(),
    ensureCluster: vi.fn().mockResolvedValue({ path: "/private/broker.kubeconfig", meta: {
      current_context: "ctx", contexts: [{ name: "ctx", namespace: "bound-ns" }], debug_image: "reviewed-debug",
    } }), refreshHosts: vi.fn().mockResolvedValue([{ name: "bound-host", id: "bound-id" }]), acquireHost: vi.fn() };
  const cluster: CodexInfrastructureTarget = { kind: "cluster", name: "bound", broker: broker as never, userId: "owner",
    allowApi: false, allowPod: false, allowNode: true };
  const ssh: CodexInfrastructureTarget = { kind: "ssh", broker: broker as never, allowCommands: true };
  return { broker, cluster, ssh };
}
beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.resolveContainerNetns.mockResolvedValue({ nodeName: "node-a", containerID: "container-a" });
  mocks.runInDebugPod.mockResolvedValue({ stdout: inspect("cni-safe"), stderr: "", exitCode: 0 });
  mocks.ensureDebugPodReady.mockResolvedValue({ namespace: "prepared-debug", podName: "helper" });
  mocks.acquireDebugPod.mockReturnValue("helper"); mocks.spawnNativeStream.mockResolvedValue(0);
  mocks.acquireSshTarget.mockResolvedValue({ host: "192.0.2.1", username: "root" });
  mocks.sshExec.mockResolvedValue({ stdout: inspect("cni-safe"), stderr: "", exitCode: 0 });
  mocks.sshExecStream.mockResolvedValue({ stdout: Readable.from(["password: synthetic-netns-secret\n"]), stderr: Readable.from([]),
    done: Promise.resolve({ exitCode: 0 }), abort: vi.fn() });
});

describe("native Pod network namespace targets", () => {
  it.each([
    "kubectl -n rdma-test debug pod/rdma-a -c main -- show_gids",
    "kubectl debug pods/rdma-a --namespace=rdma-test --container=main -- show_gids",
  ])("maps the logical Pod selector to NODE diagnostics: %s", command => {
    const { cluster } = fixture();
    expect(authorizeInfrastructureCommand(command, cluster)).toMatchObject({ kind: "node",
      podNetns: { pod: "rdma-a", namespace: "rdma-test", container: "main" } });
    expect(() => authorizeInfrastructureCommand(command, { ...cluster, allowNode: false })).toThrow(/not authorized/);
    // Pod exec and API grants alone do not permit a privileged node helper.
    expect(() => authorizeInfrastructureCommand(command, { ...cluster, allowNode: false, allowPod: true, allowApi: true })).toThrow();
  });
  it.each([
    "ssh bound-host --pod rdma-a --namespace rdma-test --container main -- show_gids",
    "ssh bound-id --namespace=rdma-test --container=main --pod=rdma-a -- show_gids",
  ])("admits only logical selectors on the bound SSH transport: %s", command => {
    const { ssh } = fixture();
    expect(authorizeInfrastructureCommand(command, ssh)).toMatchObject({ kind: "host",
      podNetns: { pod: "rdma-a", namespace: "rdma-test", container: "main" } });
    expect(() => authorizeInfrastructureCommand(command, { ...ssh, allowCommands: false })).toThrow(/not authorized/);
  });
  it.each([
    "kubectl -n 'ns;id' debug pod/rdma-a -- show_gids",
    "kubectl debug pod/'rdma-a;id' -- show_gids",
    "kubectl debug pod/rdma-a -c '../../escape' -- show_gids",
    "kubectl debug pod/rdma-a --image=unreviewed -- show_gids",
    "kubectl --kubeconfig=/untrusted debug pod/rdma-a -- show_gids",
    "kubectl debug node/node-a -c main -- show_gids",
    "kubectl debug pod/rdma-a -- ip netns exec cni-other show_gids",
    "kubectl debug pod/rdma-a -- sh -c 'show_gids; touch /tmp/owned'",
    "kubectl debug pod/rdma-a -- python3 -c 'print(1)'",
    "kubectl debug pod/rdma-a -- sh -c 'cat /proc/1/environ'",
    "kubectl debug pod/rdma-a -- sysctl -w vm.swappiness=0",
    "kubectl debug pod/rdma-a -- show_gids > /tmp/owned",
  ])("rejects unsafe node selector or diagnostic BEFORE transport: %s", command => {
    expect(() => authorizeInfrastructureCommand(command, fixture().cluster)).toThrow();
    expect(mocks.resolveContainerNetns).not.toHaveBeenCalled(); expect(mocks.runInDebugPod).not.toHaveBeenCalled();
  });
  it.each([
    "ssh bound-host --namespace rdma-test -- show_gids",
    "ssh bound-host --pod rdma-a --pod other -- show_gids",
    "ssh bound-host --pod rdma-a --namespace '' -- show_gids",
    "ssh bound-host --pod 'rdma-a;id' -- show_gids",
    "ssh bound-host --pod rdma-a --namespace 'ns;id' -- show_gids",
    "ssh bound-host --pod rdma-a --namespace -- show_gids",
    "ssh bound-host --pod rdma-a -- show_gids; touch /tmp/owned",
    "ssh bound-host --pod rdma-a --netns cni-other -- show_gids",
    "ssh bound-host --pod rdma-a --identity=/tmp/key -- show_gids",
    "ssh bound-host --pod rdma-a --show_gids",
    "ssh bound-host --pod rdma-a -- ip netns exec cni-other show_gids",
    "ssh bound-host --pod rdma-a -- curl -X POST https://example.test",
  ])("rejects SSH selector injection, raw netns and writes: %s", command => {
    expect(() => authorizeInfrastructureCommand(command, fixture().ssh)).toThrow();
    expect(mocks.sshExec).not.toHaveBeenCalled(); expect(mocks.sshExecStream).not.toHaveBeenCalled();
  });
  it("resolves via the shared service and pins the operator-owned helper, never the target Pod", async () => {
    const { cluster, broker } = fixture(), stop = new AbortController();
    const op = authorizeInfrastructureCommand("kubectl -n rdma-test debug pod/rdma-a -c main -- show_gids", cluster)!;
    await executeInfrastructureOperation(cluster, op, stop.signal);
    expect(mocks.resolveContainerNetns).toHaveBeenCalledWith("rdma-a", "rdma-test", "main", expect.any(Object), stop.signal);
    expect(mocks.runInDebugPod.mock.calls[0][0]).toMatchObject({ userId: "owner", nodeName: "node-a",
      image: "reviewed-debug", namespace: "prepared-debug", requireExistingNamespace: true });
    expect(mocks.runInDebugPod.mock.calls[0][0].command).toEqual(expect.arrayContaining(["--root", "--wd"]));
    expect(mocks.ensureDebugPodReady.mock.calls[0][0]).toMatchObject({ nodeName: "node-a", requireExistingNamespace: true });
    const args = mocks.spawnNativeStream.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(["--kubeconfig=/private/broker.kubeconfig", "prepared-debug", "helper", "nsenter", "--root", "--wd"]));
    expect(args).not.toContain("rdma-a"); expect(args).not.toContain("main");
    expect(args.at(-1)).toContain("ip netns exec"); expect(args.at(-1)).toContain("cni-safe");
    expect(args.at(-1)).toContain("show_gids");
    expect(mocks.releaseDebugPod).toHaveBeenCalledWith(expect.objectContaining({ nodeName: "node-a" }), "helper");
    expect(broker.refreshClusters).toHaveBeenCalledTimes(3);
  });
  it("keeps current-context namespace selection when none is supplied", async () => {
    const { cluster } = fixture();
    await executeInfrastructureOperation(cluster, authorizeInfrastructureCommand("kubectl debug pod/rdma-a -- show_gids", cluster)!, new AbortController().signal);
    expect(mocks.resolveContainerNetns.mock.calls[0].slice(0, 3)).toEqual(["rdma-a", "bound-ns", undefined]);
  });
  it("executes on only the currently bound SSH host and sanitizes the diagnostic output", async () => {
    const { ssh, broker } = fixture();
    const op = authorizeInfrastructureCommand("ssh bound-id --pod rdma-a --namespace rdma-test -- show_gids", ssh)!;
    const output = await executeInfrastructureOperation(ssh, op, new AbortController().signal);
    expect(broker.acquireHost).toHaveBeenCalledWith("bound-host", "native-readonly-ssh");
    expect(mocks.sshExec.mock.calls[0][1]).toContain('crictl pods --name "^rdma-a$" --namespace "^rdma-test$"');
    expect(mocks.sshExecStream.mock.calls[0][1]).toContain("ip netns exec");
    expect(output.stdout).not.toContain("synthetic-netns-secret"); expect(broker.refreshHosts).toHaveBeenCalledTimes(2);
  });
  it.each([inspect(null), inspect("bad;name"), "not json"])("never falls back to the host namespace on resolution failure: %s", async stdout => {
    const { cluster, ssh } = fixture();
    mocks.runInDebugPod.mockResolvedValue({ stdout, stderr: "", exitCode: 0 });
    mocks.sshExec.mockResolvedValue({ stdout, stderr: "", exitCode: 0 });
    for (const [target, command] of [[cluster, "kubectl debug pod/rdma-a -- show_gids"],
      [ssh, "ssh bound-host --pod rdma-a -- show_gids"]] as const) {
      await expect(executeInfrastructureOperation(target, authorizeInfrastructureCommand(command, target)!, new AbortController().signal)).rejects.toThrow();
    }
    expect(mocks.spawnNativeStream).not.toHaveBeenCalled(); expect(mocks.sshExecStream).not.toHaveBeenCalled();
    expect(mocks.ensureDebugPodReady).not.toHaveBeenCalled();
  });
  it("refuses revoked bindings both before and after the resolver", async () => {
    const { cluster, ssh, broker } = fixture();
    broker.refreshClusters.mockResolvedValueOnce([]);
    await expect(executeInfrastructureOperation(cluster, authorizeInfrastructureCommand("kubectl debug pod/rdma-a -- show_gids", cluster)!, new AbortController().signal)).rejects.toThrow(/no longer authorized/);
    expect(mocks.resolveContainerNetns).not.toHaveBeenCalled(); expect(broker.acquireCluster).not.toHaveBeenCalled();
    broker.refreshHosts.mockResolvedValueOnce([]);
    await expect(executeInfrastructureOperation(ssh, authorizeInfrastructureCommand("ssh bound-host --pod rdma-a -- show_gids", ssh)!, new AbortController().signal)).rejects.toThrow(/no longer authorized/);
    expect(mocks.sshExec).not.toHaveBeenCalled(); expect(broker.acquireHost).not.toHaveBeenCalled();
    broker.refreshClusters.mockResolvedValueOnce([{ name: "bound" }]).mockResolvedValueOnce([]);
    await expect(executeInfrastructureOperation(cluster, authorizeInfrastructureCommand("kubectl debug pod/rdma-a -- show_gids", cluster)!, new AbortController().signal)).rejects.toThrow(/no longer authorized/);
    broker.refreshHosts.mockResolvedValueOnce([{ name: "bound-host", id: "bound-id" }]).mockResolvedValueOnce([]);
    await expect(executeInfrastructureOperation(ssh, authorizeInfrastructureCommand("ssh bound-host --pod rdma-a -- show_gids", ssh)!, new AbortController().signal)).rejects.toThrow(/no longer authorized/);
    expect(mocks.spawnNativeStream).not.toHaveBeenCalled(); expect(mocks.sshExecStream).not.toHaveBeenCalled();
  });
  it("Stop during resolution cannot launch a target process", async () => {
    const { cluster, ssh } = fixture();
    for (const [target, command] of [[cluster, "kubectl debug pod/rdma-a -- show_gids"],
      [ssh, "ssh bound-host --pod rdma-a -- show_gids"]] as const) {
      const stop = new AbortController();
      const resolve = target.kind === "cluster" ? mocks.runInDebugPod : mocks.sshExec;
      resolve.mockImplementationOnce(async () => { stop.abort(); return { stdout: inspect("cni-safe"), stderr: "", exitCode: 0 }; });
      await expect(executeInfrastructureOperation(target, authorizeInfrastructureCommand(command, target)!, stop.signal)).rejects.toThrow();
    }
    expect(mocks.spawnNativeStream).not.toHaveBeenCalled(); expect(mocks.sshExecStream).not.toHaveBeenCalled();
  });
  it("rechecks revocation after helper preparation and releases the exact pin on denial", async () => {
    const { cluster, broker } = fixture();
    mocks.ensureDebugPodReady.mockImplementationOnce(async () => {
      broker.refreshClusters.mockResolvedValue([]);
      return { namespace: "prepared-debug", podName: "helper" };
    });
    await expect(executeInfrastructureOperation(cluster, authorizeInfrastructureCommand("kubectl debug pod/rdma-a -- show_gids", cluster)!, new AbortController().signal))
      .rejects.toThrow(/no longer authorized/);
    expect(mocks.spawnNativeStream).not.toHaveBeenCalled();
    expect(mocks.releaseDebugPod).toHaveBeenCalledWith(expect.objectContaining({ nodeName: "node-a" }), "helper");
  });
  it("Stop and remote failures reap the HOST process group and release the exact helper", async () => {
    const { cluster, ssh } = fixture(), stop = new AbortController();
    mocks.spawnNativeStream.mockImplementationOnce(async () => { stop.abort(); return 1; });
    await executeInfrastructureOperation(cluster, authorizeInfrastructureCommand("kubectl debug pod/rdma-a -- show_gids", cluster)!, stop.signal);
    expect(mocks.killRemoteSessionViaKubectl).toHaveBeenCalledWith(expect.objectContaining({ namespace: "prepared-debug", podName: "helper",
      nsenterPrefix: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--root", "--wd", "--"] }));
    expect(mocks.releaseDebugPod).toHaveBeenCalledWith(expect.objectContaining({ nodeName: "node-a" }), "helper");
    mocks.sshExecStream.mockResolvedValueOnce({ stdout: Readable.from([]), stderr: Readable.from([]), done: Promise.resolve({ signal: "TERM" }), abort: vi.fn() });
    await executeInfrastructureOperation(ssh, authorizeInfrastructureCommand("ssh bound-host --pod rdma-a -- show_gids", ssh)!, new AbortController().signal);
    expect(mocks.killRemoteSessionViaSsh).toHaveBeenCalled();
  });
  it.each([false, true])("Stop settles silent SSH without close acknowledgement (reader started: %s)", async readerStarted => {
    const { ssh } = fixture(), stop = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const stdout = new PassThrough(), stderr = new PassThrough(), abort = vi.fn();
    mocks.sshExecStream.mockImplementationOnce(async () => {
      started(); return { stdout, stderr, done: new Promise(() => {}), abort };
    });
    const execution = executeInfrastructureOperation(ssh,
      authorizeInfrastructureCommand("ssh bound-host --pod rdma-a -- sleep 197", ssh)!, stop.signal);
    // Attach rejection handling before firing Stop; the output readers must
    // settle without waiting for a remote peer's close acknowledgement.
    const result = execution.then(() => false, () => true);
    await ready;
    if (readerStarted) await vi.waitFor(() => expect(stdout.listenerCount("readable")).toBeGreaterThan(0));
    stop.abort();
    expect(await result).toBe(true);
    expect(stdout.destroyed).toBe(true); expect(stderr.destroyed).toBe(true);
    expect(abort).toHaveBeenCalled(); expect(mocks.killRemoteSessionViaSsh).toHaveBeenCalled();
  });
});
