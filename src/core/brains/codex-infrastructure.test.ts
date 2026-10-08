import { describe, it, expect, vi } from "vitest";
import { authorizeInfrastructureCommand, executeInfrastructureOperation, type CodexInfrastructureTarget } from "./codex-infrastructure.js";
import { Readable } from "node:stream";
const { sshExecStream, acquireSshTarget, spawnAsync, ensureDebugPodReady, acquireDebugPod, releaseDebugPod, spawnNativeStream } = vi.hoisted(() => ({
  sshExecStream: vi.fn(), acquireSshTarget: vi.fn(), spawnAsync: vi.fn(), ensureDebugPodReady: vi.fn(), acquireDebugPod: vi.fn(), releaseDebugPod: vi.fn(), spawnNativeStream: vi.fn(),
}));
vi.mock("../../tools/infra/ssh-client.js", () => ({ sshExecStream, acquireSshTarget }));
vi.mock("../../tools/infra/debug-pod.js", () => ({ ensureDebugPodReady, acquireDebugPod, releaseDebugPod }));
vi.mock("../../tools/infra/exec-utils.js", async importOriginal => ({ ...(await importOriginal<object>()), spawnAsync }));
vi.mock("./codex-process-stream.js", async original => ({ ...await original<object>(), spawnNativeStream }));
function cluster(overrides = {}): CodexInfrastructureTarget {
  return { kind: "cluster", name: "bound", broker: {getChannelPolicy:()=>undefined,requireChannelOperation:()=>{}} as any, userId: "user", allowApi: true, allowPod: true, allowNode: true, ...overrides };
}
const legacyBroker={getChannelPolicy:()=>undefined,requireChannelOperation:()=>{}};
const host: CodexInfrastructureTarget = { kind: "host", name: "bound-host", broker: legacyBroker as any };

