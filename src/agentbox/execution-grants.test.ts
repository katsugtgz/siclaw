import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoxExecutionGrants } from "./execution-grants.js";

describe("immutable box execution authorization", () => {
  const roots: string[] = []; const managers: BoxExecutionGrants[] = [];
  afterEach(() => { for (const manager of managers.splice(0)) manager.close(); vi.useRealTimers();vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
  const actor = { kind: "binding" as const, id: "b" };
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-grant-test-")); roots.push(root);
    const gateway = { renewExecutionGrant: vi.fn().mockResolvedValue({ ok: true, remainingMs: 60000,
      identity: actor, sender: { userId: "alice" }, sessionId: "s" }),
      forExecutionGrant: vi.fn().mockReturnValue({ toClientLike: () => ({ request: vi.fn() }) }) };
    const manager = new BoxExecutionGrants(gateway as any, root); managers.push(manager); return { gateway, manager };
  }
  it("isolates credential caches and freezes the original sender", async () => {
    const { manager, gateway } = fixture();
    const first = await manager.accept("grant-a", "s", actor);
    gateway.renewExecutionGrant.mockResolvedValue({ ok: true, remainingMs: 60000, identity: actor, sender: { userId: "bob" }, sessionId: "s" });
    const second = await manager.accept("grant-b", "s", actor);
    expect(first.credentialsDir).not.toBe(second.credentialsDir);
    expect(first.sender?.userId).toBe("alice"); expect(second.sender?.userId).toBe("bob");
  });
  it("expires locally even while a renewal HTTP call is hung", async () => {
    vi.useFakeTimers(); const { manager, gateway } = fixture();
    const grant = await manager.accept("grant-a", "s", actor);
    const cancel = vi.fn(); grant.onEnd.add(cancel); grant.busy.add(() => true);
    gateway.renewExecutionGrant.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(60001);
    expect(grant.ended).toBe(true); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("rejects an already elapsed initial confirmation before creating a broker", async () => {
    vi.useFakeTimers();
    const { manager, gateway } = fixture();
    let resolve!: (value: { ok: boolean; remainingMs: number; identity: typeof actor; sessionId: string }) => void;
    gateway.renewExecutionGrant.mockImplementation(() => new Promise(yes => { resolve = yes; }));
    const accepting = manager.accept("delayed-grant", "s", actor);
    const rejected = expect(accepting).rejects.toThrow(/unavailable|expired/);
    await vi.advanceTimersByTimeAsync(60_001);
    resolve({ ok: true, remainingMs: 60_000, identity: actor, sessionId: "s" });
    await rejected;
    expect(gateway.forExecutionGrant).not.toHaveBeenCalled();
  });
  it.each(["close", "revoke"] as const)("does not materialize a pending admission after %s", async action => {
    const { manager, gateway } = fixture();
    let resolve!: (value: { ok: boolean; remainingMs: number; identity: typeof actor; sessionId: string }) => void;
    gateway.renewExecutionGrant.mockImplementation(() => new Promise(yes => { resolve = yes; }));
    const accepting = manager.accept("pending-grant", "s", actor);
    const rejected = expect(accepting).rejects.toThrow(/ended|closed|cancelled/);
    if (action === "close") manager.close(); else manager.revoke(["pending-grant"]);
    resolve({ ok: true, remainingMs: 60_000, identity: actor, sessionId: "s" });
    await rejected;
    expect(gateway.forExecutionGrant).not.toHaveBeenCalled();
  });
  it("refuses a fresh admission after the manager has been closed", async () => {
    const { manager, gateway } = fixture(); manager.close();
    await expect(manager.accept("after-close", "s", actor)).rejects.toThrow(/closed|ended/);
    expect(gateway.renewExecutionGrant).not.toHaveBeenCalled();
  });
  it("captures required policy enforcement before awaiting a confirmation", async () => {
    const { manager, gateway } = fixture();
    let resolve!: (value: { ok: boolean; remainingMs: number; identity: typeof actor; sessionId: string }) => void;
    gateway.renewExecutionGrant.mockImplementation(() => new Promise(yes => { resolve = yes; }));
    const expected = { ...actor, policyRequired: true };
    const admission = manager.accept("policy-required", "s", expected);
    const refused = expect(admission).rejects.toThrow(/Required.*policy/);
    expected.policyRequired = false;
    resolve({ ok: true, remainingMs: 60_000, identity: actor, sessionId: "s" });
    await refused;
    expect(gateway.forExecutionGrant).not.toHaveBeenCalled();
  });
  it("checks policy requirements for each caller sharing a pending confirmation", async () => {
    const { manager, gateway } = fixture();
    let resolve!: (value: { ok: boolean; remainingMs: number; identity: typeof actor; sessionId: string }) => void;
    gateway.renewExecutionGrant.mockImplementation(() => new Promise(yes => { resolve = yes; }));
    const ordinary = manager.accept("shared-pending", "s", actor);
    const required = manager.accept("shared-pending", "s", { ...actor, policyRequired: true });
    const denied = expect(required).rejects.toThrow(/Required.*policy/);
    resolve({ ok: true, remainingMs: 60_000, identity: actor, sessionId: "s" });
    expect((await ordinary).ended).toBe(false); await denied;
    expect(gateway.renewExecutionGrant).toHaveBeenCalledTimes(1);
  });
  it.each([60_001, 3_600_000, Number.MAX_SAFE_INTEGER + 1, 1.5, 0, -1, NaN, Infinity])(
    "refuses an invalid remaining lease %s before materializing credentials", async remainingMs => {
      const { manager, gateway } = fixture();
      gateway.renewExecutionGrant.mockResolvedValue({ ok: true, remainingMs, identity: actor, sessionId: "s", sender: { userId: "alice" } });
      await expect(manager.accept("invalid-lease", "s", actor)).rejects.toThrow(/unavailable|misbound/);
      expect(gateway.forExecutionGrant).not.toHaveBeenCalled();
    });
  it("never extends an old holder on an oversized renewal and cancels all owned work on expiry", async () => {
    vi.useFakeTimers();
    const { manager, gateway } = fixture();
    const grant = await manager.accept("bounded-grant", "s", actor);
    const deadline = grant.deadline;
    const parentCancel = vi.fn(), childCancel = vi.fn();
    grant.onEnd.add(parentCancel); grant.onEnd.add(childCancel); grant.busy.add(() => true);
    gateway.renewExecutionGrant.mockResolvedValue({ ok: true, remainingMs: 3_600_000, identity: actor, sessionId: "s", sender: { userId: "alice" } });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(grant.deadline).toBe(deadline);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(grant.ended).toBe(true);
    expect(parentCancel).toHaveBeenCalledTimes(1); expect(childCancel).toHaveBeenCalledTimes(1);
  });
  it("ends owned work immediately on authoritative revocation", async () => {
    vi.useFakeTimers(); const { manager, gateway } = fixture();
    const grant = await manager.accept("grant-a", "s", actor); const cancel = vi.fn();
    grant.onEnd.add(cancel); grant.busy.add(() => true);
    gateway.renewExecutionGrant.mockResolvedValue({ ok: false, reason: "revoked" });
    await vi.advanceTimersByTimeAsync(30001);
    expect(grant.ended).toBe(true); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("fresh dispatch never resurrects expired holders or reuses their directory", async () => {
    vi.useFakeTimers(); const { manager } = fixture();
    const old = await manager.accept("grant-a", "s", actor);
    await vi.advanceTimersByTimeAsync(60001);
    const fresh = await manager.accept("grant-a", "s", actor);
    expect(old.ended).toBe(true); expect(fresh.ended).toBe(false);
    expect(fresh).not.toBe(old); expect(fresh.credentialsDir).not.toBe(old.credentialsDir);
  });
  it("rejects identity/session substitutions before materializing credentials", async () => {
    const { manager } = fixture();
    await expect(manager.accept("grant-a", "other", actor)).rejects.toThrow();
    await expect(manager.accept("grant-b", "s", { kind: "user", id: "admin" })).rejects.toThrow();
  });
  it("keeps every local grant ancestor private when credential groups are unavailable",async()=>{
    const {manager}=fixture();const grant=await manager.accept("mode-grant","s",actor);
    for(const directory of [path.dirname(path.dirname(grant.credentialsDir)),path.dirname(grant.credentialsDir),grant.credentialsDir]){
      expect(fs.lstatSync(directory).mode&0o007).toBe(0);
      expect([0o700,0o710]).toContain(fs.lstatSync(directory).mode&0o777);
    }
  });
  it("refuses symlinked grant directories instead of changing another tree's permissions",async()=>{
    const {manager}=fixture();const grant=await manager.accept("seed","s",actor);
    const root=path.dirname(path.dirname(grant.credentialsDir));
    const other=fs.mkdtempSync(path.join(os.tmpdir(),"siclaw-other-owner-"));roots.push(other);
    fs.symlinkSync(other,path.join(root,"symlink"));const before=fs.statSync(other).mode;
    await expect(manager.accept("symlink","s",actor)).rejects.toThrow("Unsafe execution credential directory");
    expect(fs.statSync(other).mode).toBe(before);
  });
});
