/**
 * Execution identity: whose permissions ONE turn runs under.
 *
 * It is not the sender. In a direct chat the two coincide; in a group they do
 * not: a group is one conversation everyone in the room can read, so a turn's
 * output is visible to every member regardless of who asked. Permissions
 * computed per speaker therefore leak upward — the highest-privileged member's
 * results are read by the lowest — and splitting tool output per speaker only
 * hides the raw output, never what the answer quotes from it. The design
 * (docs/design/2026-09-25-execution-identity.zh-CN.md §2.1) therefore gives a
 * group ONE identity, configured on the binding, and keeps the sender as a
 * separate object for admission, audit and session control.
 *
 * Consequently "same identity" never implies "same person": every guest of a
 * bot shares `guest:<cfg>`, every member of a group shares `binding:<id>`.
 * Anything asking who may SEE, who may CONTROL, or whose MEMORY to write reads
 * the sender and the session's ownership — never this object.
 *
 * The control plane resolves it per entry point (§3) and the Runtime carries it
 * verbatim into the execution grant and every credential request. `none` is a
 * real identity, not an absence: it can talk, and it holds no resources on any
 * control plane (§2.2) — the Runtime does not even ask.
 */

export type ExecutionIdentityKind = "user" | "binding" | "guest" | "none";

export interface ExecutionIdentity {
  policyRequired?: boolean;
  kind: ExecutionIdentityKind;
  /**
   * `user`: the platform user's id. `binding`: the group binding's id. `guest`:
   * the bot configuration's id. `none`: empty — nothing to resolve against.
   */
  id: string;
  /** Display name for the identity (a group's name), for prose only. */
  label?: string;
  /**
   * Why the identity is `none`, when it is: `unbound` (the sender has not linked
   * an account), `guest_chat_only` (a linked non-member under a chat-only guest
   * policy), `group_unconfigured` (the group binding has no resources yet).
   * Wording only; nothing is authorized by it.
   */
  reason?: string;
}

const KINDS: ReadonlySet<string> = new Set<ExecutionIdentityKind>(["user", "binding", "guest", "none"]);

/**
 * Parse an identity off the wire. Strict: an unknown kind, or an identified
 * kind with no id, is `undefined` rather than a guess — the callers decide
 * whether that is "an older control plane" or a malformed reply, and the two
 * need opposite answers.
 */
export function parseWireIdentity(raw: unknown): ExecutionIdentity | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  if (typeof src.kind !== "string" || !KINDS.has(src.kind)) return undefined;
  const kind = src.kind as ExecutionIdentityKind;
  const id = typeof src.id === "string" ? src.id.trim() : "";
  if (kind !== "none" && !id) return undefined;
  const out: ExecutionIdentity = { kind, id: kind === "none" ? "" : id };
  if (typeof src.label === "string" && src.label.trim()) out.label = src.label;
  if (typeof src.reason === "string" && src.reason.trim()) out.reason = src.reason;
  if (src.policyRequired !== undefined && typeof src.policyRequired !== "boolean") return undefined;
  if (src.policyRequired === true) out.policyRequired = true;
  return out;
}

/** The key two identities are equal under: kind and id, nothing else. */
export function identityKey(identity: ExecutionIdentity): string {
  return `${identity.kind}:${identity.id}`;
}

/** The identity of a platform user — what every entry point resolved to before groups had their own. */
export function userIdentity(userId: string): ExecutionIdentity {
  return { kind: "user", id: userId };
}

export const NONE_IDENTITY: ExecutionIdentity = Object.freeze({ kind: "none", id: "" });

export function isNoneIdentity(identity: ExecutionIdentity | undefined): boolean {
  return identity?.kind === "none";
}

/** What goes on the wire: kind and id only — label and reason are for the box's prose. */
export function wireIdentity(identity: ExecutionIdentity): { kind: ExecutionIdentityKind; id: string } {
  return { kind: identity.kind, id: identity.id };
}

/**
 * What `cluster_list` / `host_list` say when they come back empty, and what the
 * exec tools say when a cluster cannot be materialised — by identity KIND, in one
 * place so the tools agree (design §3.2). Model-facing, hence English: the model
 * relays it in the user's language.
 *
 * A `user` keeps the two-cause wording: the list is the agent's bindings
 * narrowed to what this person may use, and the tool cannot tell which cause
 * emptied it. Every other kind has ONE cause and names it, with the one place
 * the person can go — a member wanting their own permissions in a group is sent
 * to a direct chat or the console, never told to "ask for a binding" that exists.
 */
export function noResourcesExplanation(resource: "cluster" | "host", identity?: ExecutionIdentity): string {
  const plural = resource === "cluster" ? "clusters" : "hosts";
  const bind = resource === "cluster" ? "bind clusters to this agent" : "bind hosts to this agent";
  switch (identity?.kind) {
    case "binding":
      return `No ${plural} are available in this group: this group has no resources configured for it, `
        + `so nothing here can operate a ${resource}. Tell the user: an administrator can configure the group's `
        + `resources in the console, and a member who wants to act with their own permissions can message the `
        + "bot directly or use the console. Do not guess or retry a name.";
    case "guest":
      return `No ${plural} are available to this conversation: the person asking is not a member of this `
        + `organization, and the guest policy grants no ${plural}. Tell the user; membership in the organization `
        + "is what unlocks its resources. Do not guess or retry a name.";
    case "none":
      if (identity.reason === "unbound") {
        return `No ${plural} are available to this conversation: the person asking has not linked their chat `
          + "account to a platform account yet, so this turn runs with no permissions. Tell the user to link "
          + "their account with the one-time link the bot has sent them in this chat, then ask again. "
          + "Do not guess or retry a name.";
      }
      if (identity.reason === "group_unconfigured") {
        return noResourcesExplanation(resource, { kind: "binding", id: "" });
      }
      return `No ${plural} are available to this conversation: the person asking is not a member of this `
        + "organization, so this turn runs with no permissions. Tell the user; an administrator can grant "
        + "them membership. Do not guess or retry a name.";
    default:
      return `No ${plural} are available to this conversation: either none is bound to this agent, `
        + `or the person asking has no access to the ones that are. Do not guess or retry a ${resource} name — `
        + `tell the user; an administrator can ${bind} or grant them access.`;
  }
}
