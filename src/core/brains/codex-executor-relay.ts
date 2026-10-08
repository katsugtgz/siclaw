import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { CodexExecutorPolicy, type CodexExecutorGrants } from "./codex-executor-policy.js";
import { executeInfrastructureOperation, type InfrastructureOperation } from "./codex-infrastructure.js";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { shellEscape } from "../../tools/infra/command-sets.js";
import { redactModelJson } from "../../shared/model-output-redactor.js";
import { redactDataDocument } from "../../tools/infra/kubectl-sanitize.js";

type JsonObject = Record<string, any>;
interface Connection {
  socket: WebSocket;
  backend: WebSocket;
  sessionId?: string;
  detached?: NodeJS.Timeout;
  disposed?: boolean;
  resuming?: boolean;
  policy: CodexExecutorPolicy;
  pending: Map<string | number, { method: string; processId?: string }>;
}

/** An opt-in native executor relay, not a Pi tool bridge. The official
 * exec-server owns process/filesystem mechanics. This initial implementation
 * uses the official session registry for reconnect/replay. Interactive IO and
 * file-stream RPCs remain unavailable without reviewed grants. */
export class CodexExecutorRelay {
  private readonly token = randomBytes(32).toString("hex");
  private readonly connections = new Set<Connection>();
  private http?: Server;
  private backend?: { child: ChildProcessWithoutNullStreams; url: string; token: string };
  private startingBackend?: Promise<NonNullable<CodexExecutorRelay["backend"]>>;
  private closing = false;
  private launchesPaused = false;
  private readonly sessions = new Map<string, Connection>();
  private websocket?: WebSocketServer;
  private address?: string;
  private readonly tickets = new Map<string, { operation: InfrastructureOperation; connection: Connection; processId: string; abort: AbortController; expiresAt: number }>();
  private readonly infrastructureRuns = new Map<Connection, Map<string, AbortController>>();

  constructor(private readonly options: {
    executable: string;
    home: string;
    cwd: string;
    grants: CodexExecutorGrants;
  }) {}

  get url(): string {
    if (!this.address) throw new Error("Native executor relay is unavailable");
    return this.address;
  }
  get bearerToken(): string { return this.token; }

  /** Product Stop is stronger than interrupting a model's write_stdin wait.
   * Native yielded processes otherwise intentionally survive between turns. */
  cancelProcesses(): void {
    this.launchesPaused = true;
    for (const connection of this.connections) {
      for (const processId of [...this.infrastructureRuns.get(connection)?.keys() ?? []]) this.stopInfrastructure(connection, processId);
      connection.policy.stopAll();
    }
  }

  resumeProcesses(): void { this.launchesPaused = false; }

