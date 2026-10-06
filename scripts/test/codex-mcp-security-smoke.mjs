// Official source-built Codex -> native MCP gateway -> real SDK stdio fixture.
// Inspect actual Responses request bodies, not only UI notifications.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CodexAgentBrain } from "../../dist/core/brains/codex-agent-brain.js";

assert.ok(process.env.SICLAW_CODEX_BIN, "Use the pinned official source-built Codex binary");
const root = mkdtempSync(join(tmpdir(), "siclaw-mcp-model-gate-"));
// Production exec runs as sandbox; only synthetic public evidence is readable.
chmodSync(root, 0o755);
const workspace = join(root, "workspace"); mkdirSync(workspace);
const secret = "mcp-private-fixture.20261006+secret";
const modelSecret = "model-private-fixture.20261006";
const credentialSecret = "broker-private-fixture.20261006";
const sensitive = [modelSecret];
const counter = join(root, "calls");
writeFileSync(join(workspace, "credential_echo.txt"), `healthy local evidence\nunlabelled ${credentialSecret}\n`);
let requests = 0, rootCalls = 0, childCalls = 0, resumeCalls = 0;
let childId, fixtureError;
let resuming = false;
const snapshots = [];
const namespace = "mcp__fixture";
const output = (body, id) => {
  const value = body.input.find(item => item.type === "function_call_output" && item.call_id === id)?.output ?? "";
  return typeof value === "string" ? value : Array.isArray(value)
    ? value.filter(block => typeof block.text === "string").map(block => block.text).join("\n") : JSON.stringify(value);
};
const call = (name, args, id, ns) => ({ id, type: "function_call", ...(ns ? { namespace: ns } : {}), name,
  call_id: id, arguments: JSON.stringify(args), status: "completed" });
const search = id => ({ id, type: "tool_search_call", call_id: id, execution: "client",
  arguments: { query: "read_fixture spawn_agent wait_agent", limit: 8 }, status: "completed" });
const answer = id => ({ id, type: "message", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "Security checks complete", annotations: [] }] });

