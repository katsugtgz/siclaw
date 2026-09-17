import { describe, expect, it, vi } from "vitest";
import { CapabilityImageUpgrade } from "./image-upgrade.js";
import type { CapabilityRunRecord } from "./run-manager.js";

function fixture() {
  const run = { runId: "run", profile: "kb-compile", status: "idle" } as CapabilityRunRecord;
  let current: CapabilityRunRecord | undefined = run;
  const deps = {
    current: () => current,
    outdated: vi.fn(async () => true),
    admission: vi.fn(async () => ({ version: 1, run_id: "run", allowed: true, continuation: true })),
    prepare: vi.fn(async () => ({ version: 1, run_id: "run", state: "ready" })),
    checkpoint: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    complete: vi.fn(async () => { current = undefined; }),
  };
  return { run, deps, upgrade: new CapabilityImageUpgrade(deps), forget: () => { current = undefined; } };
}

describe("quiescent compiler image upgrade", () => {
  it("preserves running tasks and matching images", async () => {
    const { run, deps, upgrade } = fixture();
    run.status = "running";
    await upgrade.check(run);
    expect(deps.outdated).not.toHaveBeenCalled();
    run.status = "idle";
    deps.outdated.mockResolvedValue(false);
    await upgrade.check(run);
    expect(deps.prepare).not.toHaveBeenCalled();
  });
  it("waits for active background work instead of trusting Runtime idle", async () => {
    const { run, deps, upgrade } = fixture();
    deps.prepare.mockResolvedValue({ version: 1, run_id: "run", state: "busy" });
    await upgrade.check(run);
    expect(deps.stop).not.toHaveBeenCalled();
    deps.prepare.mockResolvedValue({ version: 1, run_id: "run", state: "ready" });
    await upgrade.check(run);
    expect(deps.stop).toHaveBeenCalledOnce();
    expect(deps.complete).toHaveBeenCalledWith(run, true);
  });
  it("does not retire an unsupported box or rejected consumer operation", async () => {
    const { run, deps, upgrade } = fixture();
    deps.admission.mockResolvedValue({ version: 1, run_id: "run", allowed: false, continuation: false });
    await upgrade.check(run);
    expect(deps.prepare).not.toHaveBeenCalled();
    deps.admission.mockResolvedValue({ version: 1, run_id: "run", allowed: true, continuation: false });
    deps.prepare.mockRejectedValue(new Error("unsupported handshake"));
    await expect(upgrade.check(run)).rejects.toThrow();
    expect(deps.stop).not.toHaveBeenCalled();
    expect(upgrade.ownsRetirement("run")).toBe(false);
  });
  it("never claims continuation after an unconfirmed stop and retries cleanup", async () => {
    const { run, deps, upgrade } = fixture();
    deps.stop.mockRejectedValueOnce(new Error("delete not confirmed"));
    await expect(upgrade.check(run)).rejects.toThrow();
    expect(upgrade.ownsRetirement("run")).toBe(true);
    expect(deps.complete).not.toHaveBeenCalled();
    await upgrade.check(run);
    expect(deps.prepare).toHaveBeenCalledOnce();
    expect(deps.complete).toHaveBeenCalledOnce();
    expect(upgrade.ownsRetirement("run")).toBe(false);
  });
  it("does not override a user cancellation during preparation", async () => {
    const { run, deps, upgrade, forget } = fixture();
    deps.prepare.mockImplementation(async () => {
      forget();
      return { version: 1, run_id: "run", state: "ready" };
    });
    await upgrade.check(run);
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });
  it("closes finished operations without starting another compile", async () => {
    const { run, deps, upgrade } = fixture();
    deps.admission.mockResolvedValue({ version: 1, run_id: "run", allowed: true, continuation: false });
    await upgrade.check(run);
    expect(deps.complete).toHaveBeenCalledWith(run, false);
  });
  it("replays durable retirement after Runtime restart, even when the old box is gone", async () => {
    const { run, deps, upgrade } = fixture();
    run.imageUpgradePending = true;
    deps.outdated.mockResolvedValue(false);
    await upgrade.check(run);
    expect(deps.admission).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.stop).toHaveBeenCalledOnce();
    expect(deps.complete).toHaveBeenCalledWith(run, true);
  });
  it("retains the prepared box until retirement intent is durable", async () => {
    const { run, deps, upgrade } = fixture();
    deps.checkpoint.mockRejectedValueOnce(new Error("store unavailable"));
    await expect(upgrade.check(run)).rejects.toThrow();
    expect(deps.stop).not.toHaveBeenCalled();
    await upgrade.check(run);
    expect(deps.prepare).toHaveBeenCalledOnce();
    expect(deps.stop).toHaveBeenCalledOnce();
  });
  it("does not overwrite a terminal user stop whose persistence is still retrying", async () => {
    const { run, deps, upgrade } = fixture();
    deps.prepare.mockImplementation(async () => {
      run.status = "done";
      return { version: 1, run_id: "run", state: "ready" };
    });
    await upgrade.check(run);
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });
});
