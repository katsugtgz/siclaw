import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema, McpError, ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { mergeMcpStdioEnv, type McpServerConfig } from "../mcp-client.js";
import { McpModelSecurity, resolveMcpReadOnlyPolicy, mcpTransportEnv, mcpSensitiveValues, type McpReadOnlyPolicy } from "../mcp-security.js";
import type { SensitiveValueSource } from "../../shared/model-output-redactor.js";

interface Upstream {
  client: Client;
  policy: McpReadOnlyPolicy;
  tools: Tool[];
  security: McpModelSecurity;
}
interface Session { server: Server; transport: StreamableHTTPServerTransport; route: string }

/** Native MCP transport boundary. Codex still owns discovery and tool execution;
 * only authorized, sanitized protocol data crosses into its process. No Pi
 * ToolDefinition or AgentSession participates in this path. */
export class CodexMcpGateway {
  private readonly token = randomBytes(32).toString("hex");
  private readonly upstreams = new Map<string, Upstream>();
  private readonly sessions = new Map<string, Session>();
  private readonly pendingSessions = new Set<Session>();
  private http?: HttpServer;
  private address?: string;
  private closed = false;

  constructor(private readonly configs: Record<string, McpServerConfig>, private readonly secrets: SensitiveValueSource = () => [],
    private readonly privateRoots: () => readonly string[] = () => []) {}