  async start(): Promise<void> {
    if (this.http) return;
    this.closing = false;
    fs.mkdirSync(this.options.home, { recursive: true, mode: 0o700 });
    const http = createServer(async (request, response) => {
      const ticket = request.headers.authorization?.replace(/^Bearer /i, "") ?? "";
      const entry = this.tickets.get(ticket);
      if (request.method !== "POST" || request.url !== "/infrastructure" || !entry || entry.expiresAt < Date.now() ||
          entry.connection.disposed || entry.abort.signal.aborted) {
        response.writeHead(403).end(); return;
      }
      this.tickets.delete(ticket);
      const { abort } = entry;
      response.once("close", () => { if (!response.writableEnded) abort.abort(); });
      let keepAlive: NodeJS.Timeout | undefined;
      try {
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.flushHeaders();
        const send = async (frame: object) => {
          abort.signal.throwIfAborted();
          if (!response.write(`${JSON.stringify(frame)}\n`)) await once(response, "drain", { signal: abort.signal });
        };
        // Fetch transports impose an idle body deadline. Keep silent native
        // processes alive without fabricating model-visible process output.
        keepAlive = setInterval(() => {
          if (!response.writableNeedDrain && !abort.signal.aborted) void send({ keepAlive: true }).catch(() => abort.abort());
        }, 15_000);
        keepAlive.unref();
        const result = await executeInfrastructureOperation(this.options.grants.infrastructure, entry.operation, abort.signal,
          this.options.grants.skillScripts, this.options.grants.environment, this.options.grants.resolveKubeconfig, this.options.grants.redactOutput,
          { sensitiveValues: this.options.grants.sensitiveValues, output: async (stream, text) => {
            // A frame stays below both HTTP client and native protocol budgets.
            const bytes = Buffer.from(text);
            for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
              await send({ stream, chunk: bytes.subarray(offset, offset + 32 * 1024).toString("base64") });
            }
          } });
        await send({ exitCode: result.exitCode });
        response.end();
      } catch { response.destroy(); }
      finally {
        if (keepAlive) clearInterval(keepAlive);
        const running = this.infrastructureRuns.get(entry.connection);
        if (running?.get(entry.processId) === abort) running.delete(entry.processId);
      }
    });
    const websocket = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
    http.on("upgrade", (request, socket, head) => {
      const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /i, "") ?? "");
      const expected = Buffer.from(this.token);
      if (request.url !== "/executor" || supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      websocket.handleUpgrade(request, socket, head, (client) => this.connect(client));
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", resolve);
    });
    this.http = http;
    this.websocket = websocket;
    this.address = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/executor`;
  }

  private async ensureBackend(): Promise<NonNullable<CodexExecutorRelay["backend"]>> {
    if (this.backend) return this.backend;
    if (this.startingBackend) return this.startingBackend;
    if (this.closing) throw new Error("Executor relay is closing");
    this.startingBackend = (async () => {
      const token = randomBytes(32).toString("hex");
      const child = spawn(this.options.executable, ["exec-server", "--listen", "ws://127.0.0.1:0", "--strict-config", "--concurrent-requests", "32",
        "--ws-auth", "capability-token", "--ws-token-sha256", createHash("sha256").update(token).digest("hex")], {
        cwd: this.options.cwd,
        env: { PATH: process.env.PATH, HOME: this.options.home, CODEX_HOME: this.options.home },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.resume();
      const url = await new Promise<string>((resolve, reject) => {
        const lines = createInterface({ input: child.stdout });
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Native executor startup timed out")); }, 15_000);
        const fail = () => { clearTimeout(timer); reject(new Error("Native executor failed to start")); };
        child.once("error", fail); child.once("exit", fail);
        lines.on("line", line => {
          if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(line)) return;
          clearTimeout(timer); child.removeListener("error", fail); child.removeListener("exit", fail);
          resolve(line);
        });
      });
      if (this.closing) { child.kill("SIGTERM"); throw new Error("Executor relay is closing"); }
      const backend = { child, url, token }; this.backend = backend;
      child.once("exit", () => {
        if (this.backend === backend) this.backend = undefined;
        for (const connection of [...this.connections]) this.dispose(connection);
      });
      return backend;
    })();
    try { return await this.startingBackend; }
    finally { this.startingBackend = undefined; }
  }

  private connect(socket: WebSocket): void {
    let connection: Connection | undefined;
    let initializing = false;
    socket.on("message", async raw => {
      let message: JsonObject;
      try { message = JSON.parse(raw.toString()); }
      catch { socket.close(1008, "Invalid native executor message"); return; }
      try {
        if (!object(message) || typeof message.method !== "string" ||
            (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number")) throw new Error("Invalid native executor envelope");
        if (!connection) {
          if (initializing || message.method !== "initialize" || message.id === undefined) throw new Error("Native executor must initialize first");
          initializing = true;
          const resume = message.params?.resumeSessionId ?? undefined;
          if (resume !== undefined && (typeof resume !== "string" || !resume || resume.length > 128)) throw new Error("Invalid native session identity");
          const owned = resume ? this.sessions.get(resume) : undefined;
          if (resume && (!owned || owned.disposed)) throw Object.assign(new Error(`unknown session id ${resume}`), { code: -32600 });
          if (owned && (!owned.detached || owned.resuming)) throw Object.assign(new Error(`session ${resume} is already attached to another connection`), { code: -32010 });
          if (owned) owned.resuming = true;
          if (!owned && this.connections.size >= 64) throw new Error("Native session capacity exceeded");
          const server = await this.ensureBackend();
          if (socket.readyState !== WebSocket.OPEN) return;
          const backend = new WebSocket(server.url, { headers: { Authorization: `Bearer ${server.token}` }, maxPayload: 2 * 1024 * 1024 });
          const current: Connection = owned ?? { socket, backend, policy: new CodexExecutorPolicy(this.options.grants), pending: new Map() };
          connection = current;
          if (current.detached) clearTimeout(current.detached);
          current.detached = undefined; current.socket = socket; current.backend = backend; current.pending.clear();
          this.connections.add(current);
          backend.on("message", raw => {
            if (current.backend !== backend) return;
            try { this.backendMessage(current, JSON.parse(raw.toString())); }
            catch { socket.close(1011, "Native executor output failed validation"); }
          });
          backend.on("error", () => { if (current.backend === backend) socket.close(1011, "Native executor connection failed"); });
          backend.once("close", () => { if (current.backend === backend) socket.close(1011, "Native executor disconnected"); });
          await new Promise<void>((resolve, reject) => { backend.once("open", resolve); backend.once("error", reject); backend.once("close", () => reject(new Error("Native executor unavailable"))); });
        } else if (message.method === "initialize") throw new Error("Native executor is already initialized");
        if (socket.readyState !== WebSocket.OPEN || connection.disposed) return;
        if (message.id !== undefined && connection.pending.has(message.id)) throw new Error("Duplicate native executor request id");
        if (message.method === "process/start" && this.launchesPaused) throw new Error("Native execution is stopped until the next user request");
        if (message.method === "process/start") await this.options.grants.validateChannelPolicy?.();
        const authorized = connection.policy.authorize(message.method, message.params ?? {});
        const processId = typeof authorized.params.processId === "string" ? authorized.params.processId : undefined;
        if (message.method === "process/start") {
          for (const entry of this.tickets.values()) if (entry.expiresAt < Date.now()) this.stopInfrastructure(entry.connection, entry.processId);
          if (this.tickets.size >= 64) throw new Error("Native execution launch capacity exceeded");
          const ticket = randomBytes(32).toString("hex");
          const operation: InfrastructureOperation = authorized.infrastructure ?? {
            kind: "local-command", command: authorized.command!.text, security: authorized.command!.security,
            cwd: String(authorized.params.cwd), environment: authorized.params.env as Record<string, string>, production: this.options.grants.production,
          };
          const abort = new AbortController();
          const running = this.infrastructureRuns.get(connection) ?? new Map<string, AbortController>();
          this.infrastructureRuns.set(connection, running); running.set(String(authorized.params.processId), abort);
          this.tickets.set(ticket, { operation, connection, processId: String(authorized.params.processId), abort, expiresAt: Date.now() + 15_000 });
          const helper = fileURLToPath(new URL("./codex-infrastructure-client.js", import.meta.url));
          const endpoint = this.address!.replace(/^ws:/, "http:").replace(/\/executor$/, "/infrastructure");
          connection.policy.setTransportCommand(authorized.params, [process.execPath, helper, endpoint, ticket].map(shellEscape).join(" "));
        }
        // Native termination can finish the local client before its HTTP close
        // is observed (or without a close at all). Cancel the sealed operation
        // by its already-authorized native identity, never another task's work.
        if (processId && ["process/signal", "process/terminate"].includes(message.method)) this.stopInfrastructure(connection, processId);
        if (message.id !== undefined) connection.pending.set(message.id, { method: message.method, processId });
        connection.backend.send(JSON.stringify({ ...message, params: authorized.params }));
      } catch (error) {
        if (message.id === undefined) socket.close(1008, "Unauthorized native executor notification");
        else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, error: { code: (error as { code?: number }).code ?? -32602,
          message: error instanceof Error ? error.message : "Native execution denied" } }));
      }
    });
    socket.once("close", () => {
      const current = connection;
      if (!current || current.socket !== socket || current.disposed) return;
      current.resuming = false;
      current.backend.close();
      // Native registry owns the 30-second detached session and process replay.
      // Retain only its authorization context, never process output or a job ledger.
      if (!current.sessionId) { this.dispose(current); return; }
      current.detached = setTimeout(() => this.dispose(current), 30_000);
      current.detached.unref();
    });
  }

  private dispose(connection: Connection): void {
    if (connection.disposed) return;
    connection.disposed = true;
    if (connection.detached) clearTimeout(connection.detached);
    if (connection.sessionId) this.sessions.delete(connection.sessionId);
    for (const [ticket, entry] of this.tickets) if (entry.connection === connection) this.tickets.delete(ticket);
    for (const abort of this.infrastructureRuns.get(connection)?.values() ?? []) abort.abort();
    this.infrastructureRuns.delete(connection);
    connection.policy.stopAll(); connection.backend.close(); connection.socket.close(1000);
    this.connections.delete(connection);
  }

  private stopInfrastructure(connection: Connection, processId: string): void {
    const running = this.infrastructureRuns.get(connection);
    running?.get(processId)?.abort();
    running?.delete(processId);
    for (const [ticket, entry] of this.tickets) {
      if (entry.connection === connection && entry.processId === processId) this.tickets.delete(ticket);
    }
  }

  private backendMessage(connection: Connection, message: JsonObject): void {
    if (!object(message)) throw new Error("Invalid native executor response");
    if (["process/output", "process/exited", "process/closed"].includes(message.method)) {
      if (message.method !== "process/output" && typeof message.params?.processId === "string") {
        this.stopInfrastructure(connection, message.params.processId);
      }
      // The fixed transport client's stdout/stderr already passed the security
      // gate. Preserve upstream sequence numbers and lifecycle unchanged.
      this.send(connection, message);
      return;
    }
    if (message.method !== undefined) throw new Error("Unsupported native executor notification");
    const pending = connection.pending.get(message.id);
    if (!pending) throw new Error("Native executor response has no owning request");
    connection.pending.delete(message.id);
    if (message.error && pending.method === "process/start" && pending.processId) {
      this.stopInfrastructure(connection, pending.processId);
      connection.policy.releaseProcess(pending.processId);
    }
    if (!message.error && pending.method === "initialize") {
      const id = message.result?.sessionId;
      if (typeof id !== "string" || !id || connection.sessionId && connection.sessionId !== id || this.sessions.has(id) && this.sessions.get(id) !== connection) throw new Error("Invalid native session identity");
      connection.sessionId = id; connection.resuming = false; this.sessions.set(id, connection);
    }
    if (message.error && pending.method === "initialize") {
      this.send(connection, message);
      if (connection.sessionId && message.error.code === -32010) connection.socket.close(1011, "Native session detach is pending");
      else this.dispose(connection);
      return;
    }
    if (!message.error && ["initialize", "environment/info"].includes(pending.method)) {
      const info = pending.method === "initialize" ? message.result?.environmentInfo : message.result;
      if (info) {
        // The relay's actor supplies its grants. Do not advertise methods that
        // bypass them through executor config or file/shell-state streams.
        info.capabilities = { ...info.capabilities, environmentConfigRead: false,
          sandboxedFileStreaming: false, fileWriteStreaming: false, shellSnapshotV2: false,
          capabilityDiscoveryV2: false, capabilityDiscoverySandbox: false };
      }
    }
    const redact = this.options.grants.redactOutput;
    if (redact && message.error) {
      message.error = { code: message.error.code, message: redact(String(message.error.message ?? "Native executor failed")) };
    } else if (redact && pending.method === "fs/readFile") {
      // Native filesystem reads return base64 bytes, bypassing process stdout.
      const content = message.result?.dataBase64;
      if (typeof content !== "string") throw new Error("Invalid native file output");
      const bytes = Buffer.from(content, "base64");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      message.result = { dataBase64: Buffer.from(redact(redactDataDocument(text).text)).toString("base64") };
    } else if (redact && message.result !== undefined && !pending.method.startsWith("process/")) {
      message.result = redactModelJson(message.result, redact);
    }
    this.send(connection, message);
  }

  private send(connection: Connection, value: JsonObject): void {
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify(value));
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const connection of [...this.connections]) this.dispose(connection);
    for (const socket of this.websocket?.clients ?? []) socket.terminate();
    const child = this.backend?.child; this.backend = undefined;
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.once("error", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
    await this.startingBackend?.catch(() => {});
    await new Promise<void>(resolve => this.websocket ? this.websocket.close(() => resolve()) : resolve());
    await new Promise<void>(resolve => this.http ? this.http.close(() => resolve()) : resolve());
    this.websocket = undefined; this.http = undefined; this.address = undefined;
  }

}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
