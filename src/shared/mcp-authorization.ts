import { mcpDigest } from "../core/mcp-operation-policy.js";

export interface McpOperation {
  server: string;
  kind: "tool" | "resource" | "prompt";
  name: string;
  arguments: Record<string, unknown>;
  /** Native item identity, never obtained from tool arguments. */
  callId: string;
  configurationDigest: string;
  /** Set by the selected operator policy, never by tool arguments. */
  effect?: "read" | "write";
}
export interface McpAuthorizationPermit {
  protocol: 1;
  effect: "read" | "write";
  agentId: string;
  userId: string;
  sessionId: string;
  server: string;
  kind: McpOperation["kind"];
  name: string;
  argumentsDigest: string;
  configurationDigest: string;
  policyDigest: string;
}
export type McpOperationAuthorizer = (operation: McpOperation, signal: AbortSignal,
  phase: "before" | "after") => Promise<McpAuthorizationPermit>;

/** Normalize only connection/authority fields; presentation text grants nothing.
 * No configuration values, credentials or this private digest reach Code Mode. */
export function mcpConfigurationDigest(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP configuration");
  const config = value as Record<string, unknown>;
  return mcpDigest({ transport: config.transport, url: config.url ?? null, command: config.command ?? null,
    args: config.args ?? [], env: config.env ?? {}, headers: config.headers ?? {} });
}

export function validateMcpPermit(value: unknown, operation: McpOperation,
  expectedEffect: McpAuthorizationPermit["effect"] = operation.effect ?? "read"): McpAuthorizationPermit {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP authorization unavailable");
  const permit = value as McpAuthorizationPermit;
  if (Object.keys(permit).some(key => !["protocol", "effect", "agentId", "userId", "sessionId", "server", "kind", "name", "argumentsDigest", "configurationDigest", "policyDigest"].includes(key)) ||
      permit.protocol !== 1 || !["read", "write"].includes(expectedEffect) || permit.effect !== expectedEffect ||
      [permit.agentId, permit.userId, permit.sessionId].some(value => typeof value !== "string" || !value || value.length > 256) ||
      permit.server !== operation.server || permit.kind !== operation.kind || permit.name !== operation.name ||
      permit.argumentsDigest !== mcpDigest(operation.arguments) || permit.configurationDigest !== operation.configurationDigest ||
      typeof permit.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(permit.policyDigest)) throw new Error("MCP authorization unavailable");
  return permit;
}
