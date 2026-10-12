/**
 * Execution grants: which resources ONE turn's caller may use, and until when.
 *
 * Several users' sessions share one box, and in a channel several people share
 * one session. The identity a box request acts for therefore cannot come from
 * the box, nor from the session row (that is audit attribution — in a channel it
 * is whoever created the binding, not whoever is speaking). It comes from here:
 * the Runtime records, at dispatch, the EXECUTION IDENTITY the control plane
 * named for this turn (a person, a group binding, a guest policy, or `none` —
 * shared/execution-identity.ts) and the resources it may use, and every later
 * credential request the box makes is resolved against that record.
 *
 * Contracts (design: docs/design/2026-09-24-agentbox-session-isolation.zh-CN.md §3.2, §6.5):
 *
 * - A grant's actor and resource set are FIXED when it is issued. Renewal only
 *   moves the deadline, and only while every resource it granted is still granted;
 *   one missing item revokes it. Nothing narrows a grant in place, so a slot
 *   holding credentials from it never has to be partly unwound.
 * - A different actor, or the same actor with different resources, gets a NEW
 *   grant. The old one lives on for whatever was started under it (a background
 *   job keeps its own caller's permissions) until it is revoked or expires.
 * - Unknown, revoked or expired grants refuse. Nothing falls back to the session
 *   owner or to a shared identity.
 * - The deadline is an upper bound on how long a grant is valid without a full
 *   re-check against the control plane. It is what bounds revocation when no
 *   push arrives.
 */

import crypto from "node:crypto";
import { parseChannelExecutionPolicy, type ChannelExecutionPolicy } from "../shared/channel-execution-policy.js";
import { DEFAULT_GRANT_LEASE_MS, grantLeaseMs, normalizeGrantLeaseMs } from "../shared/execution-grant-lease.js";
import { identityKey, isNoneIdentity, userIdentity, type ExecutionIdentity } from "../shared/execution-identity.js";

export { DEFAULT_GRANT_LEASE_MS, grantLeaseMs };

export interface GrantResources {
  clusters: string[];
  hosts: string[];
  /**
   * Host id → name. `host_list` hands the model a host's id as a selection handle and the control
   * plane resolves either, so the box asks for a host by whichever the model used — a grant that
   * knew only names refused every host addressed by id (measured: `host_exec` on both of an
   * owner's hosts, "not available to this caller"). An alias grants nothing on its own: it counts
   * only while the name it points to is granted, and it is left out of the fingerprint and the
   * coverage check, which compare what is granted, not how it may be spelled.
   */
  hostIds?: Record<string, string>;
  policy?: ChannelExecutionPolicy;
}

export type GrantState = "active" | "revoked" | "expired";

/**
 * Who sent a turn (design §2.1 "发言人"): the platform user they are linked to,
 * and / or the provider's id for them (open_id / staffId). Either may be absent;
 * a sender with neither is no sender.
 */
export interface GrantSender {
  userId?: string;
  openId?: string;
}

/** Keep only non-empty string fields; `undefined` when nothing identifies anybody. */
export function normalizeGrantSender(raw: unknown): GrantSender | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const userId = str(src.userId);
  const openId = str(src.openId);
  if (!userId && !openId) return undefined;
  return { ...(userId ? { userId } : {}), ...(openId ? { openId } : {}) };
}

