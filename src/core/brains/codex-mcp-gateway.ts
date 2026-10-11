import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { mergeMcpStdioEnv, type McpServerConfig } from "../mcp-client.js";
import { McpModelSecurity, resolveMcpReadOnlyPolicy, mcpTransportEnv, mcpSensitiveValues, type McpReadOnlyPolicy } from "../mcp-security.js";
import { redactModelJson, type SensitiveValueSource } from "../../shared/model-output-redactor.js";
import { authorizeMcpArguments, mcpDigest } from "../mcp-operation-policy.js";
import { mcpConfigurationDigest, validateMcpPermit, type McpOperationAuthorizer, type McpOperation } from "../../shared/mcp-authorization.js";

interface Upstream {
  name: string;
  configurationDigest?: string;
  client?: Client;
  local?: (args: Record<string, unknown>, callId: string, signal: AbortSignal, name: string) => Promise<any>;
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
  private readonly intrinsic = new Map<string, { tools: Tool[]; call: NonNullable<Upstream["local"]> }>();
  private readonly stopping = new AbortController();
  private activeCalls = 0;
  private readonly activeRequests = new Set<AbortController>();

  cancelRequests(): void { for (const controller of this.activeRequests) controller.abort(); }

  constructor(private readonly configs: Record<string, McpServerConfig>, private readonly secrets: SensitiveValueSource = () => [],
    private readonly privateRoots: () => readonly string[] = () => [], private readonly authorize?: McpOperationAuthorizer) {}

  getTools(): Array<{ server: string; tool: Tool }> {
    return [...this.upstreams.values()].filter(entry => !entry.local).flatMap(entry => entry.tools.map(tool => ({ server: entry.name, tool })));
  }

  /** Match native item arguments against the exact sanitized product input. */
  projectProductArguments(args: Record<string, unknown>): Record<string, unknown> {
    const security = new McpModelSecurity(this.secrets, this.privateRoots);
    return redactModelJson(args, text => security.text(text));
  }

  /** Reviewed product service, independently implemented from Pi ToolDefinitions. */
  registerKnowledge(tool: Tool, call: NonNullable<Upstream["local"]>): void {
    this.registerService("siclaw_knowledge", [tool], call);
  }

  registerService(name: "siclaw_knowledge" | "siclaw_workflow", tools: Tool[], call: NonNullable<Upstream["local"]>): void {
    if (this.http || this.intrinsic.has(name) || this.configs[name]) throw new Error("Reserved product service name is already configured");
    this.intrinsic.set(name, { tools, call });
  }

