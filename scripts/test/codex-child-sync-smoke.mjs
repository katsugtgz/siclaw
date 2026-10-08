// Pinned native app-server, actual native child creation and a deterministic
// Responses fixture. No production provider, cluster or Feishu connection.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CodexAgentBrain } from "../../dist/core/brains/codex-agent-brain.js";
assert.ok(process.env.SICLAW_CODEX_BIN, "Use the pinned source-built binary");
const root = mkdtempSync(join(tmpdir(), "native-child-sync-")), cwd = join(root, "workspace"); mkdirSync(cwd);
let rootCalls = 0, sequence = 0, releaseChild;
let earlyResolve; const early = new Promise(resolve => { earlyResolve = resolve; });
const operations = [], events = [];
const hasText = (event, marker) => event.message?.role === "assistant" && Array.isArray(event.message.content) &&
  event.message.content.some(block => typeof block.text === "string" && block.text.includes(marker));
function send(response, item) {
  const envelope = { id: `resp_${++sequence}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed",
    model: "gpt-5.5", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 }, tools: [] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("response.created", { response: { ...envelope, status: "in_progress", output: [] } });
  event("response.output_item.added", { output_index: 0, item: item.type === "function_call"
    ? { ...item, arguments: "", status: "in_progress" }
    : { ...item, ...(item.type === "message" ? { content: [] } : {}), status: "in_progress" } });
  if (item.type === "message") {
    event("response.content_part.added", { output_index: 0, content_index: 0, part: { ...item.content[0], text: "" } });
    event("response.output_text.delta", { output_index: 0, content_index: 0, delta: item.content[0].text });
    event("response.output_text.done", { output_index: 0, content_index: 0, text: item.content[0].text });
    event("response.content_part.done", { output_index: 0, content_index: 0, part: item.content[0] });
  } else if (item.type === "function_call") event("response.function_call_arguments.delta", { output_index: 0, delta: item.arguments });
  event("response.output_item.done", { output_index: 0, item }); event("response.completed", { response: envelope }); response.end();
}
const answer = text => ({ id: `message_${sequence}`, type: "message", role: "assistant", phase: "final_answer", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }] });
const server = createServer(async (request, response) => {
  let raw = ""; for await (const part of request) raw += part;
  const body = JSON.parse(raw);
  const user = body.input.filter(item => item.type === "message" && item.role === "user").at(-1);
  if (user?.content?.some(block => block.text?.includes("CHILD_SYNC_ONLY"))) {
    releaseChild = () => send(response, answer("NATIVE_CHILD_REPORT_READY")); return;
  }
  if (user?.content?.some(block => block.text?.startsWith("## Memory Writing Agent:"))) { send(response, answer("Memory complete")); return; }
  rootCalls++;
  if (rootCalls === 1) send(response, { id: "search", type: "tool_search_call", call_id: "search", execution: "client",
    arguments: { query: "spawn_agent wait_agent", limit: 5 }, status: "completed" });
  else if (rootCalls === 2) send(response, { id: "spawn", type: "function_call", namespace: "multi_agent_v1", name: "spawn_agent", call_id: "spawn",
    arguments: JSON.stringify({ message: "CHILD_SYNC_ONLY: return the bounded diagnostic report", fork_context: false }), status: "completed" });
  else if (rootCalls === 3) send(response, answer("EARLY_PARENT_PROGRESS"));
  else {
    assert.ok(JSON.stringify(body.input).includes("Continue the SAME request"), "host wakes the same native parent instead of relaunching work");
    // Native completion delivery is queue-only and may race this continuation.
    // Verify the real child transcript separately below rather than fabricate it.
    send(response, answer("FINAL_PARENT_REPORT"));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let brain;
const bounded = async (promise, label) => {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + " timed out")), 20000); })]); }
  finally { clearTimeout(timer); }
};
try {
  brain = await CodexAgentBrain.create({ sessionManager: SessionManager.create(cwd, join(root, "sessions")),
    systemPrompt: "Use native children for diagnostics. Do not grant new permissions.", cwd, skillPaths: [], toolsetsByName: new Map(),
    grants: { readRoots: [], executionRoots: [cwd], writeRoots: [], deniedRoots: [], allowCommands: false, production: false },
    allowSubagents: true, defaultRequestMode: "sync", codexHome: join(root, "home") });
  brain.setNativeChildSink({ persist: async operation => operations.push(operation), activity: () => {} });
  brain.subscribe(event => { events.push(event); if (event.type === "message_end" && hasText(event, "EARLY_PARENT_PROGRESS")) earlyResolve(); });
  brain.registerProvider("fixture", { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic", api: "openai-responses",
    models: [{ id: "gpt-5.5", api: "openai-responses", contextWindow: 128000, maxTokens: 1000 }] });
  await brain.setModel(brain.findModel("fixture", "gpt-5.5"));
  let finished = false; const prompt = brain.prompt("Complete this diagnostic request with a native child").then(() => { finished = true; });
  void prompt.catch(() => {});
  await bounded(early, "early native parent answer");
  assert.equal(finished, false, "sync request must remain open after the early parent answer");
  const earlyEvent = events.find(event => event.type === "message_end" && hasText(event, "EARLY_PARENT_PROGRESS"));
  assert.equal(earlyEvent.awaitingSubagents, true);
  const until = Date.now() + 10000; while (!releaseChild) { assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 20)); }
  releaseChild(); await bounded(prompt, "same-request parent synthesis");
  assert.equal(rootCalls, 4, "one native continuation, not another child dispatch");
  assert.equal(operations.filter(operation => operation.type === "ensure").length, 1);
  assert.ok(operations.some(operation => operation.type === "message" && operation.role === "assistant" && operation.content.includes("NATIVE_CHILD_REPORT_READY")));
  assert.ok(events.some(event => event.type === "message_end" && hasText(event, "FINAL_PARENT_REPORT")));
  console.log("Native child sync smoke passed: actual pinned app-server/spawn, early parent fenced, owned child completion, one same-thread synthesis; model output is a deterministic fixture");
} catch (error) {
  console.error(JSON.stringify({ fixtureFailure: error.message, rootCalls, childRequested: !!releaseChild,
    eventTypes: events.map(event => event.type), childStatuses: operations.filter(operation => operation.type === "status").map(operation => operation.status) }));
  throw error;
} finally { await brain?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
