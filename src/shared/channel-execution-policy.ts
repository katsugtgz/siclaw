/** Versioned control-plane authority. Never accepted from model/tool arguments. */
export interface ChannelExecutionPolicy {
  version: 1;
  revision: string;
  fingerprint: string;
  operations: readonly string[];
  namespaces: readonly string[];
  mcp: readonly { serverId: string; tools: readonly string[]; resources: readonly string[]; prompts: readonly string[];
    arguments: Readonly<Record<string, readonly string[]>> }[];
  knowledgeIds: readonly string[];
  reports: boolean;
  attachments: boolean;
}

const OPERATIONS = new Set(["query", "logs", "pod_exec", "ssh_exec", "scripts", "mcp", "knowledge", "reports", "attachments"]);
const strings = (v: unknown, limit = 128): v is string[] => Array.isArray(v) && v.length <= limit &&
  v.every(s => typeof s === "string" && s.length > 0 && s.length <= 256 && !/[\x00-\x1f]/.test(s));
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseChannelExecutionPolicy(raw: unknown): ChannelExecutionPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!object(raw) || raw.version !== 1 || typeof raw.revision !== "string" || !raw.revision || raw.revision.length > 256 ||
      typeof raw.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.fingerprint) || !strings(raw.operations) ||
      raw.operations.some(op => !OPERATIONS.has(op)) || !strings(raw.namespaces) ||
      raw.namespaces.some(ns => !/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(ns)) ||
      !strings(raw.knowledgeIds) || typeof raw.reports !== "boolean" || typeof raw.attachments !== "boolean" ||
      !Array.isArray(raw.mcp) || raw.mcp.length > 128) throw new Error("Invalid channel execution policy");
  for (const rule of raw.mcp) {
    if (!object(rule) || typeof rule.serverId !== "string" || !rule.serverId || !strings(rule.tools) ||
        !strings(rule.resources) || !strings(rule.prompts) || !object(rule.arguments) || Object.keys(rule.arguments).length > 32 ||
        Object.entries(rule.arguments).some(([key, value]) => !/^[A-Za-z0-9_.-]{1,128}$/.test(key) || !strings(value)))
      throw new Error("Invalid channel MCP policy");
  }
  return deepFreeze(structuredClone(raw)) as unknown as ChannelExecutionPolicy;
}

function deepFreeze(value: unknown): unknown {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

export function requireChannelOperation(policy: ChannelExecutionPolicy | undefined, operation: string): void {
  if (policy && !policy.operations.includes(operation)) throw new Error(`Channel operation is not authorized: ${operation}`);
}

export function requireChannelNamespace(policy: ChannelExecutionPolicy | undefined, namespace: string): void {
  if (policy && !policy.namespaces.includes(namespace)) throw new Error("Namespace is not authorized by this channel policy");
}
