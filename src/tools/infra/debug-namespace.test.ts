import { beforeEach, describe, expect, it, vi } from "vitest";
const { spawnAsync } = vi.hoisted(() => ({ spawnAsync: vi.fn() }));
vi.mock("./exec-utils.js", async original => ({ ...await original<object>(), spawnAsync }));
import { ensureDebugNamespace } from "./debug-pod.js";
const env = { kubeconfigArgs: ["--kubeconfig=/actor/config"], childEnv: {} } as any;
beforeEach(() => spawnAsync.mockReset());
describe("prepared diagnostic namespace authorization", () => {
  it("uses a prepared namespace after namespace creation is forbidden", async () => {
    spawnAsync.mockRejectedValueOnce({ stderr: "namespaces create is Forbidden" }).mockResolvedValueOnce({ stdout: "namespace/sicore-test" });
    await ensureDebugNamespace("sicore-test", env);
    expect(spawnAsync.mock.calls.map(call => call[1])).toEqual([
      ["--kubeconfig=/actor/config", "create", "namespace", "sicore-test"],
      ["--kubeconfig=/actor/config", "get", "namespace", "sicore-test", "-o", "name"],
    ]);
  });
  it("retains the create failure if namespace existence cannot be verified", async () => {
    const error = { stderr: "namespaces create is Forbidden" };
    spawnAsync.mockRejectedValueOnce(error).mockRejectedValueOnce({ stderr: "namespaces get is Forbidden" });
    await expect(ensureDebugNamespace("sicore-test", env)).rejects.toBe(error);
  });
  it("never attempts namespace creation for the native prepared-only contract", async () => {
    const error = { stderr: "namespace NotFound" };spawnAsync.mockRejectedValueOnce(error);
    await expect(ensureDebugNamespace("sicore-test", env, 10000, true)).rejects.toBe(error);
    expect(spawnAsync).toHaveBeenCalledTimes(1);
    expect(spawnAsync.mock.calls[0][1]).toEqual(["--kubeconfig=/actor/config", "get", "namespace", "sicore-test", "-o", "name"]);
  });
});
