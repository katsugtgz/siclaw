import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CodexToolBridge } from "./codex-tool-bridge.js";

const resources: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(resources.splice(0).reverse().map((resource) => resource.close()));
});

describe("CodexToolBridge", () => {
  it("exposes only session tools, authenticates the caller, and validates arguments", async () => {
    const execute = vi.fn(async (_id: string, params: { text: string }) => ({
      content: [{ type: "text" as const, text: params.text }],
    }));
    const context = vi.fn(() => ({ cwd: "/session" }) as ExtensionContext);
    const tool = {
      name: "echo", label: "Echo", description: "Echo text",
      parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      execute,
    } as unknown as ToolDefinition;
    const before = vi.fn(async (_id: string, _name: string, args: unknown) =>
      (args as { text: string }).text === "blocked" ? { block: true, reason: "Denied by extension" } : undefined);
    const after = vi.fn(async () => ({ content: [{ type: "text" as const, text: "transformed" }] }));
    const bridge = new CodexToolBridge([tool], context, { before, after });
    await bridge.start();
    resources.push(bridge);

    expect((await fetch(bridge.url, { method: "POST" })).status).toBe(403);

    const client = new Client({ name: "siclaw-test", version: "1" });
    resources.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${bridge.bearerToken}` } },
    }));
    expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(["echo"]);
    expect(await client.callTool({ name: "echo", arguments: { text: "ok" } }))
      .toMatchObject({ content: [{ type: "text", text: "transformed" }] });
    expect(context).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(before).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();

    expect(await client.callTool({ name: "echo", arguments: { text: "blocked" } }))
      .toMatchObject({ isError: true, content: [{ type: "text", text: "Denied by extension" }] });
    expect(execute).toHaveBeenCalledOnce();

    expect(await client.callTool({ name: "echo", arguments: {} }))
      .toMatchObject({ isError: true });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("runs stateful pre-call policy after the previous tool finishes", async () => {
    let completed = 0;
    const execute = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      completed++;
      return { content: [{ type: "text" as const, text: "done" }] };
    });
    const tool = {
      name: "once", label: "Once", description: "Run once",
      parameters: { type: "object", properties: {} }, execute,
    } as unknown as ToolDefinition;
    const bridge = new CodexToolBridge([tool], () => ({ cwd: "/session" }) as ExtensionContext, {
      before: async () => completed ? { block: true, reason: "Already ran" } : undefined,
    });
    await bridge.start();
    resources.push(bridge);
    const client = new Client({ name: "siclaw-test", version: "1" });
    resources.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${bridge.bearerToken}` } },
    }));

    const [first, second] = await Promise.all([
      client.callTool({ name: "once", arguments: {} }),
      client.callTool({ name: "once", arguments: {} }),
    ]);
    expect(first).toMatchObject({ content: [{ type: "text", text: "done" }] });
    expect(second).toMatchObject({ isError: true, content: [{ type: "text", text: "Already ran" }] });
    expect(execute).toHaveBeenCalledOnce();
  });
});