  async start(): Promise<Record<string, unknown>> {
    if (!Object.keys(this.configs).length) return {};
    try {
      for (const [index, [name, config]] of Object.entries(this.configs).entries()) {
        const policy = resolveMcpReadOnlyPolicy(config);
        // No authorized operation means no connection, process launch or auth.
        if (!policy.tools.size && !policy.resources.size && !policy.prompts.size) continue;
        const client = new Client({ name: "siclaw-mcp-security", version: "1.0.0" }, { capabilities: {} });
        const security = new McpModelSecurity(() => [...mcpSensitiveValues(this.configs), ...this.secrets()], this.privateRoots);
        if ([...policy.resources, ...policy.prompts].some(value => security.redact(value) !== value)) {
          throw new Error("MCP resource/prompt handles must not contain credentials");
        }
        const entry: Upstream = { client, policy, tools: [], security };
        this.upstreams.set(`/mcp/${index}`, entry);
        const signal = AbortSignal.timeout(30_000);
        const transport = config.transport === "stdio"
          ? new StdioClientTransport({ command: config.command, args: config.args,
              env: mergeMcpStdioEnv(mcpTransportEnv(config.env), process.env, policy.trustedRenderer), stderr: "pipe" })
          : config.transport === "sse"
            ? new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers, redirect: "error" },
                fetch: (input, init) => fetch(input, { ...init, redirect: "error" }) })
            : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers, redirect: "error" } });
        if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
        await client.connect(transport, { signal });
        const names = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let bytes = 0;
        for (let page = 0; client.getServerCapabilities()?.tools && page < 32; page++) {
          const result = await client.listTools(cursor ? { cursor } : undefined, { signal });
          bytes += Buffer.byteLength(JSON.stringify(result));
          if (bytes > 4 * 1024 * 1024 || names.size + result.tools.length > 1000) throw new Error("MCP discovery budget exceeded");
          for (const tool of result.tools) {
            if (!tool.name || names.has(tool.name)) throw new Error("Invalid MCP inventory");
            names.add(tool.name);
            const safe = security.tool(tool, policy, config.description);
            if (safe) entry.tools.push(safe);
          }
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
          if (cursor.length > 4096 || cursors.has(cursor) || page === 31) throw new Error("Invalid MCP pagination");
          cursors.add(cursor);
        }
        if (this.closed) throw new Error("MCP security gateway closed during startup");
        // The original server URL/auth/env never becomes native configuration.
        // The native server name remains the configured name for UI compatibility.
        void name;
      }
      if (!this.upstreams.size) return {};
      this.http = createServer((request, response) => {
        void (async () => {
          const route = request.url ?? "";
          const upstream = this.upstreams.get(route);
          const provided = Buffer.from(request.headers.authorization ?? "");
          const expected = Buffer.from(`Bearer ${this.token}`);
          if (this.closed || !upstream || request.headers.origin !== undefined ||
              request.headers.host !== this.address || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
            request.resume(); response.writeHead(403).end(); return;
          }
          const sessionId = request.headers["mcp-session-id"];
          let session = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
          if (session && session.route !== route) { response.writeHead(403).end(); return; }
          if (!session && sessionId !== undefined) { response.writeHead(404).end(); return; }
          let body: unknown;
          if (request.method === "POST") {
            body = await readBody(request);
            // Only ordinary synchronous MCP requests. Tasks, opaque metadata,
            // batching and custom methods must not bypass the call gate.
            if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid MCP request");
            const params = (body as Record<string, unknown>).params;
            if (params && typeof params === "object") {
              if ("task" in params) throw new Error("MCP tasks are not authorized");
              // Native clients may attach progress/tracing metadata. Consume
              // it locally; never relay opaque client metadata upstream.
              delete (params as Record<string, unknown>)._meta;
            }
          }
          if (!session) {
            if (request.method !== "POST" || (body as Record<string, unknown>).method !== "initialize" ||
                this.sessions.size + this.pendingSessions.size >= 64) { response.writeHead(400).end(); return; }
            session = await this.createSession(route, upstream);
          }
          await session.transport.handleRequest(request, response, body);
        })().catch(() => {
          // Transport and upstream errors can contain URLs/headers/body secrets.
          if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP request rejected by the security gateway" } }));
        });
      });
      await new Promise<void>((resolve, reject) => { this.http!.once("error", reject); this.http!.listen(0, "127.0.0.1", resolve); });
      this.address = `127.0.0.1:${(this.http.address() as AddressInfo).port}`;
      const native: Record<string, unknown> = {};
      for (const [index, [name]] of Object.entries(this.configs).entries()) {
        if (this.upstreams.has(`/mcp/${index}`)) native[name] = { url: `http://${this.address}/mcp/${index}`,
          http_headers: { Authorization: `Bearer ${this.token}` }, required: true, default_tools_approval_mode: "approve" };
      }
      return native;
    } catch {
      await this.close();
      throw new Error("MCP security initialization failed; no unguarded connection is available");
    }
  }

  private async createSession(route: string, upstream: Upstream): Promise<Session> {
    const server = new Server({ name: "siclaw-readonly-mcp", version: "1.0.0" }, { capabilities: {
      tools: {}, ...(upstream.policy.resources.size ? { resources: {} } : {}), ...(upstream.policy.prompts.size ? { prompts: {} } : {}) } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
      onsessioninitialized: id => { this.pendingSessions.delete(session); this.sessions.set(id, session); } });
    const session: Session = { server, transport, route };
    this.pendingSessions.add(session);
    transport.onclose = () => { this.pendingSessions.delete(session); if (transport.sessionId) this.sessions.delete(transport.sessionId); };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: upstream.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      if (!upstream.tools.some(tool => tool.name === name) || !upstream.policy.tools.has(name) || this.closed) {
        throw new McpError(ErrorCode.InvalidParams, "MCP tool is not authorized by the read-only policy");
      }
      const args = request.params.arguments ?? {};
      if (!upstream.policy.trustedRenderer) upstream.security.arguments(args);
      try {
        const safeArgs = upstream.policy.trustedRenderer ? JSON.parse(upstream.security.text(JSON.stringify(args))) : args;
        const result = await upstream.client.callTool({ name, arguments: safeArgs }, undefined,
          { signal: extra.signal, timeout: 65_000 });
        return upstream.security.result(result, upstream.policy.trustedRenderer);
      } catch {
        return { isError: true, content: [{ type: "text", text: "MCP operation failed; upstream error details were suppressed." }] };
      }
    });
    // Never relay upstream capabilities, notifications, sampling, elicitation,
    // subscriptions or arbitrary methods. Explicitly selected text resources
    // and prompts retain native Codex support through the same result gate.
    if (upstream.policy.resources.size) {
      server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [...upstream.policy.resources].map(uri => ({ uri, name: "Authorized resource" })) }));
      server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
        if (!upstream.policy.resources.has(request.params.uri)) throw new McpError(ErrorCode.InvalidParams, "MCP resource is not authorized");
        upstream.security.arguments({ uri: request.params.uri });
        try {
          const result = await upstream.client.readResource({ uri: request.params.uri }, { signal: extra.signal, timeout: 30_000 });
          const safe = upstream.security.result({ content: result.contents.map(resource => ({ type: "resource", resource })) });
          return { contents: safe.content.map(block => block.type === "resource" ? block.resource
            : { uri: request.params.uri, text: block.type === "text" ? block.text : "Resource suppressed" }) };
        } catch { throw new McpError(ErrorCode.InternalError, "MCP resource read failed"); }
      });
    }
    if (upstream.policy.prompts.size) {
      server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [...upstream.policy.prompts].map(name => ({ name })) }));
      server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
        if (!upstream.policy.prompts.has(request.params.name)) throw new McpError(ErrorCode.InvalidParams, "MCP prompt is not authorized");
        upstream.security.arguments(request.params.arguments ?? {});
        try {
          const result = await upstream.client.getPrompt({ name: request.params.name, arguments: request.params.arguments }, { signal: extra.signal, timeout: 30_000 });
          if (JSON.stringify(result).length > 8 * 1024 * 1024 || result.messages.length > 1000) throw new Error("Oversized prompt");
          return { messages: result.messages.map(message => ({ role: message.role,
            content: upstream.security.result({ content: [message.content] }).content[0] })) };
        } catch { throw new McpError(ErrorCode.InternalError, "MCP prompt read failed"); }
      });
    }
    await server.connect(transport);
    return session;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.sessions.values(), ...this.pendingSessions].map(session => session.server.close()));
    this.sessions.clear(); this.pendingSessions.clear();
    this.http?.closeAllConnections();
    await new Promise<void>(resolve => this.http ? this.http.close(() => resolve()) : resolve());
    await Promise.allSettled([...this.upstreams.values()].map(upstream => upstream.client.close()));
    this.upstreams.clear(); this.http = undefined;
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 1024 * 1024) throw new Error("MCP request exceeds the safety budget");
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
