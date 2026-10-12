import { matchesSessionPrincipal } from "./security/session-principal.js";
import { parseChannelExecutionPolicy } from "../shared/channel-execution-policy.js";
/**
 * CredentialService — forwards all credential requests via FrontendWsClient RPC.
 *
 * Runtime delegates to the management server (Portal or Upstream) via
 * persistent WebSocket RPC. The management server handles credential storage,
 * decryption, and agent binding validation.
 */

import type { FrontendWsClient } from "./frontend-ws-client.js";
import type {
  Identity,
  ClusterMeta,
  HostMeta,
  CredentialPayload,
  DevopsCredentialPayload,
  HostListResult,
} from "../shared/credential-types.js";
import { sessionRegistry, type SessionRegistry } from "./session-registry.js";
import { grantAllows, type ExecutionGrant, type ExecutionGrantRegistry, type GrantResources } from "./execution-grants.js";
import { isNoneIdentity, userIdentity, wireIdentity, type ExecutionIdentity } from "../shared/execution-identity.js";

/**
 * The identity fields every `credential.*` request carries. `identity` is the
 * execution identity (design §5.2); `userId` is the legacy spelling an older
 * control plane reads — the person for `kind: "user"`, empty otherwise, so an
 * older control plane given a group or guest identity resolves nothing rather
 * than someone.
 */
function identityParams(identity: ExecutionIdentity): { identity: { kind: string; id: string }; userId: string } {
  return { identity: wireIdentity(identity), userId: identity.kind === "user" ? identity.id : "" };
}

export class CredentialService {
  private grants?: ExecutionGrantRegistry;

  constructor(
    private readonly frontendClient: FrontendWsClient,
    private readonly registry: SessionRegistry = sessionRegistry,
  ) {}

  /** Wired after construction: the registry resolves its resources through this service. */
  attachGrants(grants: ExecutionGrantRegistry): void {
    this.grants = grants;
  }

  executionGrant(identity: Identity): ExecutionGrant {
    const grant = this.grantFor(identity);
    if (!grant) throw new SessionOwnershipError("Execution grant required");
    return grant;
  }

  async renewExecutionGrant(identity: Identity): Promise<Record<string, unknown>> {
    const grant = this.executionGrant(identity);
    const checked = await this.grants!.renew(grant.grantId, identity.agentId);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    return { ok: true, remainingMs: this.grants!.remainingMs(grant),
      identity: { ...grant.actor }, sender: grant.sender, sessionId: grant.sessionId,
      ...(grant.resources.policy ? { policy: grant.resources.policy } : {}) };
  }

  /**
   * What `actor` may use on `agentId`, as the control plane answers it now.
   * The control plane resolves the identity it is given (a deployment without
   * per-identity permissions answers with the agent's bindings for a user or a
   * binding). `none` is answered HERE, without a round trip: it holds nothing on
   * any control plane (design §2.2, §5.2).
   */
  async resolveActorResources(agentId: string, actor: ExecutionIdentity | string, sessionId?: string,sender?:import("./execution-grants.js").GrantSender): Promise<GrantResources> {
    const identity = typeof actor === "string" ? userIdentity(actor) : actor;
    if (isNoneIdentity(identity)) return { clusters: [], hosts: [], hostIds: {} };
    const params = { ...identityParams(identity), agentId, orgId: "", boxId: "", sessionId: "" };
    let scope: { policy?: unknown; clusterNames?: unknown; hostNames?: unknown } | undefined;
    if (sessionId && this.frontendClient.consumerDeclares?.("channelPolicyV1") === true)
      scope = await this.frontendClient.request("channel.policy.resolve", { ...params, sessionId,sender }) as typeof scope;
    const policy = parseChannelExecutionPolicy(scope?.policy);
    if (identity.policyRequired && !policy) throw new Error("Required channel policy is unavailable");
    if (policy && (!Array.isArray(scope?.clusterNames) || !Array.isArray(scope?.hostNames) ||
        [...scope.clusterNames, ...scope.hostNames].some(name => typeof name !== "string")))
      throw new Error("Channel resource scope is malformed");
    const [clusters, hosts] = await Promise.all([
      this.frontendClient.request("credential.list", { ...params, kind: "cluster" }) as Promise<{ clusters?: ClusterMeta[] }>,
      this.frontendClient.request("credential.list", { ...params, kind: "host" }) as Promise<{ hosts?: HostMeta[] }>,
    ]);
    if (!Array.isArray(clusters.clusters) || !Array.isArray(hosts.hosts)) {
      throw new Error("Adapter credential-list returned a malformed response while resolving a grant");
    }
    const selectedClusters = clusters.clusters.filter(c => !policy || (scope!.clusterNames as string[]).includes(c.name));
    const selectedHosts = hosts.hosts.filter(h => !policy || (scope!.hostNames as string[]).includes(h.name));
    const hostIds: Record<string, string> = {};
    for (const h of selectedHosts) if (h.id) hostIds[h.id] = h.name;
    return { clusters: selectedClusters.map((c) => c.name), hosts: selectedHosts.map((h) => h.name), hostIds,
      ...(policy ? { policy } : {}) };
  }

