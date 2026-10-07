import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, it, expect, vi } from "vitest";
import { CodexMcpGateway } from "./codex-mcp-gateway.js";
import { McpClientManager } from "../mcp-client.js";
import { mcpDigest } from "../mcp-operation-policy.js";
import type { McpOperationAuthorizer } from "../../shared/mcp-authorization.js";

const authorizeFixture: McpOperationAuthorizer = async operation => ({ protocol: 1, effect: "read", agentId: "a", userId: "u", sessionId: "s",
  server: operation.server, kind: operation.kind, name: operation.name, argumentsDigest: mcpDigest(operation.arguments),
  configurationDigest: operation.configurationDigest, policyDigest: "a".repeat(64) });

const fixture = path.resolve("scripts/test/fixtures/mcp-security-server.mjs");
const secret = "sre-fixture-secret.2026+october";
const env = { FIXTURE_SECRET: secret, SICLAW_MCP_READ_ONLY_TOOLS: '["read_fixture"]',
  SICLAW_MCP_READ_ONLY_RESOURCES: '["fixture://read"]', SICLAW_MCP_READ_ONLY_PROMPTS: '["diagnose"]' };

describe("native MCP pre-model security boundary", () => {
  it("uses native MCP with explicit read-only admission and sanitizes discovery, results, resources and prompts", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-mcp-security-"));
    const counter = path.join(directory, "calls");
    const gateway = new CodexMcpGateway({ fixture: { transport: "stdio", command: process.execPath,
      args: [fixture], env: { ...env, COUNTER_FILE: counter } } }, () => [secret], () => [], authorizeFixture);
    const client = new Client({ name: "native-test", version: "1.0.0" });
    try {
      const projected = await gateway.start();
      const cfg = projected.fixture as { url: string; http_headers: Record<string, string> };
      expect(JSON.stringify(projected)).not.toContain(secret);
      await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.http_headers } }));
      const list = await client.listTools();
      expect(list.tools.map(tool => tool.name)).toEqual(["read_fixture"]);
      expect(JSON.stringify(list)).not.toContain(secret);
      expect(list.tools[0].annotations?.readOnlyHint).toBe(true);
      await expect(client.callTool({ name: "write_fixture", arguments: {} })).rejects.toThrow(/not authorized/);
      expect(fs.existsSync(counter)).toBe(false);
      for (const mode of ["/etc/shadow", "%2Fetc%2Fshadow", "file:///root/.ssh/id_rsa"]) {
        await expect(client.callTool({ name: "read_fixture", arguments: { mode } })).rejects.toThrow(/not authorized/);
      }
      expect(fs.existsSync(counter)).toBe(false);
      const result = await client.callTool({ name: "read_fixture", arguments: {} });
      const wire = JSON.stringify(result);
      expect(wire).not.toContain(secret); expect(wire).not.toContain(Buffer.from(secret).toString("base64"));
      expect(wire).not.toContain("tiny"); expect(wire).toContain("healthy"); expect(wire).toContain("REDACTED");
      expect(result).not.toHaveProperty("_meta");
      expect(result.content.every(block => block.type === "text" || block.type === "resource")).toBe(true);
      const error = await client.callTool({ name: "read_fixture", arguments: { mode: "error" } });
      expect(JSON.stringify(error)).not.toContain(secret); expect(error.isError).toBe(true);
      const resource = await client.readResource({ uri: "fixture://read" });
      expect(JSON.stringify(resource)).not.toContain(secret); expect(JSON.stringify(resource)).toContain("REDACTED");
      await expect(client.readResource({ uri: "fixture://private" })).rejects.toThrow(/not authorized/);
      const prompt = await client.getPrompt({ name: "diagnose" });
      expect(JSON.stringify(prompt)).not.toContain(secret); expect(JSON.stringify(prompt)).toContain("REDACTED");
      await expect(client.getPrompt({ name: "mutate" })).rejects.toThrow(/not authorized/);
      const unauthorized = await fetch(cfg.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{}' });
      expect(unauthorized.status).toBe(403);
      const crossOrigin = await fetch(cfg.url, { method: "POST", headers: { ...cfg.http_headers, Origin: "https://attacker.invalid" }, body: '{}' });
      expect(crossOrigin.status).toBe(403);
      expect(fs.readFileSync(counter, "utf8").split("\n").filter(Boolean)).toEqual(["read_fixture", "read_fixture"]);
    } finally { await client.close(); await gateway.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not launch or authorize a server without an explicit policy even when it advertises readOnlyHint", async () => {
    const gateway = new CodexMcpGateway({ untrusted: { transport: "stdio", command: "must-not-launch" } });
    try { expect(await gateway.start()).toEqual({}); } finally { await gateway.close(); }
  });

  it("requires dynamic authorization and suppresses a result when authority changes after dispatch", async () => {
    let allow = false, phaseChange = false;
    const authorize = vi.fn<McpOperationAuthorizer>(async (operation, _signal, phase) => {
      if (!allow || phaseChange && phase === "after") throw new Error(`authorization error includes ${secret}`);
      return authorizeFixture(operation, _signal, phase);
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-native-mcp-permission-"));
    const counter = path.join(directory, "calls");
    const gateway = new CodexMcpGateway({ fixture: { transport: "stdio", command: process.execPath, args: [fixture], env: { ...env, COUNTER_FILE: counter } } },
      () => [secret], () => [], authorize);
    const client = new Client({ name: "native-permission-test", version: "1" });
    try {
      const projected = await gateway.start(); const config = projected.fixture as { url: string; http_headers: Record<string, string> };
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } }));
      const denied = await client.callTool({ name: "read_fixture", arguments: {} });
      expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).not.toContain(secret); expect(fs.existsSync(counter)).toBe(false);
      expect(JSON.stringify(denied)).toContain("No upstream operation was dispatched");
      allow = true; phaseChange = true;
      const revoked = await client.callTool({ name: "read_fixture", arguments: {} });
      expect(revoked.isError).toBe(true); expect(JSON.stringify(revoked)).not.toContain("healthy"); expect(JSON.stringify(revoked)).not.toContain(secret);
      expect(JSON.stringify(revoked)).toContain("Do not automatically repeat");
      expect(fs.readFileSync(counter, "utf8").trim()).toBe("read_fixture");
      phaseChange = false;
      expect((await client.callTool({ name: "read_fixture", arguments: {} })).isError).not.toBe(true);
    } finally { await client.close(); await gateway.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("never executes an explicitly configured write rule even with a permissive callback", async () => {
    const gateway = new CodexMcpGateway({ denied: { transport: "stdio", command: "must-not-launch", env: {
      SICLAW_MCP_READ_ONLY_TOOLS: '["write_fixture"]', SICLAW_MCP_OPERATION_POLICY: '{"version":1,"tools":{"write_fixture":{"effect":"write"}}}',
    } } }, () => [], () => [], authorizeFixture);
    try { expect(await gateway.start()).toEqual({}); } finally { await gateway.close(); }
  });

  it("does not project a server namespace containing a known credential", async () => {
    const gateway = new CodexMcpGateway({ [secret]: { transport: "stdio", command: "must-not-launch", env } }, () => [secret], () => [], authorizeFixture);
    await expect(gateway.start()).rejects.toThrow(/security initialization failed/);
    await gateway.close();
  });

  it("Pi uses the same admission and output policy before ToolDefinition results", async () => {
    const manager = new McpClientManager({ mcpServers: { fixture: { transport: "stdio", command: process.execPath,
      args: [fixture], env } } });
    try {
      await manager.initialize();
      expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__fixture__read_fixture"]);
      expect(JSON.stringify(manager.getTools().map(tool => ({ description: tool.description, parameters: tool.parameters })))).not.toContain(secret);
      const result = await manager.getTools()[0].execute("call", {}, undefined, undefined, {} as never);
      expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(result)).toContain("REDACTED");
      expect(result.content.every(block => block.type === "text")).toBe(true);
    } finally { await manager.shutdown(); }
  });
});
