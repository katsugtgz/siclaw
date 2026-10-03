import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
type ToolHooks = {
  before?: (id: string, name: string, args: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;
  after?: (id: string, name: string, args: unknown, result: ToolResult, isError: boolean) =>
    Promise<{ content?: ToolResult["content"]; details?: ToolResult["details"]; isError?: boolean } | undefined>;
};

/** Exposes only this Siclaw session's already-filtered tools to Codex. */
export class CodexToolBridge {
  private readonly token = randomBytes(32).toString("hex");
  private readonly tools: Map<string, ToolDefinition>;
  private http: HttpServer | undefined;
  private address: string | undefined;
  private toolTail: Promise<void> = Promise.resolve();

  constructor(tools: ToolDefinition[], private readonly context: () => ExtensionContext,
    private readonly hooks: ToolHooks = {}) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    if (this.tools.size !== tools.length) throw new Error("Duplicate Siclaw tool name");
  }

  get url(): string {
    if (!this.address) throw new Error("Codex tool bridge is not running");
    return this.address;
  }

  get bearerToken(): string { return this.token; }

  async start(): Promise<void> {
    if (this.http) return;
    const http = createServer((req, res) => {
      const supplied = req.headers.authorization?.replace(/^Bearer /i, "") ?? "";
      const expected = Buffer.from(this.token);
      const received = Buffer.from(supplied);
      if (req.url !== "/mcp" || received.length !== expected.length || !timingSafeEqual(received, expected)) {
        res.writeHead(403).end();
        return;
      }
      // MCP SDK stateless transports handle one HTTP request each. A fresh
      // server also allows Codex to reconnect after a session reload.
      const mcp = this.createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      void (async () => {
        try {
          await mcp.connect(transport);
          await transport.handleRequest(req, res);
        } catch {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        } finally {
          await mcp.close();
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", resolve);
    });
    const port = (http.address() as AddressInfo).port;
    this.http = http;
    this.address = `http://127.0.0.1:${port}/mcp`;
  }

  private createMcpServer(): Server {
    const mcp = new Server({ name: "siclaw", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this.tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters as { type: "object"; properties?: Record<string, unknown> },
      })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = this.tools.get(request.params.name);
      if (!tool) throw new Error(`Tool ${request.params.name} is not authorized for this session`);
      // The pre-call extension may enforce stateful policy. It must see the
      // result of every earlier call, just as it does in Pi's sequential path.
      const previous = this.toolTail;
      let release!: () => void;
      this.toolTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        if (extra.signal.aborted) throw new Error("Tool call cancelled");
        const metadata = request.params._meta as Record<string, unknown> | undefined;
        const toolCallId = typeof metadata?.callId === "string" && metadata.callId
          ? metadata.callId : randomUUID();
        const prepared = tool.prepareArguments
          ? tool.prepareArguments(request.params.arguments ?? {})
          : request.params.arguments ?? {};
        const args = validateToolArguments(tool, { type: "toolCall", id: toolCallId,
          name: tool.name, arguments: prepared as Record<string, unknown> });
        const decision = await this.hooks.before?.(toolCallId, tool.name, args);
        if (decision?.block) throw new Error(decision.reason || "Tool execution was blocked");
        let result: ToolResult;
        let isError = false;
        try {
          result = await tool.execute(toolCallId, args, extra.signal, undefined, this.context());
        } catch (error) {
          result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {} };
          isError = true;
        }
        const changed = await this.hooks.after?.(toolCallId, tool.name, args, result, isError);
        if (changed) {
          result = { ...result, content: changed.content ?? result.content, details: changed.details ?? result.details };
          isError = changed.isError ?? isError;
        }
        return {
          content: result.content.map((item) => {
            if (item.type === "image") return { type: "image" as const, data: item.data, mimeType: item.mimeType };
            return { type: "text" as const, text: item.type === "text" ? item.text : JSON.stringify(item) };
          }),
          ...(result.details && typeof result.details === "object"
            ? { structuredContent: result.details as Record<string, unknown> } : {}),
          ...(isError ? { isError: true } : {}),
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      } finally {
        release();
      }
    });
    return mcp;
  }

  async close(): Promise<void> {
    const http = this.http;
    this.http = undefined;
    this.address = undefined;
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }
}