  /**
   * A Runtime that issues grants answers a request without one with NOTHING: an
   * empty list, a refused credential. The legacy session-owner path below would
   * otherwise resolve it to an empty user — i.e. the agent's whole binding, with
   * no member RBAC — which is what a box that predates grants (a pod not yet
   * recycled after an upgrade) would get for every member. Lists answer empty
   * rather than refuse so a box-wide broker's reconcile on a resource push
   * simply finds nothing, instead of reporting a failure on every push.
   */
  private refusesUngranted(identity: Identity): boolean {
    return !!this.grants && !identity.grantId;
  }

  /** The grant a request carries, or null for a box that predates grants. Throws when it names one that is not usable. */
  private grantFor(identity: Identity): ExecutionGrant | null {
    if (!identity.grantId) {
      if (this.grants) throw new SessionOwnershipError("a credential request must name the execution grant it runs under");
      return null;
    }
    if (!this.grants) throw new SessionOwnershipError("execution grants are not available on this Runtime");
    const checked = this.grants.check(identity.grantId, identity.agentId);
    if (!checked.ok) throw new SessionOwnershipError(`execution grant ${checked.reason}`);
    if (identity.sessionId && identity.sessionId !== checked.grant.sessionId)
      throw new SessionOwnershipError("execution grant session mismatch");
    if (identity.privateUserId && (checked.grant.actor.kind !== "user" || checked.grant.actor.id !== identity.privateUserId))
      throw new SessionOwnershipError("execution grant private principal mismatch");
    if (checked.grant.resources.policy && identity.channelPolicyV1 !== true) throw new SessionOwnershipError("AgentBox channel policy enforcement required");
    if (checked.grant.resources.policy?.version===2 && identity.channelPolicyV2!==true) throw new SessionOwnershipError("AgentBox resource-rule enforcement required");
    if (checked.grant.resources.policy?.version===3 && identity.channelAgentScope!==true) throw new SessionOwnershipError("AgentBox Agent-resource enforcement required");
    return checked.grant;
  }

  /** True when the request runs under a grant whose identity holds nothing anywhere — answered locally. */
  private holdsNothing(identity: Identity): boolean {
    const grant = this.grantFor(identity);
    return !!grant && isNoneIdentity(grant.actor);
  }

  private async rpcParams(identity: Identity, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const grant = this.grantFor(identity);
    if (grant) {
      // The grant names whose permissions apply: the execution identity of the
      // turn that opened it. Not the session's owner — in a channel that is
      // whoever created the binding, not whoever is speaking — and not the
      // sender either: a group runs as its binding, whoever asked.
      return {
        ...identityParams(grant.actor),
        agentId: identity.agentId,
        orgId: identity.orgId ?? "",
        boxId: identity.boxId ?? "",
        sessionId: grant.sessionId,
        ...extra,
      };
    }
    // AgentBox is user-unaware — it doesn't know the caller's userId. Runtime
    // recovers the attribution from the session registry (populated at chat
    // entry, with a Portal RPC fallback for cache misses) so Upstream still
    // sees a concrete userId for audit purposes.
    //
    // Cross-agent attribution is rejected: if AgentBox A (cert agentId=A)
    // passes a session_id whose owner agentId=B, we refuse rather than
    // silently audit B's user as the caller. Unknown sessions degrade to
    // empty userId (graceful, same as pre-fallback behaviour).
    let userId = "";
    if (identity.sessionId) {
      const owner = await this.registry.get(identity.sessionId);
      if (owner) {
        if (!matchesSessionPrincipal(identity, owner)) {
          throw new SessionOwnershipError(
            `session ${identity.sessionId} belongs to agent ${owner.agentId}, not ${identity.agentId}`,
          );
        }
        userId = owner.userId;
      }
    }
    if (identity.privateUserId && userId !== identity.privateUserId) throw new SessionOwnershipError("Private session required");
    return {
      userId,
      // The legacy path knows a person or nobody; say so in the new field too,
      // so a control plane reading `identity` sees the same answer as `userId`.
      ...(userId ? { identity: wireIdentity(userIdentity(userId)) } : {}),
      agentId: identity.agentId,
      orgId: identity.orgId ?? "",
      boxId: identity.boxId ?? "",
      sessionId: identity.sessionId ?? "",
      ...extra,
    };
  }

  async listClusters(identity: Identity): Promise<ClusterMeta[]> {
    if (this.refusesUngranted(identity) || this.holdsNothing(identity)) return [];
    const data = await this.frontendClient.request(
      "credential.list",
      await this.rpcParams(identity, { kind: "cluster" }),
    ) as { clusters?: ClusterMeta[] };
    if (!Array.isArray(data.clusters)) {
      throw new Error("Adapter credential-list returned malformed cluster list response");
    }
    const grant = this.grantFor(identity);
    return grant ? data.clusters.filter((c) => grantAllows(grant, "cluster", c.name)) : data.clusters;
  }

