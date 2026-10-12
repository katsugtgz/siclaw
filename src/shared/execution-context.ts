import { parseWireIdentity, userIdentity, type ExecutionIdentity } from "./execution-identity.js";

/** Sender is attribution, never an authorization identity. */
export interface ExecutionSender { userId?: string; openId?: string; type?: string; member?: boolean }
export interface ExecutionContext { identity: ExecutionIdentity; sender?: ExecutionSender; origin?: "channel" | "dm" }
export interface ExecutionAuthorization extends ExecutionContext { grantId: string }

export function parseExecutionSender(raw: unknown): ExecutionSender | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const sender: ExecutionSender = {};
  for (const key of ["userId", "openId", "type"] as const)
    if (typeof value[key] === "string" && value[key].trim()) sender[key] = value[key].trim();
  if (typeof value.member === "boolean") sender.member = value.member;
  return Object.keys(sender).length ? sender : undefined;
}

export function channelExecutionContext(binding: {
  identity?: unknown; sender?: unknown; origin?: unknown; createdBy?: string | null;
  routeType?: string; bindingId?: string;
}, identityDeclared = false): ExecutionContext {
  const actor = parseWireIdentity(binding.identity);
  if (binding.identity !== undefined && !actor) throw new Error("Malformed channel execution identity");
  if (!actor && identityDeclared) throw new Error("Channel execution identity is required");
  const identity = actor ?? (binding.createdBy ? userIdentity(binding.createdBy) : undefined);
  if (!identity) throw new Error("Legacy channel binding has no owner");
  if (actor?.kind === "binding" && actor.id !== binding.bindingId)
    throw new Error("Channel execution identity binding mismatch");
  const sender = parseExecutionSender(binding.sender);
  return { identity, ...(sender ? { sender } : {}),
    ...(binding.origin === "channel" || binding.origin === "dm" ? { origin: binding.origin } : {}) };
}

/** Stable native session ownership; unrelated to the current group's speaker. */
export function executionOwnerKey(identity: ExecutionIdentity, sessionId: string): string {
  return identity.kind === "user" ? identity.id : `${identity.kind}_${identity.id || sessionId}`;
}

export function executionAuditUser(context: ExecutionContext, legacy?: string | null): string {
  return context.sender?.userId || legacy || (context.identity.kind === "user" ? context.identity.id : "")
    || context.sender?.openId || "";
}
