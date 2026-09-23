import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Drives the built server over real stdio against a real HTTP upstream, because
 * the parts most likely to break are the ones the unit tests stub: the shebang
 * entry, config loading from the environment, and the JSON-RPC framing.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// The repository's root suite collects this file without running the package
// build, so the test builds what it drives: a missing dist/ would time out, and
// a stale one would test old code. A build failure fails the suite with its
// compiler output rather than skipping the end-to-end check.
async function buildServer(): Promise<void> {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [tsc, "-p", packageRoot], { cwd: packageRoot }, (error, stdout, stderr) => {
      if (error) reject(new Error(`building mcp-siticket failed:\n${stdout}${stderr}`));
      else resolve();
    });
  });
}

const TICKET = { ticket_id: "t-1", status: "processing", title: "API 504" };
const PAGE = {
  ticket_id: "t-1",
  messages: [{ message_id: "945", content: "hello", attachments: [] }],
  has_more: true,
  next_after_message_id: "946",
};
const MODULES = { rows: [{ primary_product: "SRE" }], total: 1 };

let upstream: Server;
let baseUrl: string;
const seen: string[] = [];
const authorization: string[] = [];

beforeAll(buildServer, 120_000);

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push(url.pathname + url.search);
    authorization.push(req.headers.authorization ?? "");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/openapi/ticket/customer_im/get") {
      if (url.searchParams.get("ticket_id") !== "t-1") {
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 40401, message: "ticket not found" }));
        return;
      }
      res.end(JSON.stringify({ code: 0, message: "ok", data: TICKET }));
      return;
    }
    if (url.pathname === "/openapi/ticket/customer_im/chat-history") {
      res.end(JSON.stringify({ code: 0, message: "ok", data: PAGE }));
      return;
    }
    if (url.pathname === "/openapi/ticket_role/module/list") {
      res.end(JSON.stringify({ code: 0, message: "ok", data: MODULES }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 40401, message: "no such route" }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("no upstream port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

class StdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (message: Record<string, any>) => void>();

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [entry], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const resolve = this.pending.get(message.id);
        if (resolve) {
          this.pending.delete(message.id);
          resolve(message);
        }
      }
    });
  }

  call(method: string, params: unknown): Promise<Record<string, any>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async start(): Promise<void> {
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  stop(): void {
    this.child.kill();
  }

  async exitCode(): Promise<number | null> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    return new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
  }
}

function payload(response: Record<string, any>): unknown {
  return JSON.parse(response.result.content[0].text);
}

describe("stdio end to end", () => {
  it("serves the three read tools and returns upstream data unwrapped", async () => {
    const client = new StdioClient({ SITICKET_API_URL: baseUrl, SITICKET_API_TOKEN: "sk-e2e" });
    await client.start();
    try {
      const tools = await client.call("tools/list", {});
      expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "get_ticket",
        "get_ticket_messages",
        "list_ticket_modules",
      ]);

      const ticket = await client.call("tools/call", {
        name: "get_ticket",
        arguments: { ticket_id: "t-1" },
      });
      expect(payload(ticket)).toEqual(TICKET);

      const page = await client.call("tools/call", {
        name: "get_ticket_messages",
        arguments: { ticket_id: "t-1", limit: 1, after_message_id: "944" },
      });
      expect(payload(page)).toEqual(PAGE);
      expect(seen.some((path) => path.includes("after_message_id=944"))).toBe(true);
      expect(authorization).toContain("Bearer sk-e2e");

      const modules = await client.call("tools/call", { name: "list_ticket_modules", arguments: {} });
      expect(payload(modules)).toEqual(MODULES);

      const missing = await client.call("tools/call", {
        name: "get_ticket",
        arguments: { ticket_id: "t-absent" },
      });
      expect(missing.result.isError).toBe(true);
      expect(missing.result.content[0].text).toContain("ticket not found");
    } finally {
      client.stop();
    }
  });

  it("refuses a ticket outside the pin without calling upstream", async () => {
    const before = seen.length;
    const client = new StdioClient({
      SITICKET_API_URL: baseUrl,
      SITICKET_API_TOKEN: "sk-e2e",
      SITICKET_TICKET_ID: "t-1",
    });
    await client.start();
    try {
      const refused = await client.call("tools/call", {
        name: "get_ticket",
        arguments: { ticket_id: "t-other" },
      });
      expect(refused.result.isError).toBe(true);
      expect(refused.result.content[0].text).toContain("may only read ticket t-1");
      expect(seen.length).toBe(before);

      const allowed = await client.call("tools/call", { name: "get_ticket", arguments: {} });
      expect(payload(allowed)).toEqual(TICKET);
    } finally {
      client.stop();
    }
  });

  it("exits non-zero with an actionable message when the environment is incomplete", async () => {
    const client = new StdioClient({
      SITICKET_API_URL: baseUrl,
      SITICKET_API_TOKEN: "",
      SITICKET_API_TOKEN_FILE: "",
    });
    await expect(client.exitCode()).resolves.toBe(1);
  });
});
