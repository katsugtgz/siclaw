import { describe, expect, it } from "vitest";
import { ExecutionGrantRegistry, grantAllows, resourceFingerprint, type GrantResources } from "./execution-grants.js";
import { CredentialService, CredentialNotFoundError, SessionOwnershipError } from "./credential-service.js";
import { userIdentity } from "../shared/execution-identity.js";

function fixture(initial: Record<string, GrantResources>) {
  const perms = { ...initial };
  let clock = 1_000_000;
  let unreachable = false;
  const registry = new ExecutionGrantRegistry(async (_agent, actor) => {
    if (unreachable) throw new Error("control plane unreachable");
    return perms[actor.id] ?? { clusters: [], hosts: [] };
  }, { leaseMs: 60_000, now: () => clock });
  return {
    registry, perms,
    advance: (ms: number) => { clock += ms; },
    setUnreachable: (v: boolean) => { unreachable = v; },
  };
}

describe("execution grants", () => {
  it("reuses a caller's grant while nothing changed, and issues a new one when their resources do", async () => {
    const f = fixture({ alice: { clusters: ["A"], hosts: [] } });
    const first = await f.registry.open("agent", "s1", "alice");
    expect((await f.registry.open("agent", "s1", "alice")).grantId).toBe(first.grantId);

    f.perms.alice = { clusters: ["A", "B"], hosts: [] };
    const second = await f.registry.open("agent", "s1", "alice");
    expect(second.grantId).not.toBe(first.grantId);
    expect(second.resources.clusters).toEqual(["A", "B"]);
    // Nothing is narrowed or widened in place.
    expect(first.resources.clusters).toEqual(["A"]);
  });

  it("gives another caller in the same session their own grant, and leaves the first one running", async () => {
    // A low-privileged speaker's background job must keep ITS permissions after a
    // higher-privileged speaker takes the next turn — and vice versa.
    const f = fixture({ low: { clusters: ["A"], hosts: [] }, high: { clusters: ["A", "B"], hosts: ["h1"] } });
    const low = await f.registry.open("agent", "group", "low");
    const high = await f.registry.open("agent", "group", "high");
    expect(high.grantId).not.toBe(low.grantId);
    const lowCheck = f.registry.check(low.grantId, "agent");
    expect(lowCheck.ok && lowCheck.grant.actorUserId).toBe("low");
    expect(lowCheck.ok && grantAllows(lowCheck.grant, "cluster", "B")).toBe(false);
  });

  it("revokes on renewal when ANY granted resource is gone, even though others remain", async () => {
    const f = fixture({ alice: { clusters: ["A", "B"], hosts: [] } });
    const grant = await f.registry.open("agent", "s1", "alice");
    f.perms.alice = { clusters: ["A"], hosts: [] };
    expect(await f.registry.renew(grant.grantId, "agent")).toEqual({ ok: false, reason: "revoked" });
    expect(f.registry.check(grant.grantId, "agent")).toEqual({ ok: false, reason: "revoked" });
    // The next turn gets exactly what alice holds now.
    const next = await f.registry.open("agent", "s1", "alice");
    expect(next.resources.clusters).toEqual(["A"]);
  });

  it("tells the box how long a grant still holds, which an unreachable control plane does not reset", async () => {
    const f = fixture({ alice: { clusters: ["A"], hosts: [] } });
    const grant = await f.registry.open("agent", "s1", "alice");
    f.advance(40_000);
    f.setUnreachable(true);
    const renewed = await f.registry.renew(grant.grantId, "agent");
    expect(renewed.ok && f.registry.remainingMs(renewed.grant)).toBe(20_000);
    f.setUnreachable(false);
    const confirmed = await f.registry.renew(grant.grantId, "agent");
    expect(confirmed.ok && f.registry.remainingMs(confirmed.grant)).toBe(60_000);
  });

  it("extends only on a full re-check, and lapses when the control plane cannot answer", async () => {
    const f = fixture({ alice: { clusters: ["A"], hosts: [] } });
    const grant = await f.registry.open("agent", "s1", "alice");
    const issued = grant.deadline;
    f.advance(30_000);
    const renewed = await f.registry.renew(grant.grantId, "agent");
    expect(renewed.ok && renewed.grant.deadline).toBe(issued + 30_000);

    f.setUnreachable(true);
    f.advance(30_000);
    const blind = await f.registry.renew(grant.grantId, "agent");
    expect(blind.ok && blind.grant.deadline).toBe(issued + 30_000);
    f.advance(30_001);
    expect(f.registry.check(grant.grantId, "agent")).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses an unknown grant and one presented by another agent's box", async () => {
    const f = fixture({ alice: { clusters: ["A"], hosts: [] } });
    const grant = await f.registry.open("agent", "s1", "alice");
    expect(f.registry.check("nope", "agent")).toEqual({ ok: false, reason: "unknown" });
    expect(f.registry.check(grant.grantId, "other-agent")).toEqual({ ok: false, reason: "agent_mismatch" });
  });

  it("revokes every grant of a caller on push", async () => {
    const f = fixture({ alice: { clusters: ["A"], hosts: [] } });
    const a = await f.registry.open("agent", "s1", "alice");
    const b = await f.registry.open("agent", "s2", "alice");
    expect(f.registry.revokeActor("alice").map((g) => g.grantId).sort()).toEqual([a.grantId, b.grantId].sort());
    expect(f.registry.check(a.grantId, "agent").ok).toBe(false);
  });

  it("fingerprints a resource SET, independent of order and duplicates", () => {
    expect(resourceFingerprint({ clusters: ["B", "A", "A"], hosts: [] }))
      .toBe(resourceFingerprint({ clusters: ["A", "B"], hosts: [] }));
  });
});

