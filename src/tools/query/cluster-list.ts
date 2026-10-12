import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { KubeconfigRef } from "../../core/types.js";
import { listBoundClusters, type ClusterListParams } from "../../core/resource-list-service.js";

/**
 * cluster_list — list and search the clusters bound to the current agent.
 * The single tool for cluster info (absorbed the former cluster_info and,
 * as an opt-in `probe` flag, the former cluster_probe).
 *
 * Pulls metadata from the gateway-side CredentialService through the
 * CredentialBroker. Only clusters explicitly bound via agent_clusters are
 * returned. Optional `name` filters by case-insensitive substring of the
 * cluster name. Emits admin-maintained structured `meta` when present.
 *
 * Connectivity is NOT tested by default (metadata is a cheap cached read that
 * touches no cluster). Pass `probe:true` to additionally run `kubectl version`
 * against every returned cluster in parallel and fold a three-state result into
 * each entry: success, unreachable, or probe_failed. Each non-success entry also
 * carries a structured `probe_reason` so the caller never has to infer intent
 * from raw kubectl prose:
 *   - `unreachable` (reason connection_refused/dns/network/connection_reset/
 *     timeout) is the ONLY state that means the cluster's API server could not
 *     be contacted — a statement about the cluster.
 *   - `probe_failed` (reason kubectl_missing/kubeconfig/credential/auth/authz/
 *     endpoint/tls_cert/timeout/unknown) is a LOCAL tooling, config, credential,
 *     or trust problem (or an operation timeout). It says NOTHING about the
 *     cluster being up — do not report the cluster as down on a probe_failed
 *     result. Two reasons are special: `auth` (401) and `authz` (403) mean the API
 *     server actually ANSWERED and adjudicated the identity/RBAC, so those entries
 *     additionally carry `reachable:true` — the cluster is up and the fix is this
 *     side's credentials/RBAC. A 404 is reported as `endpoint` WITHOUT
 *     `reachable:true`: an HTTP responder answered, but a wrong URL or intermediary
 *     can produce that without the real API server, so it is not proof of health.
 */
export function createClusterListTool(kubeconfigRef: KubeconfigRef, options: { allowProbe?: boolean } = {}): ToolDefinition {
  return {
    name: "cluster_list",
    label: "Cluster List",
    description: `List and search the Kubernetes clusters bound to this agent — the
authoritative source for which clusters exist and their admin-maintained context.
Each cluster always has \`name\` and \`is_production\`; the following appear only
when set: \`description\`, \`api_server\`, kube-context names (\`contexts\`/
\`current_context\`), and \`meta\` — structured infrastructure facts the admin
maintains that are NOT discoverable via kubectl (e.g. RDMA type, GPU scheduler,
CNI plugin, node model, storage backend), given as key→value pairs.
Pass \`name\` to narrow the list to clusters whose NAME contains that substring
(case-insensitive). By default this does NOT test connectivity; pass
\`probe:true\` to also run \`kubectl version\` against each returned cluster and
add \`probe_status\` (\`success\`/\`unreachable\`/\`probe_failed\`) plus, on any
non-success entry, a structured \`probe_reason\`.
ONLY \`unreachable\` (reason connection_refused/dns/network/connection_reset/
timeout) means the cluster's API server could not be reached. \`probe_failed\`
(reason kubectl_missing/kubeconfig/credential/auth/authz/endpoint/tls_cert/timeout/
unknown) is a LOCAL tooling, kubeconfig, credential, or certificate/trust problem
on THIS side — it says nothing about whether the cluster is up, so never report the
cluster as down or unreachable on a probe_failed result; surface the local/config
issue instead. Exception: reason \`auth\` (401) and \`authz\` (403) mean the API
server answered and adjudicated the request, so those entries carry
\`reachable:true\` — the cluster is up and the problem is this side's credentials/
RBAC. A 404 is reported as \`endpoint\` WITHOUT \`reachable\` (an HTTP responder
answered, but a wrong URL/intermediary can fake that). \`reachable\` is otherwise
omitted for \`probe_failed\`. Reach for
\`probe\` only when reachability is the question, as the first real kubectl/script
command already reveals an unreachable cluster. Call it before any kubectl/script
work to discover the available clusters; when several remain, ask the user which
to use rather than guessing.`,
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Narrow to clusters whose name contains this substring (case-insensitive). Omit to list all bound clusters." })),
      probe: Type.Optional(Type.Boolean({ description: "When true, run kubectl version for each cluster and include probe_status + probe_reason. Only probe_status=unreachable means the cluster's API server couldn't be reached; probe_status=probe_failed (reason kubectl_missing/kubeconfig/credential/auth/authz/endpoint/tls_cert/timeout/unknown) is a local tooling/config/credential/trust issue and does NOT mean the cluster is down. reachable is included for success (true), unreachable (false), and auth/authz probe_failed (true — a 401/403 means the server answered, so the cluster is up); omitted for other probe_failed reasons including endpoint (404) and tls_cert." })),
    }),
    async execute(_toolCallId, rawParams, signal) {
      return listBoundClusters(kubeconfigRef, (rawParams ?? {}) as ClusterListParams, { allowProbe: options.allowProbe, signal });
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createClusterListTool(refs.kubeconfigRef, { allowProbe: refs.allowClusterProbe }),
};
