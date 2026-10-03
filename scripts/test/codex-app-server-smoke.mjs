// Run after `npm run build` with SICLAW_CODEX_BIN pointing at a Codex binary
// built from Dockerfile.agentbox's pinned GitLab Codex main commit.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAgentBrain } from "../../dist/core/brains/codex-agent-brain.js";
import { projectCodexPlan } from "../../dist/core/brains/codex-plan.js";
import { getOrCreateLedger } from "../../dist/core/task-ledger.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRestrictedBashTool } from "../../dist/tools/cmd-exec/restricted-bash.js";

if (!process.env.SICLAW_CODEX_BIN) {
  throw new Error("Set SICLAW_CODEX_BIN to the Codex binary built from the pinned source commit");
}

const sessionDir = mkdtempSync(join(tmpdir(), "siclaw-codex-source-smoke-"));
// Enable only inside the production AgentBox image, as its agentbox user.
const containerSecurity = process.env.SICLAW_CODEX_CONTAINER_SMOKE === "1";
const credentialFixture = `/app/.siclaw/credentials/clusters/codex-smoke-${process.pid}`;
const deniedWrite = join(sessionDir, "must-not-exist");
const commandResults = [];
let calls = 0;
let toolRuns = 0;
const plans = [];
const planEvents = [];
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  const body = JSON.parse(raw);
  assert.equal(request.url, "/v1/responses");
  assert.equal(body.model, "smoke-model");
  assert.equal(body.stream, true);
  const toolNames = body.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("update_plan"));
  assert.ok(toolNames.includes("mcp__siclaw") || toolNames.some((name) => name.endsWith("echo")));
  for (const forbidden of ["exec_command", "write_stdin", "apply_patch", "view_image",
    "code_mode_execute", "request_permissions"]) {
    assert.ok(!toolNames.includes(forbidden), `${forbidden} bypasses Siclaw's tool policy`);
  }
  calls++;
  const id = `response_${calls}`;
  const command = containerSecurity && calls >= 3 && calls <= 5
    ? [
      `touch ${deniedWrite}`,
      `grep secret ${credentialFixture}`,
      "kubectl version --client -o json | jq -r .clientVersion.gitVersion",
    ][calls - 3] : undefined;
  const toolCall = calls <= 2 || command !== undefined;
  const item = calls === 1
    ? { id: `function_${calls}`, type: "function_call", name: "update_plan",
      call_id: `call_${calls}`, arguments: '{"plan":[{"step":"Inspect","status":"in_progress"}]}', status: "completed" }
    : calls === 2
      ? { id: `function_${calls}`, type: "function_call", namespace: "mcp__siclaw",
        name: "echo", call_id: `call_${calls}`, arguments: '{"text":"ok"}', status: "completed" }
    : command !== undefined
      ? { id: `function_${calls}`, type: "function_call", namespace: "mcp__siclaw",
        name: "bash", call_id: `call_${calls}`, arguments: JSON.stringify({ command }), status: "completed" }
    : { id: `message_${calls}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "hello from codex", annotations: [] }] };
  const envelope = { id, object: "response", created_at: Math.floor(Date.now() / 1000),
    status: "completed", model: "smoke-model", output: [item],
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 }, parallel_tool_calls: false, tools: [] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  send("response.created", { response: { ...envelope, status: "in_progress", output: [] } });
  send("response.output_item.added", { output_index: 0,
    item: toolCall ? { ...item, arguments: "", status: "in_progress" }
      : { ...item, content: [], status: "in_progress" } });
  if (toolCall) {
    send("response.function_call_arguments.delta", { output_index: 0, delta: item.arguments });
  } else {
    send("response.content_part.added", { output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } });
    send("response.output_text.delta", { output_index: 0, content_index: 0, delta: "hello from codex" });
    send("response.output_text.done", { output_index: 0, content_index: 0, text: "hello from codex" });
    send("response.content_part.done", { output_index: 0, content_index: 0, part: item.content[0] });
  }
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", { response: envelope });
  response.end();
});

await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const port = model.address().port;
const extensionRunner = { createContext: () => ({}), emitContext: async (messages) => messages,
  emitToolCall: async () => undefined, emitToolResult: async () => undefined,
  emitInput: async () => ({ action: "continue" }), emit: async () => undefined };
const tool = { name: "echo", label: "Echo", description: "Echo input",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  execute: async (_id, args) => { toolRuns++; return { content: [{ type: "text", text: args.text }] }; } };
const bash = createRestrictedBashTool();
const tools = containerSecurity ? [tool, { ...bash, execute: async (...args) => {
  const result = await bash.execute(...args);
  commandResults.push(result);
  return result;
} }] : [tool];
const makeBrain = async (sessionManager) => {
  const brain = await CodexAgentBrain.create({ sessionManager, piSession: { extensionRunner },
    systemPrompt: "Reply briefly", tools, toolsetsByName: new Map([["echo", "test"], ["bash", "cmd-exec"]]),
    cwd: process.cwd(), skillPaths: [], nativePlanEnabled: true,
    onPlanUpdate: (plan) => {
      plans.push(plan);
      projectCodexPlan("smoke-plan", (event) => planEvents.push(event), plan);
    } });
  brain.registerProvider("fixture", { apiKey: "test", baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-responses", models: [{ id: "smoke-model", api: "openai-responses",
      contextWindow: 128_000, maxTokens: 1_000 }] });
  await brain.setModel(brain.findModel("fixture", "smoke-model"));
  return brain;
};

let brain;
try {
  if (containerSecurity) {
    assert.equal(process.env.NODE_ENV, "production");
    assert.equal(process.getuid(), 1000, "Run the container smoke as agentbox, not root");
    writeFileSync(credentialFixture, "fake-secret-for-isolation-test", { mode: 0o640 });
    assert.equal(spawnSync("sudo", ["-n", "-u", "sandbox", "--", "test", "-r", credentialFixture]).status,
      1, "sandbox must not be able to read AgentBox credentials");
  }
  brain = await makeBrain(SessionManager.create(process.cwd(), sessionDir));
  await brain.prompt("Hi");
  assert.equal(toolRuns, 1);
  if (containerSecurity) {
    assert.equal(commandResults.length, 3);
    assert.equal(commandResults[0].details.blocked, true, "non-whitelisted command must be blocked");
    assert.equal(commandResults[1].details.blocked, true, "credential path must be blocked");
    assert.equal(existsSync(deniedWrite), false, "blocked command must not execute");
    assert.match(commandResults[2].content[0].text, /v\d+\.\d+\.\d+/,
      "authorized kubectl pipeline must execute through the production sandbox");
    assert.ok(!commandResults[2].details?.blocked);
  }
  assert.deepEqual(plans[0], [{ step: "Inspect", status: "inProgress" }]);
  assert.deepEqual(getOrCreateLedger("smoke-plan").snapshot().map(({ subject, status }) =>
    ({ subject, status })), [{ subject: "Inspect", status: "in_progress" }]);
  assert.deepEqual(planEvents.map((event) => event.action), ["reset", "upsert"]);
  assert.ok(brain.getConversationMessages().some((message) => message.role === "assistant" &&
    message.content?.some?.((item) => item.text === "hello from codex")));
  await brain.close();

  brain = await makeBrain(SessionManager.continueRecent(process.cwd(), sessionDir));
  await brain.prompt("Again");
  assert.ok(brain.getConversationMessages().length >= 6);
  const beforeStop = calls;
  const stopping = brain.prompt("Stop before model call");
  await brain.abort();
  await stopping;
  assert.equal(calls, beforeStop);
  console.log(`Codex app-server smoke passed: ${calls} model calls, ${toolRuns} Siclaw tool run, resume and early stop`);
  if (containerSecurity) console.log("Container security passed: command whitelist, credential path denial, OS user isolation, authorized kubectl pipeline");
} finally {
  await brain?.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  rmSync(sessionDir, { recursive: true, force: true });
  if (containerSecurity) rmSync(credentialFixture, { force: true });
}
