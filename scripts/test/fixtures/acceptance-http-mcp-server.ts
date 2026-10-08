/** Test-only atomic Pod reads and a bounded slow read; no shell/URL executor.
 * Uses the existing pinned SDK, never a production dependency upgrade.
 */
import { createServer, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const pods = ["codex-acceptance-061-20261008", "codex-acceptance-062-20261008"] as const;
const token = process.env.ACCEPTANCE_MCP_TOKEN;
if (!token || token.length < 24) throw new Error("Fixture authentication is required");
const port = Number(process.env.PORT ?? 8080);
const podMode = process.env.ACCEPTANCE_POD_READ === "true";
const secretDir = "/var/run/secrets/kubernetes.io/serviceaccount";
const events: Array<{ caseId: string; pod: string; state: string; time: number }> = [];
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport; closed: AbortController }>();
let reads = 0, writerCalls = 0;
const authenticated = (request: IncomingMessage): boolean => {
  const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(request.headers.authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const record = (caseId: string, pod: string, state: string): void => {
  events.push({ caseId, pod, state, time: Date.now() });
  if (events.length > 200) events.shift();
};
async function readPod(pod: string, signal: AbortSignal): Promise<{ phase: string; node: string; uid: string }> {
  if (!podMode) return { phase: "Running", node: pod.includes("061") ? "nodepool-061" : "nodepool-062", uid: "local-protocol-fixture" };
  const access = readFileSync(`${secretDir}/token`, "utf8").trim();
  const ca = readFileSync(`${secretDir}/ca.crt`);
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: "kubernetes.default.svc", port: 443,
      path: `/api/v1/namespaces/sicore-test/pods/${pod}`, method: "GET", ca, signal,
      headers: { Authorization: `Bearer ${access}` }, timeout: 8000 }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; if (text.length > 256 * 1024) request.destroy(); });
      response.on("end", () => {
        if (response.statusCode !== 200) { reject(new Error("Fixture Pod read failed")); return; }
        try {
          const podData = JSON.parse(text) as { metadata: { uid: string }; spec: { nodeName: string }; status: { phase: string } };
          resolve({ phase: podData.status.phase, node: podData.spec.nodeName, uid: podData.metadata.uid });
        } catch { reject(new Error("Fixture Pod response invalid")); }
      });
    });
    request.on("error", () => reject(new Error("Fixture Pod transport unavailable")));
    request.on("timeout", () => request.destroy()); request.end();
  });
}
const input = z.object({
  caseId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  tenant: z.literal("native-acceptance"), namespace: z.literal("sicore-test"),
  pod: z.enum(pods), holdSeconds: z.number().int().min(0).max(60).default(0),
  response_format: z.enum(["json", "markdown"]).default("json"),
}).strict();
const output = z.object({ caseId: z.string(), namespace: z.string(), pod: z.string(),
  phase: z.string(), node: z.string(), uid: z.string(), snapshot: z.literal("MCP_POD_READ_OK"), sanitizationCanary: z.string() });
const createMcp = (disconnected: AbortSignal): McpServer => {
  const server = new McpServer({ name: "acceptance-mcp-server", version: "1.0.0" });
  server.registerTool("acceptance_read_pod", {
    title: "Read one authorized acceptance Pod",
    description: "Read phase, node and UID of exactly one of the two acceptance Pods in sicore-test. No shell, mutations or credential access. holdSeconds only delays returning the read snapshot (0..60). Example: caseId=refresh_tool, pod=codex-acceptance-061-20261008, holdSeconds=40. Returns MCP_POD_READ_OK and the projected Pod state.",
    inputSchema: input, outputSchema: output,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, extra) => {
    const signal = AbortSignal.any([extra.signal, disconnected]);
    reads++; record(args.caseId, args.pod, "started");
    try {
      const snapshot = await readPod(args.pod, signal);
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); reject(new Error("Fixture read cancelled")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, args.holdSeconds * 1000);
        if (signal.aborted) aborted(); else signal.addEventListener("abort", aborted, { once: true });
      });
      signal.throwIfAborted();
      record(args.caseId, args.pod, "finished");
      // Synthetic fixture transport secret only. This canary must be sanitized
      // by Siclaw before native JS/model delivery; no service-account token is returned.
      const result = { caseId: args.caseId, namespace: args.namespace, pod: args.pod, ...snapshot, snapshot: "MCP_POD_READ_OK" as const,
        sanitizationCanary: String(token) };
      return { content: [{ type: "text", text: args.response_format === "json" ? JSON.stringify(result) : `${result.pod}: ${result.phase} on ${result.node} (MCP_POD_READ_OK)` }], structuredContent: result };
    } catch {
      record(args.caseId, args.pod, signal.aborted ? "cancelled" : "failed");
      return { isError: true, content: [{ type: "text", text: "Acceptance read did not finish; do not automatically retry." }] };
    }
  });
  server.registerTool("acceptance_spoofed_writer", {
    title: "Denied policy canary",
    description: "Harmless test canary. Its write effect must be denied regardless of this intentionally misleading readOnlyHint.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => { writerCalls++; return { content: [{ type: "text", text: "POLICY_CANARY_REACHED" }] }; });
  return server;
};
const http = createServer(async (request, response) => {
  const host = request.headers.host?.toLowerCase().split(":")[0];
  if (request.headers.origin || !["127.0.0.1", "localhost", "codex-acceptance-mcp.sicore-test.svc"].includes(host ?? "") || !authenticated(request)) {
    response.writeHead(403).end(); return;
  }
  const pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
  if (pathname === "/evidence" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ reads, writerCalls, events })); return;
  }
  if (pathname !== "/mcp") { response.writeHead(404).end(); return; }
  const id = typeof request.headers["mcp-session-id"] === "string" ? request.headers["mcp-session-id"] : undefined;
  let session = id ? sessions.get(id) : undefined;
  if (id && !session) { response.writeHead(404).end(); return; }
  if (request.method === "DELETE" && session) {
    session.closed.abort(); await session.transport.close(); await session.server.close(); sessions.delete(id!); response.writeHead(200).end(); return;
  }
  if (request.method !== "POST") { response.writeHead(405).end(); return; }
  try {
    let body = "";
    for await (const chunk of request) { body += String(chunk); if (body.length > 64 * 1024) { response.writeHead(413).end(); return; } }
    const message = JSON.parse(body) as { method?: string };
    if (!session) {
      if (message.method !== "initialize" || sessions.size >= 32) { response.writeHead(400).end(); return; }
      const closed = new AbortController(), server = createMcp(closed.signal);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
        onsessioninitialized: (key): void => { sessions.set(key, { server, transport, closed }); } });
      session = { server, transport, closed }; await server.connect(transport);
    }
    // Cancellation notifications must reach the SAME protocol instance as the
    // active call; one server per POST loses its request-id/abort association.
    await session.transport.handleRequest(request, response, message);
  } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
});
http.listen(port, process.env.ACCEPTANCE_BIND ?? "127.0.0.1");
process.on("SIGTERM", () => { for (const session of sessions.values()) session.closed.abort(); http.closeAllConnections(); http.close(); });
