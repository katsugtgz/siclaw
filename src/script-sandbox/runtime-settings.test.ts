import { describe, expect, it, vi } from "vitest";
import { ScriptSandboxRuntimeSettings, parseRuntimeSandboxSettings } from "./runtime-settings.js";
import { loadScriptSandboxConfig } from "./config.js";

describe("control-plane sandbox settings", () => {
  it("reads a payload that has never carried the key as closed, not as unconfigured", () => {
    // An older control plane answers config.getRuntimeConfig without this key.
    // Treating that as "keep whatever the pod was deployed with" would reopen
    // the deployment flag as a user-facing switch behind the operator's back.
    expect(parseRuntimeSandboxSettings({})).toEqual({ enabled: false });
    expect(parseRuntimeSandboxSettings({ script_sandbox: null })).toEqual({ enabled: false });
  });

  it("rejects a malformed switch instead of reading it as false", () => {
    // "enabled": "true" is a control-plane bug, and silently closing would send
    // the operator looking at the wrong side.
    expect(() => parseRuntimeSandboxSettings({ script_sandbox: { enabled: "true" } })).toThrow();
    expect(() => parseRuntimeSandboxSettings(null)).toThrow();
  });

  it("ignores a runner image an older control plane still sends", () => {
    // The image comes from this Runtime's own release now. A control plane that
    // still carries one must not be able to repoint a runner — that is exactly
    // the state (upgraded Runtime, stale console value) this move was about.
    for (const image of ["reg.example/r:1", "", "   ", 42]) {
      expect(parseRuntimeSandboxSettings({ script_sandbox: { enabled: true, image } })).toEqual({ enabled: true });
    }
  });

  it("stays closed while the control plane has never answered", async () => {
    const source = { request: vi.fn().mockRejectedValue(new Error("unreachable")) };
    const settings = new ScriptSandboxRuntimeSettings(source);
    expect(settings.primed).toBe(false);
    expect(await settings.ensureFresh()).toEqual({ enabled: false });
    expect(settings.get().enabled).toBe(false);
  });

  it("keeps the last answer when the control plane goes away, rather than closing mid-flight", async () => {
    let now = 1_000;
    const source = { request: vi.fn().mockResolvedValueOnce({ script_sandbox: { enabled: true } })
      .mockRejectedValue(new Error("unreachable")) };
    const settings = new ScriptSandboxRuntimeSettings(source, 15_000, () => now);
    expect(await settings.ensureFresh()).toEqual({ enabled: true });

    now += 20_000;
    expect(await settings.ensureFresh()).toEqual({ enabled: true });
    expect(source.request).toHaveBeenCalledTimes(2);
  });

  it("backs off for a TTL after a failure, so a dead control plane is not redialled per call", async () => {
    let now = 1_000;
    const source = { request: vi.fn().mockRejectedValue(new Error("unreachable")) };
    const settings = new ScriptSandboxRuntimeSettings(source, 15_000, () => now);
    await settings.ensureFresh();
    await settings.ensureFresh();
    expect(source.request).toHaveBeenCalledTimes(1);

    now += 20_000;
    await settings.ensureFresh();
    expect(source.request).toHaveBeenCalledTimes(2);
  });

  it("reports a change once, not once per poll", async () => {
    // Flipping the switch in the console must leave a trace on this side: runner
    // Pods are per-run, so a Runtime that disagrees with the console is otherwise
    // indistinguishable from one that agrees.
    let now = 1_000, enabled = false;
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const source = { request: vi.fn(async () => ({ script_sandbox: { enabled } })) };
    const settings = new ScriptSandboxRuntimeSettings(source, 15_000, () => now);
    await settings.ensureFresh();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("CLOSED");

    now += 20_000;
    await settings.ensureFresh();
    expect(log).toHaveBeenCalledTimes(1);

    enabled = true; now += 20_000;
    await settings.ensureFresh();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toContain("OPEN");
  });

  it("serves one refresh to concurrent callers", async () => {
    let release: (v: unknown) => void = () => {};
    const source = { request: vi.fn(() => new Promise(r => { release = r; })) };
    const settings = new ScriptSandboxRuntimeSettings(source);
    const both = Promise.all([settings.ensureFresh(), settings.ensureFresh()]);
    release({ script_sandbox: { enabled: true } });
    expect(await both).toEqual([{ enabled: true }, { enabled: true }]);
    expect(source.request).toHaveBeenCalledTimes(1);
  });
});

describe("deployment flag and control-plane switch together", () => {
  const provisioned = { SICLAW_SCRIPT_SANDBOX_PROVISIONED: "true", SICLAW_SCRIPT_SANDBOX_IMAGE: "reg/deployed:1" };
  const settings = (value: { enabled: boolean }) => ({ get: () => value });

  it("stays closed when the infrastructure exists but the control plane has not opened it", () => {
    expect(loadScriptSandboxConfig(provisioned, settings({ enabled: false }))).toMatchObject({ provisioned: true, enabled: false });
  });

  it("stays closed when the control plane opens a Runtime that was never provisioned", () => {
    // Opening it here would hand Agents a run_script whose every call dies on a
    // missing namespace and RBAC — a broken tool is worse than an absent one.
    expect(loadScriptSandboxConfig({}, settings({ enabled: true }))).toMatchObject({ provisioned: false, enabled: false });
  });

  it("opens only when both agree", () => {
    expect(loadScriptSandboxConfig(provisioned, settings({ enabled: true })).enabled).toBe(true);
  });

  it("takes the runner image from the deployment, which helm derives from the release", () => {
    // SICLAW_SCRIPT_SANDBOX_IMAGE is {registry}/siclaw-script-sandbox:{tag}
    // unless scriptSandbox.image overrides it. The control plane has no say —
    // that is what keeps an upgraded Runtime off a runner pinned months ago.
    expect(loadScriptSandboxConfig(provisioned, settings({ enabled: true })).image).toBe("reg/deployed:1");
  });

  it("reports closed when the deployment supplied no runner image", () => {
    // Only reachable by overriding scriptSandbox.image with an empty value:
    // every run would fail at Job creation, so report it closed instead.
    const config = loadScriptSandboxConfig({ SICLAW_SCRIPT_SANDBOX_PROVISIONED: "true" }, settings({ enabled: true }));
    expect(config).toMatchObject({ provisioned: true, enabled: false, image: "" });
  });

  it("re-reads the switch on every access, so flipping it needs no restart", () => {
    let live = { enabled: false };
    const config = loadScriptSandboxConfig(provisioned, { get: () => live });
    expect(config.enabled).toBe(false);
    live = { enabled: true };
    expect(config.enabled).toBe(true);
    expect(config.image).toBe("reg/deployed:1");
  });

  it("keeps the legacy deployment flag provisioning an already-deployed values file", () => {
    expect(loadScriptSandboxConfig({ SICLAW_SCRIPT_SANDBOX_ENABLED: "true", SICLAW_SCRIPT_SANDBOX_IMAGE: "reg/old:1" },
      settings({ enabled: true })).enabled).toBe(true);
  });
});