const model = createServer(async (request, response) => {
  try {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    for (const value of [secret, modelSecret, credentialSecret, Buffer.from(secret).toString("base64")]) {
      assert.ok(!raw.includes(value), "A known credential reached the Responses model body");
    }
    snapshots.push(raw);
    assert.equal(request.headers.authorization, `Bearer ${modelSecret}`);
    const memory = body.input.filter(item => item.type === "message" && item.role === "user").at(-1)
      ?.content?.some(block => block.text?.startsWith("## Memory Writing Agent:"));
    const child = body.input.filter(item => item.type === "message" && item.role === "user").at(-1)
      ?.content?.some(block => block.text?.includes("CHILD_SECURITY"));
    requests++;
    let item;
    if (memory) item = answer(`memory-${requests}`);
    else if (child) {
      childCalls++;
      if (childCalls === 1) item = search("child-search");
      else if (childCalls === 2) item = call("read_fixture", {}, "child-read", namespace);
      else { assert.match(output(body, "child-read"), /healthy/); item = answer("child-answer"); }
    } else if (resuming) {
      resumeCalls++;
      if (resumeCalls === 1) item = call("read_fixture", {}, "resume-read", namespace);
      else { assert.match(output(body, "resume-read"), /healthy/); item = answer("resume-answer"); }
    } else {
      rootCalls++;
      if (rootCalls === 1) item = search("root-search");
      else if (rootCalls === 2) item = call("read_fixture", {}, "root-read", namespace);
      else if (rootCalls === 3) { assert.match(output(body, "root-read"), /healthy/); item = call("read_fixture", { mode: "error" }, "root-error", namespace); }
      else if (rootCalls === 4) { assert.match(output(body, "root-error"), /failed|suppressed/); item = call("write_fixture", {}, "root-write", namespace); }
      else if (rootCalls === 5) {
        assert.match(output(body, "root-write"), /not|unknown|unsupported|authorized/i);
        sensitive.push(credentialSecret); // Mimics a credential acquired after session construction.
        item = call("exec_command", { cmd: "cat credential_echo.txt", login: false }, "root-local");
      } else if (rootCalls === 6) {
        assert.match(output(body, "root-local"), /healthy local evidence/);
        assert.match(output(body, "root-local"), /REDACTED/);
        item = call("spawn_agent", { message: "CHILD_SECURITY", fork_context: false }, "root-spawn", "multi_agent_v1");
      } else if (rootCalls === 7) {
        childId = JSON.parse(output(body, "root-spawn")).agent_id;
        assert.ok(childId); item = call("wait_agent", { targets: [childId], timeout_ms: 10000 }, "root-wait", "multi_agent_v1");
      } else item = answer("root-answer");
    }
    const envelope = { id: `response-${requests}`, object: "response", model: body.model, output: [item], status: "completed",
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    send("response.created", { response: { ...envelope, output: [], status: "in_progress" } });
    send("response.output_item.added", { output_index: 0, item: { ...item, ...(item.type === "function_call" ? { arguments: "" } : item.type === "message" ? { content: [] } : {}), status: "in_progress" } });
    if (item.type === "function_call") send("response.function_call_arguments.delta", { output_index: 0, delta: item.arguments });
    else if (item.type === "message") send("response.output_text.delta", { output_index: 0, content_index: 0, delta: item.content[0].text });
    send("response.output_item.done", { output_index: 0, item });
    send("response.completed", { response: envelope }); response.end();
  } catch (error) {
    fixtureError ??= error;
    console.error(`MCP security fixture failed at request ${requests}, root ${rootCalls}, child ${childCalls}, resume ${resumeCalls}: ${error.message}`);
    response.writeHead(500).end(JSON.stringify({ error: { message: "Security fixture assertion failed" } }));
  }
});
await new Promise(resolveListen => model.listen(0, "127.0.0.1", resolveListen));
let brain;
const transcripts = join(root, "transcripts");
const makeBrain = async sessionManager => {
  const created = await CodexAgentBrain.create({ sessionManager, cwd: workspace, systemPrompt: "Use native tools. Reply briefly.",
    skillPaths: [], toolsetsByName: new Map(), allowSubagents: true,
    sensitiveValues: () => sensitive,
    grants: { readRoots: [workspace], writeRoots: [], deniedRoots: [transcripts], allowCommands: false,
      allowFileCommands: true, production: process.env.NODE_ENV === "production", environment: { PATH: process.env.PATH } },
    mcpServers: { fixture: { transport: "stdio", command: process.execPath, args: [resolve("scripts/test/fixtures/mcp-security-server.mjs")],
      env: { FIXTURE_SECRET: secret, COUNTER_FILE: counter, SICLAW_MCP_READ_ONLY_TOOLS: '["read_fixture"]' } } } });
  created.registerProvider("fixture", { apiKey: modelSecret, baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: "openai-responses",
    models: [{ id: "gpt-5.5", api: "openai-responses", contextWindow: 128000, maxTokens: 1000 }] });
  await created.setModel(created.findModel("fixture", "gpt-5.5"));
  if (process.env.SICLAW_MCP_SMOKE_TRACE === "1") created.mcpGateway.http?.prependListener("request", (req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      let body; try { body = JSON.parse(raw); } catch {}
      console.log(JSON.stringify({ transport: req.method, method: body?.method, params: Object.keys(body?.params ?? {}),
        hasAuth: Boolean(req.headers.authorization), hasSession: Boolean(req.headers["mcp-session-id"]) }));
    });
    res.once("finish", () => console.log(`MCP fixture HTTP status ${res.statusCode}`));
  });
  return created;
};
try {
  brain = await makeBrain(SessionManager.create(workspace, transcripts));
  await brain.prompt("Validate the native security boundary");
  if (fixtureError) throw fixtureError;
  assert.equal(rootCalls, 8); assert.equal(childCalls, 3);
  for (const value of [secret, modelSecret, credentialSecret]) assert.ok(!JSON.stringify(brain.getConversationMessages()).includes(value));
  await brain.close();
  resuming = true;
  brain = await makeBrain(SessionManager.continueRecent(workspace, transcripts));
  await brain.prompt("Revalidate after resume");
  if (fixtureError) throw fixtureError;
  assert.equal(resumeCalls, 2);
  const calls = readFileSync(counter, "utf8").trim().split("\n");
  assert.equal(calls.length, 4); assert.ok(calls.every(name => name === "read_fixture"));
  assert.ok(snapshots.every(raw => !raw.includes(secret) && !raw.includes(credentialSecret)));
  console.log(`Source-built Codex MCP security smoke passed: ${requests} Responses requests, native MCP discovery, read/error redaction, denied write, fresh credential echo, native child, resume; upstream write executions=0`);
} finally {
  await brain?.close(); model.closeAllConnections(); await new Promise(resolveClose => model.close(resolveClose));
  rmSync(root, { recursive: true, force: true });
}
