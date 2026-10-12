// Source-built app-server and production UID boundary; no real model or resources.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CodexAgentBrain } from "../../dist/core/brains/codex-agent-brain.js";
import {
  createChannelKnowledgeView,
  disposeChannelKnowledgeView,
} from "../../dist/agentbox/channel-knowledge-view.js";
assert.ok(process.env.SICLAW_CODEX_BIN);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-fill-boundary-"));
fs.chmodSync(root, 0o755);
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { mode: 0o777 });
fs.chmodSync(workspace, 0o777);
fs.writeFileSync(path.join(workspace, "evidence.txt"), "SCOPED_EVIDENCE");
const source = path.join(root, "knowledge");
fs.mkdirSync(source);
fs.mkdirSync(path.join(source, "one"));
fs.writeFileSync(path.join(source, "one", "index.md"), "SELECTED_KNOWLEDGE");
fs.writeFileSync(
  path.join(source, ".citation-manifest.json"),
  JSON.stringify({ repos: [{ id: "one", root: "one" }] }),
);
const view = createChannelKnowledgeView(source, {
  version: 1,
  revision: "test",
  fingerprint: "a".repeat(64),
  operations: ["knowledge"],
  namespaces: [],
  mcp: [],
  knowledgeIds: ["one"],
  reports: false,
  attachments: false,
});
if (process.env.NODE_ENV === "production") {
  assert.equal(process.getuid(), 1000);
  for (const file of ["index.md", "repos/one/index.md"]) {
    const read = spawnSync(
      "sudo",
      ["-n", "-u", "sandbox", "--", "cat", path.join(view, file)],
      { encoding: "utf8" },
    );
    assert.equal(read.status, 0, read.stderr);
    assert.notEqual(
      spawnSync("sudo", [
        "-n",
        "-u",
        "sandbox",
        "--",
        "touch",
        path.join(view, file),
      ]).status,
      0,
    );
  }
  assert.notEqual(
    spawnSync("sudo", [
      "-n",
      "-u",
      "sandbox",
      "--",
      "touch",
      path.join(view, "new-file"),
    ]).status,
    0,
  );
}
let normal = false,
  calls = 0,
  schedules = 0,
  brain,
  fixtureError;
const output = (body, id) => {
  const value = body.input.find(
    (item) => item.type === "function_call_output" && item.call_id === id,
  )?.output;
  return typeof value === "string" ? value : JSON.stringify(value);
};
const fn = (name, args, id, namespace) => ({
  id,
  type: "function_call",
  ...(namespace ? { namespace } : {}),
  name,
  call_id: id,
  arguments: JSON.stringify(args),
  status: "completed",
});
const search = (id) => ({
  id,
  type: "tool_search_call",
  call_id: id,
  execution: "client",
  arguments: { query: "task_report manage_schedule", limit: 8 },
  status: "completed",
});
const answer = (id) => ({
  id,
  type: "message",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [{ type: "output_text", text: "Complete", annotations: [] }],
});
const model = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls++;
    let item;
    if (!normal) {
      if (calls === 1) item = search("restricted-search");
      else if (calls === 2)
        item = fn(
          "manage_schedule",
          { action: "list" },
          "forbidden-schedule",
          "mcp__siclaw_workflow",
        );
      else if (calls === 3) {
        assert.match(
          output(body, "forbidden-schedule"),
          /unknown|not|unsupported|ticket_fill_once/i,
        );
        assert.equal(schedules, 0);
        item = fn(
          "exec_command",
          { cmd: "cat evidence.txt", login: false },
          "read",
        );
      } else if (calls === 4) {
        assert.match(output(body, "read"), /SCOPED_EVIDENCE/);
        item = fn(
          "exec_command",
          { cmd: "touch forbidden-write", login: false },
          "write",
        );
      } else if (calls === 5) {
        assert.match(output(body, "write"), /ticket_fill_once|not authorized/);
        item = fn(
          "task_report",
          { summary: "Final fill" },
          "result",
          "mcp__siclaw_workflow",
        );
      } else {
        assert.equal(calls, 6);
        item = answer("final");
      }
    } else {
      if (calls === 1) item = search("normal-search");
      else if (calls === 2)
        item = fn(
          "manage_schedule",
          { action: "list" },
          "normal-list",
          "mcp__siclaw_workflow",
        );
      else {
        assert.equal(calls, 3);
        assert.equal(schedules, 1);
        item = answer("normal-final");
      }
    }
    const response = {
      id: `response-${normal}-${calls}`,
      object: "response",
      model: body.model,
      status: "completed",
      output: [item],
      usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type, value) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
      );
    send("response.created", {
      response: { ...response, status: "in_progress", output: [] },
    });
    send("response.output_item.added", {
      output_index: 0,
      item: {
        ...item,
        status: "in_progress",
        ...(item.type === "function_call"
          ? { arguments: "" }
          : item.type === "message"
            ? { content: [] }
            : {}),
      },
    });
    if (item.type === "function_call")
      send("response.function_call_arguments.delta", {
        output_index: 0,
        delta: item.arguments,
      });
    if (item.type === "message")
      send("response.output_text.delta", {
        output_index: 0,
        content_index: 0,
        delta: "Complete",
      });
    send("response.output_item.done", { output_index: 0, item });
    send("response.completed", { response });
    res.end();
  } catch (error) {
    fixtureError = error;
    res.writeHead(500).end();
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
try {
  const manager = SessionManager.create(workspace, path.join(root, "sessions"));
  brain = await CodexAgentBrain.create({
    sessionManager: manager,
    cwd: workspace,
    systemPrompt: "Use the supplied evidence and return the required result.",
    skillPaths: [],
    toolsetsByName: new Map(),
    codexMemoryEnabled: false,
    grants: {
      readRoots: [workspace],
      writeRoots: [workspace],
      deniedRoots: [],
      allowCommands: true,
      allowFileCommands: true,
      production: process.env.NODE_ENV === "production",
    },
    workflow: {
      schedule: true,
      report: true,
      sessionId: () => manager.getSessionId(),
      executionClient: {
        listAgentTasks: async () => {
          schedules++;
          return [];
        },
      },
    },
  });
  brain.registerProvider("fixture", {
    api: "openai-responses",
    apiKey: "synthetic",
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
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
  await brain.prompt("FINAL_FILL", undefined, {
    requiredResultToolName: "task_report",
    toolPolicy: "ticket_fill_once",
  });
  if (fixtureError) throw fixtureError;
  assert.equal(schedules, 0);
  assert.ok(!fs.existsSync(path.join(workspace, "forbidden-write")));
  normal = true;
  calls = 0;
  await brain.prompt("NORMAL_NEXT_TURN");
  if (fixtureError) throw fixtureError;
  assert.equal(schedules, 1);
  console.log(
    "Ticket fill smoke passed: native result-only catalog, side-effect denial, scoped reads, normal-turn restoration, UID1001 knowledge reads without writes",
  );
} finally {
  await brain?.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  disposeChannelKnowledgeView(view);
  fs.rmSync(root, { recursive: true, force: true });
}
