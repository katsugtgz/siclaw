import type { KubeconfigRef } from "./types.js";
import type { ProbeResult } from "../agentbox/credential-broker.js";
import { flattenClusterMeta } from "../tools/query/cluster-meta.js";
import { noResourcesExplanation } from "../shared/execution-identity.js";

/** Shared business data, independent of Pi tools and native MCP transport. */
export interface ProductServiceResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}
export interface ClusterListParams { name?: string; probe?: boolean }
export interface HostListParams { query?: string; limit?: number; cursor?: string }

export async function listBoundClusters(ref: KubeconfigRef, params: ClusterListParams,
  options: { refresh?: boolean; allowProbe?: boolean; signal?: AbortSignal } = {}): Promise<ProductServiceResult> {
  options.signal?.throwIfAborted();
  const broker = ref.credentialBroker;
  if (!broker) return failed("Credential broker not initialized for this session");
  if (params.probe && options.allowProbe === false) return failed("Cluster probing requires Kubernetes API command capability");
  if (options.refresh || !broker.isClustersReady()) {
    try { await broker.refreshClusters(); }
    catch (error) { return failed(`Failed to list clusters: ${error instanceof Error ? error.message : String(error)}`); }
  }
  options.signal?.throwIfAborted();
  let metas = broker.getClustersLocal();
  const boundTotal = metas.length;
  if (params.name) metas = metas.filter(meta => meta.name.toLowerCase().includes(params.name!.toLowerCase()));
  let probes: Map<string, ProbeResult> | undefined;
  if (params.probe && metas.length) {
    const values = await broker.probeClusters(metas.map(meta => meta.name));
    probes = new Map(values.map(value => [value.name, value]));
  }
  options.signal?.throwIfAborted();
  const entries = metas.map(meta => {
    const probe = probes?.get(meta.name);
    return { name: meta.name, description: meta.description ?? null, api_server: meta.api_server ?? null,
      is_production: meta.is_production,
      ...(meta.contexts ? { contexts: meta.contexts } : {}), ...(meta.current_context ? { current_context: meta.current_context } : {}),
      ...flattenClusterMeta(meta.meta), ...(probe ? { probe_status: probe.probe_status,
        ...(probe.probe_status !== "success" ? { probe_reason: probe.reason, probe_error: probe.probe_error } : { server_version: probe.server_version }),
        ...(probe.reachable !== undefined ? { reachable: probe.reachable } : {}) } : {}) };
  });
  const hint = !boundTotal ? "\n\n" + (ref.identity ? noResourcesExplanation("cluster", ref.identity)
    : "No clusters are bound to this agent. Ask the user to bind clusters in the Portal (Agent detail page).")
    : !entries.length ? `\n\nNo clusters match "${params.name}". Call cluster_list without a name to see all ${boundTotal} bound cluster(s).`
      : entries.length > 1 ? `\n\nIMPORTANT: ${entries.length} clusters ${params.name ? `match "${params.name}"` : "are bound"}. Ask the user which one to use, then set the \`cluster\` parameter (the cluster's name) on every kubectl/script tool call. Do NOT pick one yourself.` : "";
  const data = { clusters: entries };
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) + hint }], details: data };
}

export async function listBoundHosts(ref: KubeconfigRef, params: HostListParams, signal?: AbortSignal): Promise<ProductServiceResult> {
  signal?.throwIfAborted();
  const broker = ref.credentialBroker;
  if (!broker) return failed("Credential broker not initialized for this session");
  const query = typeof params.query === "string" ? params.query.trim() : "";
  let result;
  try { result = await broker.queryHosts(query, { limit: params.limit, cursor: params.cursor }); }
  catch (error) { return failed(`Failed to list hosts: ${error instanceof Error ? error.message : String(error)}`); }
  signal?.throwIfAborted();
  const entries = result.hosts.map(meta => ({ ...(meta.id ? { id: meta.id } : {}), name: meta.name, ip: meta.ip,
    port: meta.port, username: meta.username, auth_type: meta.auth_type, is_production: meta.is_production,
    ...(meta.description ? { description: meta.description } : {}), ...(meta.jump_host ? { jump_host: meta.jump_host } : {}) }));
  const hint = !entries.length ? query ? `\n\nNo hosts match "${query}".`
    : "\n\n" + (ref.identity ? noResourcesExplanation("host", ref.identity)
      : "No hosts are bound to this agent. Ask the user to bind hosts in the Portal (Agent detail page).")
    : result.next_cursor ? `\n\nShowing ${entries.length} of ${result.total}. Narrow the query, or pass cursor="${result.next_cursor}" for the next page.` : "";
  const data = { hosts: entries, total: result.total, next_cursor: result.next_cursor };
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) + hint }], details: data };
}

function failed(error: string): ProductServiceResult {
  return { content: [{ type: "text", text: JSON.stringify({ error }) }], details: { error: true } };
}