describe("hosts addressed by id", () => {
  // host_list hands the model a host's id; the box then asks for the host by it.
  const resources: GrantResources = {
    clusters: [], hosts: ["h1"], hostIds: { "id-h1": "h1", "id-h2": "h2" },
  };
  it("allows a granted host by its id as well as its name", async () => {
    const grant = await new ExecutionGrantRegistry(async () => resources).open("agent", "s", "u");
    expect(grantAllows(grant, "host", "h1")).toBe(true);
    expect(grantAllows(grant, "host", "id-h1")).toBe(true);
  });

  it("grants nothing through an alias alone", async () => {
    const grant = await new ExecutionGrantRegistry(async () => resources).open("agent", "s", "u");
    // The alias maps to h2, which is not granted.
    expect(grantAllows(grant, "host", "id-h2")).toBe(false);
    for (const probe of ["constructor", "__proto__", "toString", "unknown-id"]) {
      expect(grantAllows(grant, "host", probe), probe).toBe(false);
    }
  });

  it("does not change a grant's identity: ids are spelling, not substance", () => {
    expect(resourceFingerprint(resources)).toBe(resourceFingerprint({ clusters: [], hosts: ["h1"] }));
  });
});

describe("credential service under a grant", () => {
  function service(perms: Record<string, GrantResources>) {
    const calls: Array<{ method: string; params: any }> = [];
    const frontend = {
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "credential.list") {
          return params.kind === "cluster"
            ? { clusters: [{ name: "A" }, { name: "B" }] }
            : { hosts: [{ name: "h1" }, { name: "h2" }] };
        }
        return { credential: { name: params.source_id, type: "kubeconfig", files: [] } };
      },
    };
    // The session registry says the session belongs to the channel's creator.
    const sessions = { get: async () => ({ userId: "channel-creator", agentId: "agent" }) };
    const svc = new CredentialService(frontend as any, sessions as any);
    const registry = new ExecutionGrantRegistry(async (_a, actor) => perms[actor.id] ?? { clusters: [], hosts: [] });
    svc.attachGrants(registry);
    return { svc, registry, calls };
  }

  it("asks the control plane as the grant's caller, not as the session's owner", async () => {
    const { svc, registry, calls } = service({ member: { clusters: ["A"], hosts: [] } });
    const grant = await registry.open("agent", "group", "member");
    await svc.getClusterCredential({ agentId: "agent", sessionId: "group", grantId: grant.grantId }, "A", "");
    expect(calls.at(-1)).toMatchObject({ method: "credential.get", params: { userId: "member", source_id: "A" } });
  });

  it("refuses a resource outside the grant before the control plane is asked", async () => {
    const { svc, registry, calls } = service({ member: { clusters: ["A"], hosts: [] } });
    const grant = await registry.open("agent", "group", "member");
    const before = calls.length;
    await expect(svc.getClusterCredential({ agentId: "agent", grantId: grant.grantId }, "B", ""))
      .rejects.toBeInstanceOf(CredentialNotFoundError);
    await expect(svc.getHostCredential({ agentId: "agent", grantId: grant.grantId }, "h1", ""))
      .rejects.toBeInstanceOf(CredentialNotFoundError);
    expect(calls.length).toBe(before);
  });

  it("lists only what the grant holds", async () => {
    const { svc, registry } = service({ member: { clusters: ["A"], hosts: ["h2"] } });
    const grant = await registry.open("agent", "group", "member");
    const id = { agentId: "agent", grantId: grant.grantId };
    expect((await svc.listClusters(id)).map((c) => c.name)).toEqual(["A"]);
    expect((await svc.listHosts(id)).map((h) => h.name)).toEqual(["h2"]);
  });

  it("gives a request that names no grant nothing — not the agent's whole binding", async () => {
    // A box that predates grants (a pod not yet recycled after an upgrade) sends none;
    // the legacy path would resolve it to an empty user, i.e. every member's resources.
    const { svc, calls } = service({ member: { clusters: ["A"], hosts: ["h1"] } });
    const ungranted = { agentId: "agent", sessionId: "group" };
    expect(await svc.listClusters(ungranted)).toEqual([]);
    expect(await svc.listHosts(ungranted)).toEqual([]);
    expect((await svc.queryHosts(ungranted, "")).hosts).toEqual([]);
    await expect(svc.getClusterCredential(ungranted, "A", "")).rejects.toBeInstanceOf(SessionOwnershipError);
    await expect(svc.getHostCredential(ungranted, "h1", "")).rejects.toBeInstanceOf(SessionOwnershipError);
    expect(calls).toEqual([]);
  });

  it("keeps paging a host search when the grant filtered a page", async () => {
    const { svc, registry } = service({ member: { clusters: [], hosts: ["h2"] } });
    const grant = await registry.open("agent", "group", "member");
    (svc as any).frontendClient = {
      request: async () => ({ hosts: [{ name: "h1" }, { name: "h2" }], total: 5, next_cursor: "page-2" }),
    };
    const page = await svc.queryHosts({ agentId: "agent", grantId: grant.grantId }, "");
    expect(page.hosts.map((h) => h.name)).toEqual(["h2"]);
    expect(page.next_cursor).toBe("page-2");
    expect(page.total).toBe(4);
  });

  it("refuses a grant that is unknown, expired or another agent's", async () => {
    const { svc, registry } = service({ member: { clusters: ["A"], hosts: [] } });
    const grant = await registry.open("agent", "group", "member");
    await expect(svc.listClusters({ agentId: "agent", grantId: "forged" })).rejects.toBeInstanceOf(SessionOwnershipError);
    await expect(svc.listClusters({ agentId: "other", grantId: grant.grantId })).rejects.toBeInstanceOf(SessionOwnershipError);
  });
});

