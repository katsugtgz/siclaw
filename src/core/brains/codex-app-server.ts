import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonObject = Record<string, unknown>;
type Notification = { method: string; params: JsonObject };

/** A private stdio connection to one pinned Codex app-server process. */
export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (result: JsonObject) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly listeners = new Set<(event: Notification) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private closing = false;

  constructor(
    private readonly codexHome: string,
    private readonly environment: Record<string, string>,
    private readonly executable = process.env.SICLAW_CODEX_BIN || "codex",
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    this.closing = false;
    const child = spawn(this.executable, ["app-server", "--stdio", "--strict-config",
      "-c", "features.shell_tool=false",
      "-c", "features.apps=false",
      "-c", "features.plugins=false",
      "-c", "features.browser_use=false",
      "-c", "features.computer_use=false",
      "-c", "features.image_generation=false",
      "-c", "features.multi_agent=false",
    ], {
      // The child needs only its private model/MCP tokens. Do not inherit
      // AgentBox's kubeconfig, gateway, broker, or other user credentials.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE,
        ...this.environment,
        CODEX_HOME: this.codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    // Drain diagnostics without logging them: provider errors may contain secrets.
    child.stderr.resume();
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      this.child = undefined;
      if (!this.closing) this.failAll(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
    });
    try {
      await this.request("initialize", {
        clientInfo: { name: "siclaw", title: "Siclaw AgentBox", version: "1" },
        capabilities: { experimentalApi: false },
      }, 15_000);
      this.notify("initialized", {});
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  subscribe(listener: (event: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<JsonObject> {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("Codex app-server is unavailable");
    const id = this.nextId++;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params: JsonObject): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    this.failAll(new Error("Codex app-server closed"));
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      child.once("error", () => { clearTimeout(timeout); resolve(); });
    });
    child.stdin.end();
    child.kill("SIGTERM");
    await exited;
  }

  private handleLine(line: string): void {
    let message: JsonObject;
    try { message = JSON.parse(line) as JsonObject; } catch { return; }
    const id = message.id;
    if (typeof id === "number" && typeof message.method !== "string") {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = message.error as { message?: string } | undefined;
      if (error) pending.reject(new Error(error.message || "Codex request failed"));
      else pending.resolve((message.result ?? {}) as JsonObject);
      return;
    }
    if (typeof message.method !== "string") return;
    if (typeof id === "number") {
      // The Siclaw MCP bridge owns tool calls. Unexpected server requests must
      // fail closed, including command/file approvals and credential prompts.
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id,
        error: { code: -32601, message: "Siclaw does not authorize this request" } })}\n`);
      return;
    }
    const event = { method: message.method, params: (message.params ?? {}) as JsonObject };
    for (const listener of this.listeners) listener(event);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const listener of this.failureListeners) listener(error);
  }
}
