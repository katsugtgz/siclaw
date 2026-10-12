import { describe, it, expect, vi } from "vitest";
const { spawnAsync } = vi.hoisted(() => ({ spawnAsync: vi.fn() }));
vi.mock("./exec-utils.js", async importOriginal => ({ ...(await importOriginal<object>()), spawnAsync }));
import { ensureDebugNamespace } from "./debug-pod.js";

describe("pre-provisioned native diagnostic namespace", () => {
  const env = { kubeconfigPath: "/private/actor-config", kubeconfigArgs: ["--kubeconfig=/private/actor-config"], childEnv: {} };
  it("checks the selected namespace with GET and never requests namespace creation", async () => {
    spawnAsync.mockResolvedValueOnce({ stdout: "namespace/sicore-test", stderr: "" });
    await ensureDebugNamespace("sicore-test", env, 1000, true);
    expect(spawnAsync).toHaveBeenLastCalledWith("kubectl",
      ["--kubeconfig=/private/actor-config", "get", "namespace", "sicore-test", "-o", "name"], 1000, {});
  });
  it("fails when the prepared namespace cannot be read, without falling back to CREATE", async () => {
    spawnAsync.mockClear(); spawnAsync.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(ensureDebugNamespace("sicore-test", env, 1000, true)).rejects.toThrow("Forbidden");
    expect(spawnAsync).toHaveBeenCalledTimes(1);
  });
  it("retains the existing default namespace provisioning behavior", async () => {
    spawnAsync.mockResolvedValueOnce({ stdout: "created", stderr: "" });
    await ensureDebugNamespace("legacy-debug", env, 1000);
    expect(spawnAsync).toHaveBeenLastCalledWith("kubectl",
      ["--kubeconfig=/private/actor-config", "create", "namespace", "legacy-debug"], 1000, {});
  });
});
