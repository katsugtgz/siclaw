import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { CodexExecutorRelay } from "./codex-executor-relay.js";

describe("Codex native executor relay authentication", () => {
  it("rejects a WebSocket caller before starting any native backend", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-relay-auth-"));
    const relay = new CodexExecutorRelay({ executable: "/must-not-start-an-executor",
      home: path.join(root, "private"), cwd: root,
      grants: { readRoots: [root], writeRoots: [], deniedRoots: [], allowCommands: false, production: false } });
    try {
      await relay.start();
      const status = await new Promise<number>((resolve, reject) => {
        const client = new WebSocket(relay.url);
        client.once("unexpected-response", (_request, response) => {
          const status = response.statusCode ?? 0;
          response.resume();
          client.terminate();
          resolve(status);
        });
        client.once("open", () => { client.close(); reject(new Error("Unauthenticated native executor opened")); });
        client.on("error", () => {});
      });
      expect(status).toBe(403);
      expect((await fetch(relay.url.replace("ws://", "http://"))).status).toBe(403);
    } finally {
      await relay.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
