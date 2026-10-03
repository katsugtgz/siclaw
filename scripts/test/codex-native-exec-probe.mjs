// Architecture probe only: a fixed fake model exercises upstream native tools
// against an upstream exec-server in a temporary workspace. This does not enable
// native tools in the production integration or replace Siclaw's security gate.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const executable = process.env.SICLAW_CODEX_BIN;
assert.ok(executable, "Set SICLAW_CODEX_BIN to the pinned source-built Codex CLI");
const root = mkdtempSync(join(tmpdir(), "siclaw-native-codex-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { mode: 0o700 });
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
let calls = 0;
let fixtureError;
let toolOutputs = [];
const seenTools = new Set();
const patch = "*** Begin Patch\n*** Add File: native-probe.txt\n+created by native apply_patch\n*** End Patch\n";
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    toolOutputs = body.input.filter((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output");
    assert.equal(request.url, "/v1/responses");
    const tools = body.tools ?? body.input.find((item) => item.type === "additional_tools")?.tools;
    assert.ok(Array.isArray(tools), "native tool schemas must be present in Responses or Responses Lite");
    const recordTools = (items) => {
      for (const tool of items) {
        if (tool.name) seenTools.add(tool.name);
        if (Array.isArray(tool.tools)) recordTools(tool.tools);
        if (Array.isArray(tool.functions)) recordTools(tool.functions);
      }
    };
    recordTools(tools);
    assert.ok(seenTools.has("exec_command"), `upstream native exec_command must be exposed; tools=${[...seenTools].join(",")}`);
    assert.ok(seenTools.has("apply_patch"), "upstream native apply_patch must be exposed");
    assert.ok(![...seenTools].some((name) => name.startsWith("mcp__siclaw")));
    calls++;
    if (calls === 2) assert.match(JSON.stringify(body.input), /native-command-ok/);
    const item = calls === 1
      ? { id: "exec-1", type: "function_call", name: "exec_command", call_id: "exec-call-1",
        arguments: JSON.stringify({ cmd: "printf native-command-ok", workdir: workspace,
          login: false, max_output_tokens: 200 }), status: "completed" }
      : calls === 2
        ? { id: "patch-1", type: "custom_tool_call", name: "apply_patch", call_id: "patch-call-1",
          input: patch, status: "completed" }
        : { id: "answer-1", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "native tools complete", annotations: [] }] };
    const envelope = { id: `native-response-${calls}`, object: "response", model: body.model,
      status: "completed", output: [item], created_at: Math.floor(Date.now() / 1000),
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    send("response.created", { response: { ...envelope, status: "in_progress", output: [] } });
    send("response.output_item.added", { output_index: 0, item: { ...item,
      ...(item.type === "function_call" ? { arguments: "" } : {}),
      ...(item.type === "custom_tool_call" ? { input: "" } : {}), status: "in_progress" } });
    if (item.type === "function_call") {
      send("response.function_call_arguments.delta", { output_index: 0, delta: item.arguments });
    } else if (item.type === "custom_tool_call") {
      send("response.custom_tool_call_input.delta", { output_index: 0, delta: patch });
    } else {
      send("response.output_text.delta", { output_index: 0, content_index: 0, delta: "native tools complete" });
    }
    send("response.output_item.done", { output_index: 0, item });
    send("response.completed", { response: envelope });
    response.end();
  } catch (error) {
    fixtureError = error;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const portServer = createServer();
const execPort = await listen(portServer);
await new Promise((resolve) => portServer.close(resolve));
const modelPort = await listen(model);
const children = [];
function child(args, home) {
  mkdirSync(home, { mode: 0o700 });
  const process = spawn(executable, args, { cwd: workspace, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: globalThis.process.env.PATH, HOME: home, CODEX_HOME: home,
      SICLAW_NATIVE_PROBE_MODEL_TOKEN: "fake-probe-key" } });
  children.push(process);
  process.stderr.resume();
  return process;
}
const executor = child(["exec-server", "--listen", `ws://127.0.0.1:${execPort}`,
  "--ws-auth", "capability-token", "--ws-token-sha256", tokenHash,
  "--strict-config", "-c", "sandbox_mode=\"workspace-write\""], join(root, "executor-home"));
const app = child(["app-server", "--stdio", "--strict-config",
  "-c", "features.shell_tool=true", "-c", "features.unified_exec=true",
  "-c", "features.code_mode=false", "-c", "features.multi_agent=false"], join(root, "app-home"));
let nextId = 1;
const pending = new Map();
const events = [];
const lines = createInterface({ input: app.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) {
    if (message.id !== undefined) {
      app.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601,
        message: "probe does not approve server requests" } })}\n`);
    } else events.push(message);
  } else {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    app.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

try {
  await rpc("initialize", { clientInfo: { name: "siclaw-native-probe", version: "1" },
    capabilities: { experimentalApi: true } });
  app.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  await rpc("environment/add", { environmentId: "siclaw-native-probe",
    execServerUrl: `ws://127.0.0.1:${execPort}`, authBearerToken: token, connectTimeoutMs: 10_000 });
  const info = await rpc("environment/info", { environmentId: "siclaw-native-probe" });
  assert.ok(info.shell.path);
  const started = await rpc("thread/start", { model: "gpt-5.5", modelProvider: "fixture",
    cwd: workspace, sandbox: "workspace-write", approvalPolicy: "never",
    environments: [{ environmentId: "siclaw-native-probe", cwd: workspace, runtimeWorkspaceRoots: [workspace] }],
    config: { web_search: "disabled", project_doc_max_bytes: 0,
      model_providers: { fixture: { name: "Native probe", base_url: `http://127.0.0.1:${modelPort}/v1`,
        env_key: "SICLAW_NATIVE_PROBE_MODEL_TOKEN", wire_api: "responses", request_max_retries: 0,
        stream_max_retries: 0 } } } });
  await rpc("turn/start", { threadId: started.thread.id,
    input: [{ type: "text", text: "Run the fixed architecture probe." }] });
  const deadline = Date.now() + 30_000;
  while (!events.some((event) => event.method === "turn/completed")) {
    assert.ok(Date.now() < deadline, "native turn timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const completed = events.find((event) => event.method === "turn/completed");
  assert.equal(completed.params.turn.status, "completed", fixtureError?.message
    ?? JSON.stringify(completed.params.turn.error));
  assert.equal(calls, 3);
  const command = events.find((event) => event.method === "item/completed"
    && event.params?.item?.type === "commandExecution")?.params.item;
  assert.equal(command?.exitCode, 0, `the native command must execute successfully: ${JSON.stringify(command)}`);
  assert.match(command.aggregatedOutput, /native-command-ok/);
  assert.ok(existsSync(join(workspace, "native-probe.txt")),
    `native apply_patch did not create the file: ${JSON.stringify(toolOutputs).slice(0, 2000)}`);
  assert.equal(readFileSync(join(workspace, "native-probe.txt"), "utf8"), "created by native apply_patch\n");
  assert.ok(events.some((event) => event.params?.item?.type === "fileChange"));
  console.log("Native execution probe passed: official app-server + exec-server, exec_command, apply_patch, no Pi or Siclaw MCP tools");
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  for (const process of children) {
    process.stdin.end();
    process.kill("SIGTERM");
  }
  await Promise.all(children.map((process) => process.exitCode !== null || process.signalCode !== null ? undefined
    : new Promise((resolve) => {
      const timer = setTimeout(() => process.kill("SIGKILL"), 2_000);
      process.once("exit", () => { clearTimeout(timer); resolve(); });
    })));
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