describe("a grant resolved from the control plane", () => {
  it("serves a host asked for by the id host_list showed", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const frontend = {
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "credential.list") {
          return params.kind === "cluster"
            ? { clusters: [] }
            : { hosts: [{ id: "9e7d", name: "nodepool-062" }, { id: "d98c", name: "nodepool-061" }] };
        }
        return { credential: { name: params.source_id, type: "ssh", files: [] } };
      },
    };
    const svc = new CredentialService(frontend as any, { get: async () => null } as any);
    const registry = new ExecutionGrantRegistry((agent, actor) => svc.resolveActorResources(agent, actor));
    svc.attachGrants(registry);
    const grant = await registry.open("agent", "s", "owner");
    await svc.getHostCredential({ agentId: "agent", grantId: grant.grantId }, "d98c", "");
    expect(calls.at(-1)).toMatchObject({ method: "credential.get", params: { source: "host", source_id: "d98c" } });
    await expect(svc.getHostCredential({ agentId: "agent", grantId: grant.grantId }, "not-a-host", ""))
      .rejects.toBeInstanceOf(CredentialNotFoundError);
  });
});


describe("execution grants keyed by identity (design 2026-09-25 §5.2)", () => {
  it("keys a grant on kind AND id: a person and a group binding sharing an id get different grants", async () => {
    const f = fixture({ x: { clusters: ["A"], hosts: [] } });
    const asUser = await f.registry.open("agent", "s1", { kind: "user", id: "x" });
    const asBinding = await f.registry.open("agent", "s1", { kind: "binding", id: "x" });
    expect(asBinding.grantId).not.toBe(asUser.grantId);
    expect(asUser.actor).toEqual({ kind: "user", id: "x" });
    expect(asUser.actorUserId).toBe("x");
    // A binding is nobody: the legacy user field stays empty so an older control plane resolves no one.
    expect(asBinding.actor).toEqual({ kind: "binding", id: "x" });
    expect(asBinding.actorUserId).toBe("");
    // And a bare user id still means that person.
    expect((await f.registry.open("agent", "s1", "x")).grantId).toBe(asUser.grantId);
  });

  it("issues a `none` grant without asking the control plane, empty, and keeps it active across renewals", async () => {
    let asked = 0;
    const registry = new ExecutionGrantRegistry(async () => { asked++; return { clusters: ["A"], hosts: ["h"] }; }, { leaseMs: 60_000 });
    const grant = await registry.open("agent", "s1", { kind: "none", id: "", reason: "unbound" });
    expect(asked).toBe(0);
    expect(grant.resources).toEqual({ clusters: [], hosts: [] });
    expect(grant.actor).toEqual({ kind: "none", id: "", reason: "unbound" });
    expect(grantAllows(grant, "cluster", "A")).toBe(false);
    // An empty grant re-checked against an empty answer is still active — never "revoked".
    const renewed = await registry.renew(grant.grantId, "agent");
    expect(renewed.ok).toBe(true);
    expect(asked).toBe(0);
    // And the next `none` turn in the session reuses it: the slot/uid model still applies.
    expect((await registry.open("agent", "s1", { kind: "none", id: "" })).grantId).toBe(grant.grantId);
  });

  it("still refuses an identified kind with no id", async () => {
    const f = fixture({});
    await expect(f.registry.open("agent", "s1", { kind: "binding", id: "" })).rejects.toThrow(/needs agent, session and actor/);
    await expect(f.registry.open("agent", "s1", "")).rejects.toThrow(/needs agent, session and actor/);
  });

  it("revokes by identity, so revoking the person x leaves the binding x running", async () => {
    const f = fixture({ x: { clusters: ["A"], hosts: [] } });
    const asUser = await f.registry.open("agent", "s1", userIdentity("x"));
    const asBinding = await f.registry.open("agent", "s1", { kind: "binding", id: "x" });
    expect(f.registry.revokeActor(userIdentity("x")).map((g) => g.grantId)).toEqual([asUser.grantId]);
    expect(f.registry.check(asBinding.grantId, "agent").ok).toBe(true);
    expect(f.registry.check(asUser.grantId, "agent")).toEqual({ ok: false, reason: "revoked" });
  });
});