  async listHosts(identity: Identity): Promise<HostMeta[]> {
    if (this.refusesUngranted(identity) || this.holdsNothing(identity)) return [];
    const data = await this.frontendClient.request(
      "credential.list",
      await this.rpcParams(identity, { kind: "host" }),
    ) as { hosts?: HostMeta[] };
    if (!Array.isArray(data.hosts)) {
      throw new Error("Adapter credential-list returned malformed host list response");
    }
    const grant = this.grantFor(identity);
    return grant ? data.hosts.filter((h) => grantAllows(grant, "host", h.name)) : data.hosts;
  }

  /** Filtered + paginated host_list (name/ip/description), agent-scoped. Hits the
   *  same `credential.list` RPC as listHosts, with a `query` — returns a FILTERED
   *  subset, not a full snapshot. */
  async queryHosts(identity: Identity, query: string, opts?: { limit?: number; cursor?: string }): Promise<HostListResult> {
    if (this.refusesUngranted(identity) || this.holdsNothing(identity)) return { hosts: [], total: 0, next_cursor: null };
    const data = await this.frontendClient.request(
      "credential.list",
      await this.rpcParams(identity, {
        kind: "host",
        query,
        ...(opts?.limit != null ? { limit: opts.limit } : {}),
        ...(opts?.cursor != null ? { cursor: opts.cursor } : {}),
      }),
    ) as Partial<HostListResult>;
    if (!Array.isArray(data.hosts)) {
      throw new Error("Adapter credential-list returned malformed host search response");
    }
    const grant = this.grantFor(identity);
    if (grant) {
      // The control plane already narrowed the search to the caller's current
      // RBAC; the grant removes only what was granted after it was opened. The
      // cursor goes through regardless: dropping it whenever a page lost an entry
      // ended the paging there, and later pages were silently never listed.
      const hosts = data.hosts.filter((h) => grantAllows(grant, "host", h.name));
      const dropped = data.hosts.length - hosts.length;
      return {
        hosts,
        total: typeof data.total === "number" ? Math.max(hosts.length, data.total - dropped) : hosts.length,
        next_cursor: data.next_cursor ?? null,
      };
    }
    return {
      hosts: data.hosts,
      total: typeof data.total === "number" ? data.total : data.hosts.length,
      next_cursor: data.next_cursor ?? null,
    };
  }

  async getClusterCredential(identity: Identity, clusterName: string, purpose: string): Promise<CredentialPayload> {
    const grant = this.grantFor(identity);
    if (grant && !grantAllows(grant, "cluster", clusterName)) {
      throw new CredentialNotFoundError(`cluster ${clusterName} is not available to this caller`);
    }
    return this.frontendClient.request(
      "credential.get",
      await this.rpcParams(identity, { source: "cluster", source_id: clusterName, purpose }),
    ) as Promise<CredentialPayload>;
  }

  async getHostCredential(identity: Identity, hostName: string, purpose: string): Promise<CredentialPayload> {
    const grant = this.grantFor(identity);
    if (grant && !grantAllows(grant, "host", hostName)) {
      throw new CredentialNotFoundError(`host ${hostName} is not available to this caller`);
    }
    const payload = await this.frontendClient.request(
      "credential.get",
      await this.rpcParams(identity, { source: "host", source_id: hostName, purpose }),
    ) as CredentialPayload;
    // A bastion is authorized through the target that names it; remember it on
    // the grant in case a box asks for it by name.
    for (const hop of payload?.credential?.jump_chain ?? []) if (hop.name) grant?.jumpHosts.add(hop.name);
    return payload;
  }

  /**
   * The project agent's delivery-platform credential — the `sfm_` token
   * `siforgectl` presents to the delivery control plane.
   *
   * ⚠️ NO source_id, and that is the shape rather than an omission. An agent has
   * exactly one of these, keyed by the agentId the management server already
   * authorized; there is no second row a name could select. Sending one would
   * invent a choice and hand the caller a lever over which credential it gets.
   *
   * ⚠️ This is also why the credential is NOT delivered as spawn env. Spawn env
   * becomes plain container env in the pod spec, readable by anyone who can
   * `kubectl get pod -o yaml` and stored in etcd. Pulling it over this
   * already-authenticated channel keeps it out of both.
   */
  async getDevopsCredential(identity: Identity, purpose: string): Promise<DevopsCredentialPayload> {
    return this.frontendClient.request(
      "credential.get",
      await this.rpcParams(identity, { source: "devops", purpose }),
    ) as Promise<DevopsCredentialPayload>;
  }
}

export class CredentialNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "CredentialNotFoundError"; }
}

/**
 * Thrown when a credential request carries a sessionId that resolves to a
 * different agent than the calling cert. credential-proxy translates this
 * into HTTP 403 — never falls through to the upstream RPC, which would
 * otherwise audit the wrong user.
 */
export class SessionOwnershipError extends Error {
  constructor(message: string) { super(message); this.name = "SessionOwnershipError"; }
}

export function createCredentialService(frontendClient: FrontendWsClient): CredentialService {
  console.log(`[credential-service] backend: FrontendWsClient RPC`);
  return new CredentialService(frontendClient);
}
