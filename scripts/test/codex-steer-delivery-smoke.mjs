// Real pinned native app-server; deterministic provider, no real credentials.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CodexAgentBrain } from "../../dist/core/brains/codex-agent-brain.js";
assert.ok(process.env.SICLAW_CODEX_BIN, "Use the pinned source-built Codex");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-steer-delivery-"));
let firstResolve,
  releaseResolve,
  brain,
  calls = 0;
const firstSeen = new Promise((resolve) => (firstResolve = resolve)),
  release = new Promise((resolve) => (releaseResolve = resolve));
const requests = [],
  events = [];
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const n = ++calls;
    if (n === 1) {
      firstResolve();
      await release;
    }
    const text = n === 1 ? "INITIAL_RESPONSE" : "STEER_CONSUMED";
    const item = {
      id: `message-${n}`,
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const response = {
      id: `response-${n}`,
      object: "response",
      model: body.model,
      status: "completed",
      output: [item],
      usage: { input_tokens: 30, output_tokens: 4, total_tokens: 34 },
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type, data) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    send("response.created", {
      response: { ...response, status: "in_progress", output: [] },
    });
    send("response.output_item.added", {
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    });
    send("response.output_text.delta", {
      output_index: 0,
      content_index: 0,
      delta: text,
    });
    send("response.output_item.done", { output_index: 0, item });
    send("response.completed", { response });
    res.end();
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let timer;
try {
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  brain = await CodexAgentBrain.create({
    sessionManager: manager,
    cwd: root,
    systemPrompt: "Answer briefly. No tools are needed.",
    skillPaths: [],
    toolsetsByName: new Map(),
    codexMemoryEnabled: false,
    grants: {
      readRoots: [],
      writeRoots: [],
      deniedRoots: [],
      allowCommands: false,
      allowFileCommands: false,
      production: false,
    },
  });
  brain.registerProvider("fixture", {
    api: "openai-responses",
    apiKey: "synthetic-steer-key",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [
      {
        id: "gpt-5.5",
        api: "openai-responses",
        contextWindow: 128000,
        maxTokens: 1000,
      },
    ],
  });
  await brain.setModel(brain.findModel("fixture", "gpt-5.5"));
  brain.subscribe((event) => events.push(event));
  const work = (async () => {
    const prompt = brain.prompt("BEGIN_STEER_FIXTURE");
    const early = brain.steer("BEGIN_STEER_FIXTURE", undefined, {
      messageId: "row-early",
    });
    await firstSeen;
    await early;
    await brain.steer("ADDITIONAL_STEER_FIXTURE", undefined, {
      messageId: "row-a",
    });
    await brain.steer("ADDITIONAL_STEER_FIXTURE", undefined, {
      messageId: "row-b",
    });
    releaseResolve();
    await prompt;
    const receipts = events
      .filter((e) => e.type === "message_start" && e.inputMessageId)
      .map((e) => e.inputMessageId);
    assert.deepEqual(
      receipts,
      ["row-early", "row-a", "row-b"],
      "Each actual native consumption must be projected once, even when batched/identical or sent during turn startup",
    );
    assert.ok(
      requests
        .slice(1)
        .some((body) =>
          JSON.stringify(body.input).includes("ADDITIONAL_STEER_FIXTURE"),
        ),
      "The real native model request must include the steers",
    );
    assert.deepEqual(brain.clearQueue(), { steering: [], followUp: [] });
  })();
  await Promise.race([
    work,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Error("Native steer delivery timed out")),
        60000,
      );
    }),
  ]);
  console.log(
    "Native steer delivery smoke passed: real app-server, duplicate text, in-flight provider request, consumption IDs and no false cancellation",
  );
} finally {
  clearTimeout(timer);
  releaseResolve();
  await brain?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