  async start(): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error("MCP security gateway is closed");
    if (!Object.keys(this.configs).length && !this.intrinsic.size) return {};
    try {
      for (const [index, [name, config]] of Object.entries(this.configs).entries()) {
        const policy = resolveMcpReadOnlyPolicy(config);
        // Only native tool items have verified call attribution. Resource/prompt
        // policy alone must not launch a process, authenticate or expose a server.
        if (!policy.tools.size) continue;
        const client = new Client({ name: "siclaw-mcp-security", version: "1.0.0" }, { capabilities: {} });
        const security = new McpModelSecurity(() => [...mcpSensitiveValues(this.configs), ...this.secrets()], this.privateRoots);
        if (security.redact(name) !== name) throw new Error("MCP server names must not contain credentials");
        if ([...policy.resources, ...policy.prompts].some(value => security.redact(value) !== value)) {
          throw new Error("MCP resource/prompt handles must not contain credentials");
        }
        const entry: Upstream = { name, configurationDigest: mcpConfigurationDigest(config), client, policy, tools: [], security };
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
      for (const [name, intrinsic] of this.intrinsic) {
        const security = new McpModelSecurity(this.secrets, this.privateRoots);
        const policy: McpReadOnlyPolicy = { tools: new Set(intrinsic.tools.map(tool => tool.name)), resources: new Set(), prompts: new Set(), trustedRenderer: false };
        const route = name === "siclaw_knowledge" ? "/knowledge" : "/workflow";
        this.upstreams.set(route, { name, policy, security, tools: intrinsic.tools, local: intrinsic.call });
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
              const metadata = (params as any)._meta;
              // The native call id is trusted only after matching an owned
              // app-server item; model-visible arguments cannot choose it.
              delete (params as Record<string, unknown>)._meta;
              if (metadata && typeof metadata.callId === "string" && metadata.callId.length <= 256) {
                (params as any)._meta = { siclawNativeCallId: metadata.callId };
              }
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
      for (const [name] of this.intrinsic) native[name] = { url: `http://${this.address}/${name === "siclaw_knowledge" ? "knowledge" : "workflow"}`,
        http_headers: { Authorization: `Bearer ${this.token}` }, required: true, default_tools_approval_mode: "approve" };
      return native;
    } catch {
      await this.close();
      throw new Error("MCP security initialization failed; no unguarded connection is available");
    }
  }

  private async createSession(route: string, upstream: Upstream): Promise<Session> {
    // Match the owned-item authorization contract; never advertise unusable
    // resource/prompt methods or permit them through a permissive callback.
    const server = new Server({ name: "siclaw-readonly-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
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
      if (this.activeCalls >= 10) throw new McpError(ErrorCode.InvalidParams, "MCP call capacity exhausted");
      this.activeCalls++;
      const controller = new AbortController(); this.activeRequests.add(controller);
      let execution: "not_dispatched" | "unknown" | "finished" = "not_dispatched";
      try {
        const approved = upstream.local ? args : authorizeMcpArguments(upstream.policy.toolRules?.get(name), args);
        if (!upstream.policy.trustedRenderer) upstream.security.arguments(approved);
        const safeArgs = upstream.local ? this.projectProductArguments(approved)
          : upstream.policy.trustedRenderer ? JSON.parse(upstream.security.text(JSON.stringify(approved))) : approved;
        const signal = AbortSignal.any([extra.signal, controller.signal, this.stopping.signal, AbortSignal.timeout(65_000)]);
        const operation: McpOperation = { server: upstream.name, kind: "tool", name, arguments: safeArgs,
          callId: typeof request.params._meta?.siclawNativeCallId === "string" ? request.params._meta.siclawNativeCallId : "",
          configurationDigest: upstream.configurationDigest ?? "" };
        const permit = upstream.local ? undefined : validateMcpPermit(await this.requireAuthorizer()(operation, signal, "before"), operation);
        signal.throwIfAborted();
        execution = "unknown";
        const result = upstream.local
          ? await upstream.local(safeArgs, operation.callId, signal, name)
          : await upstream.client!.callTool({ name, arguments: safeArgs }, undefined, { signal, timeout: 65_000 });
        execution = "finished";
        if (permit) {
          const current = validateMcpPermit(await this.requireAuthorizer()(operation, signal, "after"), operation);
          if (mcpDigest(current) !== mcpDigest(permit)) throw new Error("MCP authorization changed before result delivery");
        }
        signal.throwIfAborted();
        return upstream.security.result(result, upstream.policy.trustedRenderer);
      } catch {
        const message = execution === "not_dispatched"
          ? "MCP operation failed: denied or authorization unavailable. No upstream operation was dispatched."
          : execution === "finished"
            ? "MCP operation failed: execution finished but result delivery was denied or suppressed. Do not automatically repeat the operation."
            : "MCP operation failed: execution outcome is unknown. Do not automatically retry. Upstream error details were suppressed.";
        return { isError: true, content: [{ type: "text", text: message }] };
      } finally { this.activeCalls--; this.activeRequests.delete(controller); }
    });
    // Unsupported resource/prompt methods keep the SDK's local MethodNotFound
    // refusal. Embedded text resources in allowed tool results still sanitize
    // through the existing result gate; they grant no resource-read authority.
    await server.connect(transport);
    return session;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopping.abort();
    this.cancelRequests();
    await Promise.allSettled([...this.sessions.values(), ...this.pendingSessions].map(session => session.server.close()));
    this.sessions.clear(); this.pendingSessions.clear();
    this.http?.closeAllConnections();
    await new Promise<void>(resolve => this.http ? this.http.close(() => resolve()) : resolve());
    await Promise.allSettled([...this.upstreams.values()].map(upstream => upstream.client?.close()));
    this.upstreams.clear(); this.http = undefined;
  }

  private requireAuthorizer(): McpOperationAuthorizer {
    if (!this.authorize) throw new Error("MCP dynamic authorization is unavailable");
    return this.authorize;
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
