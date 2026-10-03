import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { CodexExecutorPolicy, type CodexExecutorGrants } from "./codex-executor-policy.js";
import { CodexExecutorOutput } from "./codex-executor-output.js";

type JsonObject = Record<string, any>;
interface Connection {
  socket: WebSocket;
  child: ChildProcessWithoutNullStreams;
  policy: CodexExecutorPolicy;
  output: CodexExecutorOutput;
  pending: Map<string | number, { method: string; processId?: string }>;
}

/** An opt-in native executor relay, not a Pi tool bridge. The official
 * exec-server owns process/filesystem mechanics. This initial implementation
 * deliberately rejects reconnect, interactive IO and file-stream RPCs until
 * their full lifecycle and security contracts have been implemented. */
export class CodexExecutorRelay {
  private readonly token = randomBytes(32).toString("hex");
  private readonly connections = new Set<Connection>();
  private http?: Server;
  private websocket?: WebSocketServer;
  private address?: string;

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

  async start(): Promise<void> {
    if (this.http) return;
    fs.mkdirSync(this.options.home, { recursive: true, mode: 0o700 });
    const http = createServer((_request, response) => response.writeHead(403).end());
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

  private connect(socket: WebSocket): void {
    const child = spawn(this.options.executable, ["exec-server", "--listen", "stdio", "--strict-config"], {
      cwd: this.options.cwd,
      env: { PATH: process.env.PATH, HOME: this.options.home, CODEX_HOME: this.options.home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const connection: Connection = { socket, child, policy: new CodexExecutorPolicy(this.options.grants),
      output: new CodexExecutorOutput(), pending: new Map() };
    this.connections.add(connection);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try { this.backendMessage(connection, JSON.parse(line)); }
      catch { socket.close(1011, "Native executor output failed validation"); }
    });
    // Native diagnostics are not part of the model/UI stream.
    child.stderr.resume();
    child.once("error", () => socket.close(1011, "Native executor failed to start"));
    child.once("exit", () => socket.close(1011, "Native executor exited"));
    socket.on("message", (raw) => {
      let message: JsonObject;
      try { message = JSON.parse(raw.toString()); }
      catch { socket.close(1008, "Invalid native executor message"); return; }
      try {
        if (!object(message) || typeof message.method !== "string" ||
            (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number")) {
          throw new Error("Invalid native executor envelope");
        }
        if (message.method === "initialize" && message.params?.resumeSessionId) {
          throw new Error("Native executor reconnect is not implemented");
        }
        if (message.id !== undefined && connection.pending.has(message.id)) {
          throw new Error("Duplicate native executor request id");
        }
        const authorized = connection.policy.authorize(message.method, message.params ?? {});
        const processId = typeof authorized.params.processId === "string" ? authorized.params.processId : undefined;
        if (message.method === "process/read") {
          this.send(connection, { id: message.id,
            result: connection.output.read(processId!, Number(authorized.params.afterSeq ?? 0)) });
          return;
        }
        if (message.method === "process/start") {
          connection.output.register(processId!, authorized.command!.security);
        }
        if (message.id !== undefined) {
          connection.pending.set(message.id, { method: message.method, processId });
        }
        child.stdin.write(`${JSON.stringify({ ...message, params: authorized.params })}\n`);
      } catch (error) {
        if (message.id === undefined) socket.close(1008, "Unauthorized native executor notification");
        else this.send(connection, { id: message.id, error: { code: -32602,
          message: error instanceof Error ? error.message : "Native execution denied" } });
      }
    });
    socket.once("close", () => {
      lines.close();
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
      this.connections.delete(connection);
    });
  }

  private backendMessage(connection: Connection, message: JsonObject): void {
    if (!object(message)) throw new Error("Invalid native executor response");
    const params = message.params ?? {};
    if (message.method === "process/output") {
      connection.output.capture(params.processId, params.seq, params.stream, params.chunk);
      return;
    }
    if (message.method === "process/exited") {
      const chunks = connection.output.finish(params.processId, params.exitCode);
      for (const chunk of chunks) this.send(connection, { method: "process/output",
        params: { processId: params.processId, ...chunk } });
      this.send(connection, { method: "process/exited", params: {
        processId: params.processId, seq: chunks.length + 1, exitCode: params.exitCode,
        sandboxDenied: params.sandboxDenied ?? false } });
      return;
    }
    if (message.method === "process/closed") {
      connection.output.close(params.processId);
      this.send(connection, { method: "process/closed", params: { processId: params.processId,
        seq: connection.output.read(params.processId).nextSeq } });
      return;
    }
    if (message.method !== undefined) throw new Error("Unsupported native executor notification");
    const pending = connection.pending.get(message.id);
    if (!pending) throw new Error("Native executor response has no owning request");
    connection.pending.delete(message.id);
    if (message.error && pending.method === "process/start" && pending.processId) {
      connection.policy.releaseProcess(pending.processId);
      connection.output.release(pending.processId);
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
    this.send(connection, message);
  }

  private send(connection: Connection, value: JsonObject): void {
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify(value));
  }

  async close(): Promise<void> {
    const connections = [...this.connections];
    for (const connection of connections) connection.socket.close(1000);
    for (const connection of connections) {
      connection.child.stdin.end();
      connection.child.kill("SIGTERM");
    }
    await Promise.all(connections.map((connection) => new Promise<void>((resolve) => {
      if (connection.child.exitCode !== null || connection.child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => connection.child.kill("SIGKILL"), 2_000);
      connection.child.once("exit", () => { clearTimeout(timer); resolve(); });
      connection.child.once("error", () => { clearTimeout(timer); resolve(); });
    })));
    this.connections.clear();
    await new Promise<void>((resolve) => this.websocket ? this.websocket.close(() => resolve()) : resolve());
    await new Promise<void>((resolve) => this.http ? this.http.close(() => resolve()) : resolve());
    this.websocket = undefined;
    this.http = undefined;
    this.address = undefined;
  }
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