describe("execution grants record the turn's sender", () => {
  // A group's turns all run as `binding:<id>` and share one grant; what a
  // scheduled task needs is the PERSON behind the turn that creates it
  // (design 2026-09-25 §3 "定时任务"). Turns of a session are serialized, so the
  // sender of the latest open is the running turn's.
  const group = { kind: "binding" as const, id: "bind-1" };

  it("freezes an old sender when another speaker opens the group's next turn", async () => {
    const f = fixture({ "bind-1": { clusters: ["A"], hosts: [] } });
    const first = await f.registry.open("agent", "s1", group, { userId: "u-a", openId: "ou_a" });
    expect(first.sender).toEqual({ userId: "u-a", openId: "ou_a" });
    const second = await f.registry.open("agent", "s1", group, { openId: "ou_b" });
    expect(second.grantId).not.toBe(first.grantId);
    expect(second.sender).toEqual({ openId: "ou_b" });
    const third = await f.registry.open("agent", "s1", group);
    expect(third.grantId).not.toBe(first.grantId);
    expect(third.grantId).not.toBe(second.grantId);
    expect(third.sender).toBeUndefined();
    expect(first.sender).toEqual({ userId: "u-a", openId: "ou_a" });
    expect(second.sender).toEqual({ openId: "ou_b" });
  });

  it("drops empty fields rather than recording a sender that names nobody", async () => {
    const f = fixture({});
    const grant = await f.registry.open("agent", "s1", { kind: "none", id: "" }, { userId: " ", openId: "" });
    expect(grant.sender).toBeUndefined();
  });
});
