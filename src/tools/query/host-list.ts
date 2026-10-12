import type { ToolEntry } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { KubeconfigRef } from "../../core/types.js";
import { listBoundHosts, type HostListParams } from "../../core/resource-list-service.js";

/**
 * host_list — list SSH-reachable hosts bound to the current agent.
 *
 * Pulls metadata from the gateway-side CredentialService through the
 * CredentialBroker. Only hosts explicitly bound via agent_hosts are returned.
 * Returns metadata only — no password / private_key. Connection credentials
 * are materialized on disk lazily by ensureHost when an SSH-using tool is
 * invoked (no such tool exists yet — host_list is the first host-aware tool).
 */
export function createHostListTool(kubeconfigRef: KubeconfigRef): ToolDefinition {
  return {
    name: "host_list",
    label: "Host List",
    description: `List SSH-reachable hosts bound to the current agent (server-side search; results are capped).
Returns id, name, IP, port, username, auth_type ("password"/"key"/"managed"), is_production, and jump_host (the bastion name when the host is reached via ProxyJump — host_exec/host_script tunnel through it automatically).
Does NOT return password or private_key — those are materialized to disk only when an SSH-using tool actually runs.
Pass "query" to filter by name / IP / description (an IP-looking query matches the IP exactly); omit it to browse all bound hosts (still capped).
The response includes "total" (full match count) and "next_cursor": if total exceeds what's shown, narrow the query or page with cursor.`,
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        description: "Filter by name / IP / description (server-side; an IP-looking value matches the IP exactly). Omit to browse all bound hosts.",
      })),
      limit: Type.Optional(Type.Number({
        description: "Max results per page (default 20, max 100).",
      })),
      cursor: Type.Optional(Type.String({
        description: "Opaque pagination cursor from a previous response's next_cursor.",
      })),
    }),
    async execute(_toolCallId, rawParams, signal) {
      return listBoundHosts(kubeconfigRef, (rawParams ?? {}) as HostListParams, signal);
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createHostListTool(refs.kubeconfigRef),
};