describe("native read-only infrastructure grants", () => {
  it("keeps ordinary API reads native and translates only explicitly granted remote targets", () => {
    expect(authorizeInfrastructureCommand("kubectl -n test get pods -o json", cluster())).toBeUndefined();
    expect(authorizeInfrastructureCommand("kubectl -n test exec pod-a -c main -- cat /etc/os-release", cluster()))
      .toMatchObject({ kind: "pod", namespace: "test", pod: "pod-a", container: "main" });
    expect(authorizeInfrastructureCommand("kubectl exec -n test pod-a --container=main -- uname", cluster()))
      .toMatchObject({ kind: "pod", namespace: "test", pod: "pod-a", container: "main" });
    expect(authorizeInfrastructureCommand("kubectl debug node/node-a -- uname -a", cluster()))
      .toMatchObject({ kind: "node", node: "node-a" });
    expect(authorizeInfrastructureCommand("uname -a", host)).toMatchObject({ kind: "host" });
  });
  it.each([
    "kubectl exec pod-a -it -- sh", "kubectl exec pod-a -- sh", "kubectl exec pod-a -- sh -c 'touch /tmp/owned'",
    "kubectl exec pod-a -- cat /var/run/secrets/kubernetes.io/serviceaccount/token",
    "kubectl exec pod-a -- sh -c 'cat /proc/1/environ'",
    "kubectl exec pod-a -- cat /etc/os-release; touch /tmp/owned",
    "kubectl debug node/node-a --image=evil -- uname", "kubectl debug pod-a -- uname",
    "kubectl debug node/node-a -- sysctl -w vm.swappiness=0",
  ])("rejects unsafe native remote command: %s", command => {
    expect(() => authorizeInfrastructureCommand(command, cluster())).toThrow();
  });
  it.each(["touch /tmp/owned", "rm -rf /", "systemctl restart ssh", "ip link set eth0 down", "nvidia-smi --gpu-reset",
    "cat /etc/shadow", "env sh -c id", "curl -X POST https://example.test", "ib_write_bw --output=/tmp/owned", "tee /tmp/owned",
    "dmesg -C", "crictl rm x"])("rejects SSH writes/secrets: %s", command => {
    expect(() => authorizeInfrastructureCommand(command, host)).toThrow();
  });
  it("does not turn a Pod/node-only capability into unrestricted cluster API access", () => {
    expect(() => authorizeInfrastructureCommand("kubectl get pods", cluster({ allowApi: false }))).toThrow();
    expect(() => authorizeInfrastructureCommand("kubectl exec pod-a -- uname", cluster({ allowPod: false }))).toThrow();
    expect(() => authorizeInfrastructureCommand("kubectl debug node/node-a -- uname", cluster({ allowNode: false }))).toThrow();
  });
  it("supports native SSH syntax without arbitrary connection or credential options", () => {
    const target: CodexInfrastructureTarget = { kind: "ssh", broker: legacyBroker as any };
    expect(authorizeInfrastructureCommand("ssh bound-host -- uname -a", target)).toMatchObject({ kind: "host", host: "bound-host" });
    for (const command of ["ssh -i /tmp/key host -- uname", "ssh root@192.0.2.1 -- uname", "ssh bound-host -- touch /tmp/x",
      "ssh bound-host 'PATH=/tmp uname'", "ssh bound-host -- sh -c id"]) expect(() => authorizeInfrastructureCommand(command, target)).toThrow();
    expect(authorizeInfrastructureCommand("ls notes", target)).toBeUndefined();
  });
  it("does not authorize an arbitrary executable merely because it has a whitelisted basename", () => {
    for (const command of ["/tmp/cat /etc/os-release", "./uname", "/var/lib/evil/nvidia-smi"]) {
      expect(() => authorizeInfrastructureCommand(command, host)).toThrow();
    }
    expect(authorizeInfrastructureCommand("/usr/bin/uname -a", host)).toMatchObject({ kind: "host" });
    expect(authorizeInfrastructureCommand("ssh bound-host -- /usr/bin/uname -a", { kind: "ssh", broker: legacyBroker as any }))
      .toMatchObject({ kind: "host" });
    expect(authorizeInfrastructureCommand("kubectl exec pod-a -- /usr/bin/uname -a", cluster()))
      .toMatchObject({ kind: "pod" });
    expect(() => authorizeInfrastructureCommand("kubectl exec pod-a -- /tmp/uname", cluster())).toThrow();
  });
  it("refuses a revoked SSH binding before credential acquisition or execution", async () => {
    const broker = { ...legacyBroker,refreshHosts: vi.fn().mockResolvedValue([]), acquireHost: vi.fn() };
    const target = { ...host, broker } as unknown as CodexInfrastructureTarget;
    await expect(executeInfrastructureOperation(target, authorizeInfrastructureCommand("uname", target)!, new AbortController().signal))
      .rejects.toThrow("no longer authorized");
    expect(broker.acquireHost).not.toHaveBeenCalled();
    expect(sshExecStream).not.toHaveBeenCalled();
  });
  it("refreshes SSH credentials and sanitizes output before private IPC", async () => {
    const broker = { ...legacyBroker,refreshHosts: vi.fn().mockResolvedValue([{ name: "bound-host" }]), acquireHost: vi.fn() };
    acquireSshTarget.mockResolvedValue({ host: "192.0.2.1" });
    sshExecStream.mockResolvedValue({ stdout: Readable.from(["password: transport-test-secret\n"]), stderr: Readable.from([]), done: Promise.resolve({exitCode:0}), abort:vi.fn() });
    const target = { ...host, broker } as unknown as CodexInfrastructureTarget;
    const output = await executeInfrastructureOperation(target, authorizeInfrastructureCommand("uname", target)!, new AbortController().signal);
    expect(output.stdout).not.toContain("transport-test-secret");
    expect(broker.acquireHost).toHaveBeenCalledWith("bound-host", "native-readonly-ssh");
    expect(sshExecStream.mock.calls.at(-1)?.[1]).not.toContain("timeout");
  });
  it("authorizes the exact Pod and uses a cancellable noninteractive stream", async () => {
    const broker = { ...legacyBroker,refreshClusters: vi.fn().mockResolvedValue([{ name: "bound" }]), acquireCluster: vi.fn(),
      ensureCluster: vi.fn().mockResolvedValue({ path: "/tmp/authorized-config", meta: {} }) };
    spawnAsync.mockResolvedValue({ stdout: "Linux", stderr: "" });
    spawnNativeStream.mockResolvedValue(0);
    const target = cluster({ broker });
    const result = await executeInfrastructureOperation(target, authorizeInfrastructureCommand("kubectl -n test exec pod-a -- uname", target)!, new AbortController().signal);
    expect(result.exitCode).toBe(0);
    const args = spawnNativeStream.mock.calls.at(-1)?.[1];
    expect(args).toContain("--kubeconfig=/tmp/authorized-config");
    expect(args.join(" ")).not.toContain("timeout"); expect(args).not.toContain("-i"); expect(args).not.toContain("-t");
  });
  it("executes node reads in the host root and only in a prepared operator namespace", async () => {
    const broker = { ...legacyBroker,refreshClusters: vi.fn().mockResolvedValue([{ name: "bound" }]), acquireCluster: vi.fn(),
      ensureCluster: vi.fn().mockResolvedValue({ path: "/tmp/actor-config", meta: { debug_image: "registry.internal/reviewed-debug@sha256:fixed" } }) };
    spawnAsync.mockResolvedValue({ stdout: "node/node-a", stderr: "" });
    ensureDebugPodReady.mockResolvedValue({ podName: "helper", namespace: "sicore-test" });
    acquireDebugPod.mockReturnValue("helper"); spawnNativeStream.mockResolvedValue(0);
    const target = cluster({ broker });
    await executeInfrastructureOperation(target, authorizeInfrastructureCommand("kubectl debug node/node-a -- hostname", target)!, new AbortController().signal);
    const spec = ensureDebugPodReady.mock.calls.at(-1)?.[0];
    expect(spec).toMatchObject({ nodeName: "node-a", requireExistingNamespace: true, image: "registry.internal/reviewed-debug@sha256:fixed" });
    const args = spawnNativeStream.mock.calls.at(-1)?.[1];
    expect(args).toContain("--root"); expect(args).toContain("--wd");
    expect(releaseDebugPod).toHaveBeenCalledWith(expect.objectContaining({nodeName:"node-a"}), "helper");
  });
});
