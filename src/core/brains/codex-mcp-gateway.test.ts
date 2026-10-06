import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, it, expect } from "vitest";
import { CodexMcpGateway } from "./codex-mcp-gateway.js";
import { McpClientManager } from "../mcp-client.js";

const fixture = path.resolve("scripts/test/fixtures/mcp-security-server.mjs");
const secret = "sre-fixture-secret.2026+october";
const env = { FIXTURE_SECRET: secret, SICLAW_MCP_READ_ONLY_TOOLS: '["read_fixture"]',
  SICLAW_MCP_READ_ONLY_RESOURCES: '["fixture://read"]', SICLAW_MCP_READ_ONLY_PROMPTS: '["diagnose"]' };

describe("native MCP pre-model security boundary", () => {
  it("uses native MCP with explicit read-only admission and sanitizes discovery, results, resources and prompts", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-mcp-security-"));
    const counter = path.join(directory, "calls");
    const gateway = new CodexMcpGateway({ fixture: { transport: "stdio", command: process.execPath,
      args: [fixture], env: { ...env, COUNTER_FILE: counter } } }, () => [secret]);
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
