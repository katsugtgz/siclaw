// Real Pi SDK and source-built Codex in the same process, with a bounded fake
// Responses provider. No infrastructure, real credentials or business data.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { AgentBoxSessionManager } from "../../dist/agentbox/session.js";

assert.ok(process.env.SICLAW_CODEX_BIN, "Source-built Codex binary required");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-coexistence-"));
fs.chmodSync(root, 0o755);
const previousCwd = process.cwd(); process.chdir(root);
process.env.SICLAW_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.SICLAW_CONFIG_DIR);
fs.writeFileSync(path.join(process.env.SICLAW_CONFIG_DIR, "settings.json"), JSON.stringify({ providers: {} }));
process.env.SICLAW_MEMORY_ENABLED = "false";
process.env.SICLAW_AGENT_ENGINE = "codex"; // Deliberately opposite to the Pi Agent.
const entered = new Set(); const calls = { "pi-agent": 0, codex: 0 };
let release, overlapped = false, failure;
const both = new Promise(resolve => { release = resolve; });
const timeout = setTimeout(() => { failure = new Error("Both engines did not overlap within 30s"); release(); }, 30_000);
const model = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const engine = raw.includes("PI_CONCURRENCY_PROBE") ? "pi-agent" : raw.includes("CODEX_CONCURRENCY_PROBE") ? "codex" : null;
    const memory = JSON.stringify(body.input ?? []).includes("## Memory Writing Agent:");
    assert.ok(engine || memory, "Unknown fixture request");
    if (!memory) {
      const tools = (body.tools ?? []).flatMap(tool => [tool.name, ...(tool.tools ?? []).map(item => item.name)]);
      assert.equal(tools.includes("exec_command"), engine === "codex", "Actual native and Pi tool catalogues must remain distinct");
      calls[engine]++; entered.add(engine);
      if (entered.size === 2) { overlapped = true; clearTimeout(timeout); release(); }
      await both; if (failure) throw failure;
    }
    const text = memory ? "Memory complete" : engine === "pi-agent" ? "PI_ENGINE_ACCEPTED" : "CODEX_ENGINE_ACCEPTED";
    const id = "msg-" + (engine ?? "memory"), part = { type: "output_text", text, annotations: [] };
    const item = { id, type: "message", role: "assistant", status: "completed", content: [part] };
    const response = { id: "resp-" + id, object: "response", created_at: Math.floor(Date.now()/1000), model: body.model,
      status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    emit("response.created", { response: { ...response, status: "in_progress", output: [] } });
    emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    emit("response.content_part.added", { item_id: id, output_index: 0, content_index: 0, part: { ...part, text: "" } });
    emit("response.output_text.delta", { item_id: id, output_index: 0, content_index: 0, delta: text });
    emit("response.output_text.done", { item_id: id, output_index: 0, content_index: 0, text });
    emit("response.content_part.done", { item_id: id, output_index: 0, content_index: 0, part });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", { response }); res.end();
  } catch (error) { failure ??= error; res.writeHead(500).end("Fixture assertion failed"); }
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
const managers = [];
const replies = { "pi-agent": [], codex: [] };
try {
  const sessions = [];
  for (const engine of ["pi-agent", "codex"]) {
    const manager = new AgentBoxSessionManager(); managers.push(manager);
    manager.agentId = "fixture-" + engine; manager.agentTypeState = "custom";
    manager.agentEngineState = engine; manager.allowedToolsState = ["read"];
    manager.mcpServersState = {}; manager.skillsDir = path.join(root, "skills", engine);
    manager.knowledgeDir = path.join(root, "knowledge", engine);
    fs.mkdirSync(path.join(manager.skillsDir, "resolved"), { recursive: true });
    const session = await manager.getOrCreate("session-" + engine, "web");
    assert.equal(session.brain.brainType, engine);
    session.brain.subscribe(event => {
      if (event.type === "message_end" && event.message?.role === "assistant") {
        replies[engine].push(JSON.stringify(event.message.content));
      }
    });
    session.brain.registerProvider("coexistence", { apiKey: "synthetic-provider-key", api: "openai-responses",
      baseUrl: `http://127.0.0.1:${model.address().port}/v1`, models: [{ id: "gpt-5.5", name: "Concurrency fixture", api: "openai-responses",
        input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }] });
    const selected = session.brain.findModel("coexistence", "gpt-5.5"); assert.ok(selected);
    await session.brain.setModel(selected); sessions.push(session);
  }
  try { await Promise.all([
    sessions[0].brain.prompt("PI_CONCURRENCY_PROBE. Reply briefly without tools."),
    sessions[1].brain.prompt("CODEX_CONCURRENCY_PROBE. Reply briefly without tools."),
  ]); } catch (error) { throw failure ?? error; }
  if (failure) throw failure;
  assert.equal(overlapped, true);
  assert.ok(calls["pi-agent"] >= 1 && calls.codex >= 1);
  assert.match(replies["pi-agent"].join("\n"), /PI_ENGINE_ACCEPTED/);
  assert.match(replies.codex.join("\n"), /CODEX_ENGINE_ACCEPTED/);
  assert.equal(process.env.SICLAW_AGENT_ENGINE, "codex");
  console.log(JSON.stringify({ gate: "agent-engine-coexistence", passed: true, sameProcess: true,
    actualBrains: sessions.map(s => s.brain.brainType), overlappingModelRequests: true, calls,
    provider: "synthetic Responses", productionRequests: 0 }));
} finally {
  clearTimeout(timeout); release();
  await Promise.allSettled(managers.map(manager => manager.closeAll()));
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  process.chdir(previousCwd); fs.rmSync(root, { recursive: true, force: true });
}
