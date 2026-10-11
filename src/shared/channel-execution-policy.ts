/** Versioned control-plane authority. Never accepted from model/tool arguments. */
export interface ChannelExecutionPolicy {
  version: 1 | 2;
  revision: string;
  fingerprint: string;
  operations: readonly string[];
  namespaces: readonly string[];
  mcp: readonly { serverId: string; tools: readonly string[]; resources: readonly string[]; prompts: readonly string[];
    arguments: Readonly<Record<string, readonly string[]>> }[];
  knowledgeIds: readonly string[];
  reports: boolean;
  attachments: boolean;
  rules?: readonly ChannelResourceRule[];
}
export interface ChannelResourceRule {
  id: string;
  kind: "kubernetes" | "host" | "mcp" | "knowledge" | "conversation";
  clusterNames: readonly string[];
  hostNames: readonly string[];
  hostIds: readonly string[];
  authority: ChannelExecutionPolicy;
}

const OPERATIONS = new Set(["query", "logs", "pod_exec", "ssh_exec", "scripts", "mcp", "knowledge", "reports", "attachments"]);
const strings = (v: unknown, limit = 128): v is string[] => Array.isArray(v) && v.length <= limit &&
  v.every(s => typeof s === "string" && s.length > 0 && s.length <= 256 && !/[\x00-\x1f]/.test(s));
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseChannelExecutionPolicy(raw: unknown): ChannelExecutionPolicy | undefined {
  return parsePolicy(raw, false);
}
function parsePolicy(raw: unknown, leaf: boolean): ChannelExecutionPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!object(raw) || raw.version !== 1 && raw.version !== 2 || leaf && raw.version !== 1 || typeof raw.revision !== "string" || !raw.revision || raw.revision.length > 256 ||
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
  if(raw.version===1 && raw.rules!==undefined) throw new Error("Resource rules require channel policy version 2");
  if(raw.version===2){
    if(!Array.isArray(raw.rules)||!raw.rules.length||raw.rules.length>32)throw new Error("Invalid resource rules");
    const ids=new Set<string>();
    for(const r of raw.rules){
      if(!object(r)||typeof r.id!=="string"||!r.id||r.id.length>128||ids.has(r.id)||!['kubernetes','host','mcp','knowledge','conversation'].includes(String(r.kind))||!strings(r.clusterNames,10000)||!strings(r.hostNames,10000)||!strings(r.hostIds,10000)||!parsePolicy(r.authority,true))throw new Error("Invalid resource rule authority");
      ids.add(r.id);
    }
    const rules=raw.rules as unknown as ChannelResourceRule[];
    const same=(a:unknown,b:readonly string[])=>JSON.stringify([...(a as string[])].sort())===JSON.stringify([...new Set(b)].sort());
    if(!same(raw.operations,rules.flatMap(r=>[...r.authority.operations]))||!same(raw.namespaces,rules.flatMap(r=>[...r.authority.namespaces]))||!same(raw.knowledgeIds,rules.flatMap(r=>[...r.authority.knowledgeIds]))||raw.reports!==rules.some(r=>r.authority.reports)||raw.attachments!==rules.some(r=>r.authority.attachments))throw new Error("Resource rule aggregate mismatch");
  }
  return deepFreeze(structuredClone(raw)) as unknown as ChannelExecutionPolicy;
}

export function channelPolicyForCluster(policy: ChannelExecutionPolicy, cluster: string): ChannelExecutionPolicy {
  if(policy.version===1)return policy;
  return deepFreeze({...policy,rules:policy.rules!.filter(r=>r.kind==='kubernetes'&&r.clusterNames.includes(cluster))}) as ChannelExecutionPolicy;
}

export function requireChannelHostOperation(policy:ChannelExecutionPolicy|undefined,hostId:string,operation:string):void {
  requireChannelOperation(policy,operation);
  if(policy?.version===2&&!policy.rules!.some(r=>r.kind==='host'&&r.hostIds.includes(hostId)&&r.authority.operations.includes(operation)))throw new Error("Host operation is not authorized by a resource rule");
}

export function requireChannelNamespaceOperation(policy:ChannelExecutionPolicy,namespace:string,operation:string):void {
  if(policy.version===2){
    if(!policy.rules!.some(r=>r.kind==='kubernetes'&&r.authority.namespaces.includes(namespace)&&r.authority.operations.includes(operation)))throw new Error("Namespace operation is not authorized by a resource rule");
    return;
  }
  requireChannelNamespace(policy,namespace);requireChannelOperation(policy,operation);
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
