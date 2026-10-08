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
