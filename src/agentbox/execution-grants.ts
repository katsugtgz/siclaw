import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CredentialBroker, resolveGroupGid } from "./credential-broker.js";
import { HttpTransport } from "./credential-transport.js";
import type { GatewayClient } from "./gateway-client.js";
import { identityKey, parseWireIdentity, type ExecutionIdentity } from "../shared/execution-identity.js";
import { parseExecutionSender, type ExecutionSender } from "../shared/execution-context.js";
import { parseChannelExecutionPolicy, type ChannelExecutionPolicy } from "../shared/channel-execution-policy.js";
import { MAX_GRANT_LEASE_MS } from "../shared/execution-grant-lease.js";

export interface BoxExecutionGrant {
  readonly grantId: string;
  readonly sessionId: string;
  readonly identity: ExecutionIdentity;
  readonly policy?: ChannelExecutionPolicy;
  readonly sender?: ExecutionSender;
  readonly client: GatewayClient;
  readonly broker: CredentialBroker;
  readonly credentialsDir: string;
  readonly onEnd: Set<() => void>;
  readonly busy: Set<() => boolean>;
  deadline: number;
  ended: boolean;
}

/** Native OS/executor isolation is unchanged. Each immutable grant gets its own
 * credential cache and transport; expiration aborts its owned work locally. */
export class BoxExecutionGrants {
  private readonly grants = new Map<string, BoxExecutionGrant>();
  private readonly pending = new Map<string, { promise: Promise<BoxExecutionGrant>; admission: { cancelled: boolean } }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly expirationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  constructor(private readonly gateway: GatewayClient, private readonly root: string) {}

