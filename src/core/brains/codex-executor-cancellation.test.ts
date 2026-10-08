import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execute: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<object>(), spawn: mocks.spawn }));
vi.mock("./codex-infrastructure.js", async original => ({
  ...await original<object>(), executeInfrastructureOperation: mocks.execute,
}));
import { CodexExecutorRelay } from "./codex-executor-relay.js";

describe("native process cancellation owns infrastructure work", () => {
  it.each(["process/terminate", "process/signal", "process/exited", "session-stop"])(
    "cancels only the selected remote operation on %s without relying on HTTP disconnect", async method => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-cancel-"));
      const backend = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise<void>(resolve => backend.once("listening", resolve));
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
        exitCode: null, signalCode: null, kill: vi.fn(() => { child.exitCode = 0; child.emit("exit", 0); }),
      });
      mocks.spawn.mockImplementation(() => {
        queueMicrotask(() => child.stdout.write(`ws://127.0.0.1:${(backend.address() as { port: number }).port}\n`));
        return child;
      });
      const signals: AbortSignal[] = [];
      mocks.execute.mockImplementation(async (_target, _operation, signal: AbortSignal) => {
        signals.push(signal);
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { stdout: "", stderr: "", exitCode: 1 };
      });
      const transports: Promise<unknown>[] = [];
      let unclaimed: { endpoint: string; ticket: string } | undefined;
      let peer: WebSocket;
      backend.on("connection", socket => {
        peer = socket;
        socket.on("message", raw => {
          const request = JSON.parse(raw.toString());
          if (request.method === "process/start") {
            const command = request.params.argv[2];
            const endpoint = command.match(/http:\/\/127\.0\.0\.1:\d+\/infrastructure/)[0];
            const ticket = command.match(/[a-f0-9]{64}/)[0];
            if (request.params.processId === "unclaimed") unclaimed = { endpoint, ticket };
            else transports.push(fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${ticket}` } })
              .then(response => response.text()).catch(() => {}));
          }
          if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result:
            request.method === "initialize" ? { sessionId: "owned-native-session", environmentInfo: {} } : {} }));
        });
      });
      const relay = new CodexExecutorRelay({ executable: "/mock-native-executor", home: path.join(root, "home"), cwd: root,
        grants: { readRoots: [root], writeRoots: [], deniedRoots: [], allowCommands: true, production: false } });
      let socket: WebSocket | undefined;
      try {
        await relay.start();
        socket = new WebSocket(relay.url, { headers: { Authorization: `Bearer ${relay.bearerToken}` } });
        await new Promise<void>(resolve => socket!.once("open", resolve));
        let id = 0;
        const rpc = (method: string, params: object) => new Promise<any>(resolve => {
          const requestId = ++id;
          const receive = (raw: unknown) => {
            const reply = JSON.parse(String(raw));
            if (reply.id === requestId) { socket!.off("message", receive); resolve(reply); }
          };
          socket!.on("message", receive); socket!.send(JSON.stringify({ id: requestId, method, params }));
        });
        await rpc("initialize", {});
        await rpc("process/start", { processId: "unclaimed", argv: ["/bin/bash", "-c", "sleep 197"], cwd: pathToFileURL(root).href });
        await rpc("process/terminate", { processId: "unclaimed" });
        expect((await fetch(unclaimed!.endpoint, { method: "POST", headers: { Authorization: `Bearer ${unclaimed!.ticket}` } })).status).toBe(403);
        expect(signals).toHaveLength(0);
        for (const processId of ["selected", "unrelated"]) {
          await rpc("process/start", { processId, argv: ["/bin/bash", "-c", "sleep 197"], cwd: pathToFileURL(root).href });
        }
        await vi.waitFor(() => expect(signals).toHaveLength(2));
        expect((await rpc("process/terminate", { processId: "not-owned" })).error).toBeDefined();
        expect(signals.every(signal => !signal.aborted)).toBe(true);
        if (method === "session-stop") relay.cancelProcesses();
        else if (method === "process/exited") peer!.send(JSON.stringify({ method, params: { processId: "selected", exitCode: 1 } }));
        else expect((await rpc(method, { processId: "selected", signal: "SIGTERM" })).error).toBeUndefined();
        await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
        expect(signals[1].aborted).toBe(method === "session-stop");
        if (method === "session-stop") {
          const params = { processId: "new-request", argv: ["/bin/bash", "-c", "sleep 197"], cwd: pathToFileURL(root).href };
          expect((await rpc("process/start", params)).error).toBeDefined();
          relay.resumeProcesses();
          expect((await rpc("process/start", params)).error).toBeUndefined();
          await vi.waitFor(() => expect(signals).toHaveLength(3));
          expect(signals[2].aborted).toBe(false);
        }
      } finally {
        socket?.terminate();
        await relay.close();
        for (const client of backend.clients) client.terminate();
        await new Promise<void>(resolve => backend.close(() => resolve()));
        await Promise.all(transports);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
