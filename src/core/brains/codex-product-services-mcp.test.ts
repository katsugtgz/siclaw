import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { CodexMcpGateway } from "./codex-mcp-gateway.js";
import { CodexWorkflow } from "./codex-workflow.js";

describe("native product protocol and pre-persistence redaction", () => {
  it("serves bound metadata and a sanitized owned feedback receipt through the real MCP SDK", async () => {
    const secret = "private-native-product-canary.20261007";
    const broker = { isClustersReady: () => true, refreshClusters: vi.fn().mockResolvedValue([]),
      getClustersLocal: () => [{ name: "test", is_production: false, password: secret }],
      queryHosts: vi.fn().mockResolvedValue({ hosts: [{ name: "host", ip: "10.0.0.1", port: 22, username: "reader",
        auth_type: "key", is_production: false, private_key: secret }], total: 1, next_cursor: null }),
      acquireCluster: vi.fn(), acquireHost: vi.fn() };
    const persist = vi.fn().mockResolvedValue({ id: "report-receipt" });
    const gateway = new CodexMcpGateway({}, () => [secret]);
    const service = new CodexWorkflow({ schedule: false, report: false, sessionId: () => "owner-session", clusterList: true, hostList: true,
      kubeconfigRef: { credentialBroker: broker as never }, feedback: { userId: "owner", persist },
      active: () => ({ threadId: "root", turnId: "turn" }), projectArguments: args => gateway.projectProductArguments(args) });
    gateway.registerService("siclaw_workflow", service.tools, (args, id, signal, name) => service.call(args, id, signal, name));
    const client = new Client({ name: "product-fixture", version: "1" });
    const invoke = async (name: string, args: Record<string, unknown>, id: string) => {
      service.observe({ method: "item/started", params: { threadId: "root", turnId: "turn",
        item: { id, type: "mcpToolCall", server: "siclaw_workflow", tool: name, arguments: args } } });
      return client.callTool({ name, arguments: args, _meta: { callId: id } });
    };
    try {
      const config = (await gateway.start()).siclaw_workflow as { url: string; http_headers: Record<string, string> };
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } }));
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(["cluster_list", "host_list", "save_feedback"]);
      const clusters = await invoke("cluster_list", {}, "clusters"); expect(clusters.isError).toBe(false);
      expect(clusters.structuredContent).toMatchObject({ clusters: [{ name: "test" }] });
      const hosts = await invoke("host_list", { limit: 20 }, "hosts"); expect(hosts.isError).toBe(false);
      expect(JSON.stringify([clusters, hosts])).not.toContain(secret);
      const feedback = await invoke("save_feedback", { overallRating: 5, summary: `Review ${secret}` }, "feedback");
      expect(feedback.isError).toBe(false); expect(feedback.structuredContent).toHaveProperty("id", "report-receipt");
      expect(JSON.stringify(persist.mock.calls)).not.toContain(secret); expect(JSON.stringify(persist.mock.calls)).toContain("REDACTED");
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "owner-session", userId: "owner" }));
      expect(broker.acquireCluster).not.toHaveBeenCalled(); expect(broker.acquireHost).not.toHaveBeenCalled();
    } finally { await client.close(); service.close(); await gateway.close(); }
  });
});