export interface ExecutionGrant {
  grantId: string;
  agentId: string;
  sessionId: string;
  /**
   * The execution identity the control plane named for the turn that opened
   * this grant (shared/execution-identity.ts): a person, a group binding, a
   * guest policy, or `none`. Resources are resolved against IT, never against
   * the sender or the session row.
   */
  actor: ExecutionIdentity;
  /**
   * The person the grant runs as, when it runs as one: `actor.id` for
   * `kind: "user"`, empty for every other kind. Kept for log lines and the
   * legacy `userId` the credential RPCs still carry for older control planes.
   */
  actorUserId: string;
  /**
   * The immutable sender that opened this grant. Background work can outlive
   * the foreground turn, so a later speaker must receive another grant rather
   * than replace the task/child owner's attribution on an existing grant.
   */
  sender?: GrantSender;
  resources: GrantResources;
  /** Digest of `resources`; two grants with the same one grant the same things. */
  fingerprint: string;
  /**
   * Jump hosts reached while serving this grant's hosts. A bastion is authorized
   * transitively by the control plane (binding a target grants transit through
   * its chain), so the box may ask for it by name; it is not in `resources`.
   */
  jumpHosts: Set<string>;
  deadline: number;
  state: GrantState;
}

export function resourceFingerprint(resources: GrantResources): string {
  const canonical = JSON.stringify({
    clusters: [...new Set(resources.clusters)].sort(),
    hosts: [...new Set(resources.hosts)].sort(),
    ...(resources.policy ? { policy: resources.policy } : {}),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** True when `current` still grants every resource `granted` did. */
export function stillCovers(granted: GrantResources, current: GrantResources): boolean {
  if (granted.policy?.fingerprint !== current.policy?.fingerprint) return false;
  const clusters = new Set(current.clusters);
  const hosts = new Set(current.hosts);
  return granted.clusters.every((c) => clusters.has(c)) && granted.hosts.every((h) => hosts.has(h));
}

export type ResolveResources = (agentId: string, actor: ExecutionIdentity, sessionId?: string, sender?:GrantSender) => Promise<GrantResources>;

const EMPTY_RESOURCES: GrantResources = Object.freeze({ clusters: [], hosts: [] }) as GrantResources;

/** A grant accepts the identity object, or — for call sites that still hold only a user id — the id. */
export type GrantActor = ExecutionIdentity | string;

function asIdentity(actor: GrantActor): ExecutionIdentity {
  return typeof actor === "string" ? userIdentity(actor) : actor;
}

export type GrantCheck =
  | { ok: true; grant: ExecutionGrant }
  | { ok: false; reason: "unknown" | "revoked" | "expired" | "agent_mismatch" };

export class ExecutionGrantRegistry {
  private readonly grants = new Map<string, ExecutionGrant>();
  private readonly pendingAdmissions = new Set<{ agentId: string; actorKey: string; cancelled: boolean }>();
  /** The grant each (agent, session, identity) is currently using, for reuse by its next turn. */
  private readonly current = new Map<string, string>();

  constructor(
    private readonly resolve: ResolveResources,
    private readonly opts: { leaseMs?: number; now?: () => number } = {},
  ) {}

  private get leaseMs(): number {
    return this.opts.leaseMs === undefined ? grantLeaseMs() : normalizeGrantLeaseMs(this.opts.leaseMs);
  }
  private now(): number { return (this.opts.now ?? Date.now)(); }

  private static key(agentId: string, sessionId: string, actor: ExecutionIdentity): string {
    return JSON.stringify([agentId, sessionId, identityKey(actor)]);
  }

  /**
   * The grant a turn runs under. Reuses the identity's current grant when it is
   * still active and grants exactly what the identity holds now; otherwise issues
   * a new one (the old one is left to whatever still runs under it).
   *
   * `none` never reaches the control plane: it holds nothing on ANY control
   * plane (design §2.2), so the answer is known here. It still gets a grant —
   * the slot and uid model applies to a turn with no credentials too, and the
   * box's tools explain the empty list from the identity rather than from a
   * refused request.
   */
  async open(agentId: string, sessionId: string, actor: GrantActor, sender?: GrantSender): Promise<ExecutionGrant> {
    const identity = Object.freeze({ ...asIdentity(actor) });
    const turnSender = normalizeGrantSender(sender);
    if (!agentId || !sessionId || !identity || (!isNoneIdentity(identity) && !identity.id)) {
      throw new Error("execution grant needs agent, session and actor");
    }
    const admission = { agentId, actorKey: identityKey(identity), cancelled: false };
    this.pendingAdmissions.add(admission);
    let resources: GrantResources;
    try {
      resources = isNoneIdentity(identity) ? EMPTY_RESOURCES : await this.resolve(agentId, identity, sessionId, turnSender);
      if (admission.cancelled) throw new Error("Execution authorization changed during admission");
    } finally { this.pendingAdmissions.delete(admission); }
    const fingerprint = resourceFingerprint(resources);
    const key = ExecutionGrantRegistry.key(agentId, sessionId, identity);
    const existing = this.grants.get(this.current.get(key) ?? "");
    if (existing && this.liveState(existing) === "active" && existing.fingerprint === fingerprint
        && JSON.stringify(existing.sender) === JSON.stringify(turnSender)) {
      existing.deadline = this.now() + this.leaseMs;
      return existing;
    }
    const grant: ExecutionGrant = {
      grantId: crypto.randomUUID(),
      agentId, sessionId,
      actor: identity,
      actorUserId: identity.kind === "user" ? identity.id : "",
      ...(turnSender ? { sender: turnSender } : {}),
      resources: {
        clusters: [...resources.clusters],
        hosts: [...resources.hosts],
        ...(resources.hostIds ? { hostIds: { ...resources.hostIds } } : {}),
        ...(resources.policy ? { policy: parseChannelExecutionPolicy(resources.policy) } : {}),
      },
      fingerprint,
      jumpHosts: new Set(),
      deadline: this.now() + this.leaseMs,
      state: "active",
    };
    this.grants.set(grant.grantId, grant);
    this.current.set(key, grant.grantId);
    return grant;
  }

  private liveState(grant: ExecutionGrant): GrantState {
    if (grant.state === "active" && this.now() >= grant.deadline) grant.state = "expired";
    return grant.state;
  }

  /** Resolve a grant a box presented, for a request made under the connection's agent. */
  check(grantId: string | undefined, agentId: string): GrantCheck {
    const grant = grantId ? this.grants.get(grantId) : undefined;
    if (!grant) return { ok: false, reason: "unknown" };
    if (grant.agentId !== agentId) return { ok: false, reason: "agent_mismatch" };
    const state = this.liveState(grant);
    if (state !== "active") return { ok: false, reason: state };
    return { ok: true, grant };
  }

  /**
   * Re-check a grant against the caller's CURRENT permissions and, only if every
   * granted resource is still granted, push its deadline out. Anything less
   * revokes it: the box then ends everything that ran under it and the next turn
   * opens a new grant with what the caller holds now.
   */
  async renew(grantId: string, agentId: string): Promise<GrantCheck> {
    const checked = this.check(grantId, agentId);
    if (!checked.ok) return checked;
    const grant = checked.grant;
    let current: GrantResources;
    try {
      // `none` is settled locally on open and stays settled: an empty grant
      // re-checked against an empty answer is still active, never revoked.
      current = isNoneIdentity(grant.actor) ? EMPTY_RESOURCES : await this.resolve(grant.agentId, grant.actor, grant.sessionId,grant.sender);
    } catch {
      // Not knowing is not "still granted". The grant keeps its deadline and
      // lapses on its own if the control plane stays unreachable.
      return this.check(grantId, agentId);
    }
    // The lookup may outlive a push or the last confirmed deadline. A late
    // success must not acknowledge (or revive) an ended grant.
    const currentGrant = this.check(grantId, agentId);
    if (!currentGrant.ok) return currentGrant;
    if (currentGrant.grant !== grant) return { ok: false, reason: "unknown" };
    if (!stillCovers(grant.resources, current)) {
      grant.state = "revoked";
      return { ok: false, reason: "revoked" };
    }
    grant.deadline = this.now() + this.leaseMs;
    return { ok: true, grant };
  }

  /** How long `grant` stays valid from now, on this registry's clock. */
  remainingMs(grant: ExecutionGrant): number {
    return Math.max(0, grant.deadline - this.now());
  }

  /** Revoke every grant of an identity (optionally on one agent) — the push path. */
  revokeActor(actor: GrantActor, agentId?: string): ExecutionGrant[] {
    const key = identityKey(asIdentity(actor));
    for (const admission of this.pendingAdmissions) {
      if (admission.actorKey === key && (!agentId || admission.agentId === agentId)) admission.cancelled = true;
    }
    const revoked: ExecutionGrant[] = [];
    for (const grant of this.grants.values()) {
      if (identityKey(grant.actor) !== key) continue;
      if (agentId && grant.agentId !== agentId) continue;
      if (this.liveState(grant) !== "active") continue;
      grant.state = "revoked";
      revoked.push(grant);
    }
    return revoked;
  }

  /** Drop records that can no longer answer anything but "refused". */
  revokeAgent(agentId: string): ExecutionGrant[] {
    for (const admission of this.pendingAdmissions) if (admission.agentId === agentId) admission.cancelled = true;
    const revoked:ExecutionGrant[]=[];
    for(const grant of this.grants.values()) if(grant.agentId===agentId && this.liveState(grant)==="active"){
      grant.state="revoked";revoked.push(grant);
    }
    return revoked;
  }

  /** Drop records that can no longer answer anything but "refused". */
  sweep(retainMs = 10 * 60_000): void {
    const cutoff = this.now() - retainMs;
    for (const [id, grant] of this.grants) {
      if (this.liveState(grant) !== "active" && grant.deadline < cutoff) this.grants.delete(id);
    }
    for (const [key, id] of this.current) if (!this.grants.has(id)) this.current.delete(key);
  }
}

/** Is `name` a resource this grant lets the box fetch a credential for? */
export function grantAllows(grant: ExecutionGrant, kind: "cluster" | "host", name: string): boolean {
  if (kind === "cluster") return grant.resources.clusters.includes(name);
  if (grant.resources.hosts.includes(name) || grant.jumpHosts.has(name)) return true;
  // An own-property lookup only: `name` comes from the box, and "constructor" must not resolve.
  const ids = grant.resources.hostIds;
  const alias = ids && Object.prototype.hasOwnProperty.call(ids, name) ? ids[name] : undefined;
  return alias !== undefined && grant.resources.hosts.includes(alias);
}

/**
 * The Runtime's registry, for dispatch paths that do not run inside `chat.send`
 * (a channel or a task talking to its box directly, in a deployment without
 * remote conversations). One Runtime process has one registry.
 */
let processRegistry: ExecutionGrantRegistry | undefined;

export function registerExecutionGrants(registry: ExecutionGrantRegistry): void {
  processRegistry = registry;
}

export function unregisterExecutionGrants(registry: ExecutionGrantRegistry): void {
  if (processRegistry === registry) processRegistry = undefined;
}

/** No sender/session-owner substitution at internal mutation boundaries. */
export function executionGrantForRequest(certificate: { agentId: string; privateUserId?: string },
  grantId: string | undefined, sessionId: string | undefined): ExecutionGrant | null {
  if (!processRegistry && !grantId) return null;
  if (!processRegistry || !grantId || !sessionId) throw new Error("Execution authorization required");
  const checked = processRegistry.check(grantId, certificate.agentId);
  if (!checked.ok || checked.grant.sessionId !== sessionId) throw new Error("Execution authorization mismatch");
  if (certificate.privateUserId && (checked.grant.actor.kind !== "user" || checked.grant.actor.id !== certificate.privateUserId))
    throw new Error("Execution authorization private principal mismatch");
  return checked.grant;
}

/** Open the grant a directly-dispatched turn runs under. Undefined only where no Runtime registered one (unit tests). */
export async function openExecutionGrant(
  agentId: string, sessionId: string, actor: GrantActor, sender?: GrantSender,
): Promise<string | undefined> {
  if (!processRegistry) return undefined;
  return (await processRegistry.open(agentId, sessionId, actor, sender)).grantId;
}
