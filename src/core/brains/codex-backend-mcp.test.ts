import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { CodexMcpGateway } from "./codex-mcp-gateway.js";
import { McpClientManager } from "../mcp-client.js";
import { NativeMcpAuthorization } from "../../gateway/mcp-authorization.js";
import type { CertificateIdentity } from "../../gateway/security/cert-manager.js";
import type { McpServerConfig } from "../mcp-client.js";

const fixture = path.resolve("scripts/test/fixtures/mcp-security-server.mjs");
const secret = "backend-mcp-fixture-secret";
const policy = JSON.stringify({ version: 1, tools: { write_fixture: { effect: "write", authorization: "backend" } } });

describe("backend-authorized tools through native MCP", () => {
  it("checks live Runtime policy, preserves effect and suppresses revoked results without replay", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "backend-native-mcp-"));
    const counter = path.join(root, "calls");
    const config: McpServerConfig = { transport: "stdio", command: process.execPath, args: [fixture],
      env: { FIXTURE_SECRET: secret, COUNTER_FILE: counter, SICLAW_MCP_OPERATION_POLICY: policy } };
    let selected = config;
    let revokeAfter = false;
    const runtime = new NativeMcpAuthorization({ request: async method => {
      if (method === "sandbox.resolve") return { user_id: "user" };
      if (method === "config.getResources") return { mcp_server_ids: ["server"] };
      if (method === "config.getMcpServers") return { mcpServers: { fixture: selected } };
      throw new Error("Unexpected control-plane method");
    } }, () => "user");
    const gateway = new CodexMcpGateway({ fixture: config }, () => [secret], () => [], async (operation, signal, phase) => {
      if (revokeAfter && phase === "after") selected = { ...config, env: { ...config.env,
        SICLAW_MCP_OPERATION_POLICY: JSON.stringify({ version: 1, tools: { write_fixture: { effect: "write" } } }) } };
      return runtime.authorize({ agentId: "agent", orgId: "org", boxId: "box" } as CertificateIdentity, "session", operation, signal);
    });
    const client = new Client({ name: "backend-native-test", version: "1" });
    try {
      const projected = await gateway.start();
      const proxy = projected.fixture as { url: string; http_headers: Record<string, string> };
      await client.connect(new StreamableHTTPClientTransport(new URL(proxy.url), { requestInit: { headers: proxy.http_headers } }));
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool => tool.name)).toEqual(["write_fixture"]);
      expect(tools[0].annotations?.readOnlyHint).toBe(false);
      expect(client.getInstructions()).toContain("REDACTED");
      expect(client.getInstructions()).not.toContain(secret);
      expect((await client.callTool({ name: "write_fixture", arguments: {} })).isError).not.toBe(true);
      revokeAfter = true;
      const revoked = await client.callTool({ name: "write_fixture", arguments: {} });
      expect(revoked.isError).toBe(true);
      expect(JSON.stringify(revoked)).toContain("Do not automatically repeat");
      expect(JSON.stringify(revoked)).not.toContain("mutated");
      expect(fs.readFileSync(counter, "utf8").trim().split("\n")).toEqual(["write_fixture", "write_fixture"]);
      const denied = await client.callTool({ name: "write_fixture", arguments: {} });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain("No upstream operation was dispatched");
      expect(fs.readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
    } finally { await client.close(); await gateway.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps Pi discovery and server instructions on the same reviewed policy", async () => {
    const manager = new McpClientManager({ mcpServers: { fixture: { transport: "stdio", command: process.execPath,
      args: [fixture], env: { FIXTURE_SECRET: secret, SICLAW_MCP_OPERATION_POLICY: policy } } } });
    try {
      await manager.initialize();
      expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__fixture__write_fixture"]);
      expect(manager.getServerInstructions()).toHaveLength(1);
      expect(manager.getServerInstructions()[0].instructions).not.toContain(secret);
      expect((await manager.getTools()[0].execute("call", {}, undefined, undefined, {} as never)).content)
        .toEqual([{ type: "text", text: "mutated" }]);
    } finally { await manager.shutdown(); }
  });
});