  async accept(grantId: string, sessionId: string, expected: ExecutionIdentity): Promise<BoxExecutionGrant> {
    if (this.closed) throw new Error("Execution authorization manager closed");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(grantId) || !sessionId) throw new Error("Invalid execution grant");
    const principal = Object.freeze({ ...expected });
    let pending = this.pending.get(grantId);
    if (!pending) {
      const admission = { cancelled: false };
      pending = { admission, promise: this.confirm(grantId, sessionId, principal, true, admission)
        .finally(() => this.pending.delete(grantId)) };
      this.pending.set(grantId, pending);
    }
    const grant = await pending.promise;
    if (this.closed || grant.ended || Date.now() >= grant.deadline) throw new Error("Execution authorization ended");
    // A stricter caller may join a confirmation begun by a legacy caller.
    // Deduplicating the RPC must never deduplicate each waiter's policy check.
    if (principal.policyRequired && !grant.policy) throw new Error("Required AgentBox channel policy is unavailable");
    if (grant.sessionId !== sessionId || identityKey(grant.identity) !== identityKey(principal))
      throw new Error("Execution grant context mismatch");
    return grant;
  }

  private async confirm(grantId: string, sessionId: string, expected: ExecutionIdentity, freshDispatch = false,
    admission?: { cancelled: boolean }): Promise<BoxExecutionGrant> {
    if (this.closed || admission?.cancelled) throw new Error("Execution authorization ended");
    const started = Date.now();
    const result = await this.gateway.renewExecutionGrant(grantId, sessionId);
    if (this.closed || admission?.cancelled) throw new Error("Execution authorization ended");
    if (result?.ok === false) {
      const owned = this.grants.get(grantId);
      if (owned) this.end(owned);
      throw new Error("Execution authorization ended");
    }
    const identity = parseWireIdentity(result?.identity);
    const policy = parseChannelExecutionPolicy(result?.policy);
    if (expected.policyRequired && !policy) throw new Error("Required AgentBox channel policy is unavailable");
    if (result?.ok !== true || !identity || identityKey(identity) !== identityKey(expected)
        || result.sessionId !== sessionId || !Number.isSafeInteger(result.remainingMs)
        || result.remainingMs <= 0 || result.remainingMs > MAX_GRANT_LEASE_MS)
      throw new Error("Execution grant is unavailable or misbound");
    const deadline = started + result.remainingMs;
    if (deadline <= Date.now()) throw new Error("Execution grant confirmation expired");
    let existing = this.grants.get(grantId);
    if (existing?.ended) {
      if (!freshDispatch) throw new Error("Execution grant ended");
      // A newly confirmed dispatch can use a fresh broker. Old holders retain
      // their ended object and can never regain access to the new directory.
      existing = undefined;
    }
    if (existing && (existing.sessionId !== sessionId || identityKey(existing.identity) !== identityKey(identity)))
      throw new Error("Execution grant principal changed");
    if (existing?.policy?.fingerprint !== policy?.fingerprint) {
      if (existing) this.end(existing);
      if (existing) throw new Error("Execution policy changed");
    }
    if (existing) { existing.deadline = deadline; this.schedule(existing); return existing; }
    const grantRoot = path.join(this.root, "execution-grants");
    const principalRoot = path.join(grantRoot, grantId);
    const directory = path.join(principalRoot, randomUUID());
    // Each trusted setgid reader must traverse the opaque grant ancestors.
    // Listing stays private; credential type directories enforce reader groups.
    const kubeGid = resolveGroupGid("kubecred");
    const devopsGid = resolveGroupGid("devopscred");
    const ancestorMode = devopsGid !== null ? 0o711 : kubeGid !== null ? 0o710 : 0o700;
    for (const owned of [grantRoot, principalRoot, directory]) {
      fs.mkdirSync(owned, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(owned);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          typeof process.getuid === "function" && stat.uid !== process.getuid())
        throw new Error("Unsafe execution credential directory");
      if (kubeGid !== null) fs.chownSync(owned, -1, kubeGid);
      fs.chmodSync(owned, ancestorMode);
      const applied = fs.lstatSync(owned);
      if ((applied.mode & 0o777) !== ancestorMode ||
          kubeGid !== null && applied.gid !== kubeGid)
        throw new Error("Execution credential isolation could not be applied");
    }
    const delivery = path.join(directory, "devops");
    fs.mkdirSync(delivery, { mode: 0o700 });
    if (devopsGid !== null) fs.chownSync(delivery, -1, devopsGid);
    fs.chmodSync(delivery, devopsGid === null ? 0o700 : 0o2750);
    const deliveryStat = fs.lstatSync(delivery);
    if (deliveryStat.isSymbolicLink() || !deliveryStat.isDirectory() ||
        (deliveryStat.mode & 0o7777) !== (devopsGid === null ? 0o700 : 0o2750) ||
        devopsGid !== null && deliveryStat.gid !== devopsGid) throw new Error("Delivery credential isolation could not be applied");
    let grant: BoxExecutionGrant;
    const client = this.gateway.forExecutionGrant(grantId, sessionId,
      () => !grant.ended && Date.now() < grant.deadline,policy);
    grant = { grantId, sessionId, identity: Object.freeze({ ...identity }), policy,
      sender: result.sender ? Object.freeze(parseExecutionSender(result.sender)) : undefined,
      client, broker: new CredentialBroker(new HttpTransport(client), directory, policy ? { policy, validate: async () => {
        if (grant.ended || Date.now() >= grant.deadline) throw new Error("Execution authorization ended");
        await this.confirm(grantId, sessionId, expected);
        if (grant.ended) throw new Error("Execution authorization ended");
      } } : undefined),
      credentialsDir: directory, onEnd: new Set(), busy: new Set(), deadline, ended: false };
    this.grants.set(grantId, grant); this.schedule(grant); return grant;
  }

  private schedule(grant: BoxExecutionGrant): void {
    clearTimeout(this.timers.get(grant.grantId));
    clearTimeout(this.expirationTimers.get(grant.grantId));
    const remaining = grant.deadline - Date.now();
    if (remaining <= 0) { this.end(grant); return; }
    const expiration = setTimeout(() => this.end(grant), remaining);
    expiration.unref?.(); this.expirationTimers.set(grant.grantId, expiration);
    const timer = setTimeout(() => {
      if ([...grant.busy].some(held => held())) void this.renew(grant);
    }, Math.max(1, remaining / 2));
    timer.unref?.(); this.timers.set(grant.grantId, timer);
  }

  private async renew(grant: BoxExecutionGrant): Promise<void> {
    if (grant.ended) return;
    try { await this.confirm(grant.grantId, grant.sessionId, grant.identity); }
    catch {
      if (Date.now() >= grant.deadline) this.end(grant);
      else {
        const timer = setTimeout(() => { void this.renew(grant); }, Math.min(5000, grant.deadline - Date.now()));
        timer.unref?.(); this.timers.set(grant.grantId, timer);
      }
    }
  }

  private end(grant: BoxExecutionGrant): void {
    if (grant.ended) return;
    grant.ended = true; clearTimeout(this.timers.get(grant.grantId));
    clearTimeout(this.expirationTimers.get(grant.grantId));
    for (const cancel of grant.onEnd) { try { cancel(); } catch { /* other owners still cancel */ } }
    grant.onEnd.clear(); grant.busy.clear(); grant.broker.dispose();
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.admission.cancelled = true;
    for (const grant of this.grants.values()) this.end(grant);
    this.grants.clear(); this.timers.clear(); this.expirationTimers.clear();
  }
  revoke(ids: readonly string[]): void {
    for (const id of ids) {
      const pending = this.pending.get(id);
      if (pending) pending.admission.cancelled = true;
      const grant = this.grants.get(id);
      if (grant) this.end(grant);
    }
  }
}
