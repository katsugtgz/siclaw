// Run after `npm run build` with SICLAW_CODEX_BIN pointing at a Codex binary
// built from Dockerfile.agentbox's pinned GitLab Codex main commit.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSiclawSession } from "../../dist/core/agent-factory.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

if (!process.env.SICLAW_CODEX_BIN) {
  throw new Error("Set SICLAW_CODEX_BIN to the Codex binary built from the pinned source commit");
}

const sessionDir = mkdtempSync(join(tmpdir(), "siclaw-codex-source-smoke-"));
// Enable only inside the production AgentBox image, as its agentbox user.
const containerSecurity = process.env.SICLAW_CODEX_CONTAINER_SMOKE === "1";
const credentialFixture = `/app/.siclaw/credentials/clusters/codex-smoke-${process.pid}`;
const childDeniedFile = join(sessionDir, "child-must-not-exist");
const workspace = join(sessionDir, "workspace");
const transcriptDir = join(sessionDir, "transcripts");
const outputFile = join(workspace, ".siclaw", "user-data", "native.txt");
const patch = "*** Begin Patch\n*** Add File: native.txt\n+native read marker\n+password: native-test-secret\n*** End Patch\n";
const originalCwd = process.cwd();
mkdirSync(workspace);
if (containerSecurity) chmodSync(sessionDir, 0o755);
process.chdir(workspace);
process.env.SICLAW_CONFIG_DIR = join(sessionDir, "config");
process.env.SICLAW_MEMORY_ENABLED = "false";
mkdirSync(process.env.SICLAW_CONFIG_DIR);
writeFileSync(join(process.env.SICLAW_CONFIG_DIR, "settings.json"), JSON.stringify({ providers: {} }));
let resources;
const realCluster = process.env.SICLAW_CODEX_REAL_CLUSTER_CONFIG;
const realCredential = join(workspace,".siclaw","credentials","clusters","native-real-kubeconfig");
if (realCluster) {
  assert.ok(!containerSecurity, "the real-cluster probe uses the local authorized kubectl context");
  mkdirSync(join(workspace,".siclaw","credentials","clusters"),{recursive:true,mode:0o700});
  writeFileSync(realCredential,readFileSync(realCluster),{mode:0o600});
}
let brokerRefreshes=0;
const clusterCommand = realCluster ? {cmd:"kubectl -n sicore-test get pods -o json",login:false,environment_id:"cluster:roce-test"}
  : {cmd:"kubectl version --client",login:false};
const assertCommandOutput = (output) => assert.match(output,realCluster ? /sicore-apiserver/ : /Client Version/);
let calls = 0;
let rootCalls = 0;
let childCalls = 0;
let childId;
let completedRootResponses = 0;
const usageObservations = [];
const childOperations = [];
const planEvents = [];
let holdNextResponse = false;
let streamingRequestSeen;
const withTimeout = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
};
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  const body = JSON.parse(raw);
  assert.equal(request.url, "/v1/responses");
  assert.equal(request.headers["x-native-smoke"], "fixture");
  assert.equal(request.headers.authorization, "Bearer test");
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.stream, true);
  const memoryTurn = body.input.filter(x=>x.type==="message"&&x.role==="user").at(-1)
    ?.content?.some(x=>x.text?.startsWith("## Memory Writing Agent:"));
  const advertised = [...body.tools, ...body.input.filter((entry) => entry.type === "tool_search_output").flatMap((entry) => entry.tools)];
  const toolNames = advertised.flatMap((tool) => [tool.name, ...(tool.tools ?? []).map((entry) => entry.name)]);
  assert.ok(toolNames.includes("update_plan"));
  if (!memoryTurn) assert.ok(toolNames.includes("exec_command"), `native catalog (${calls} requests, ${rootCalls} root, ${childCalls} child): ${JSON.stringify(toolNames)}`);

  assert.ok(!toolNames.includes("spawn_subagent"));
  assert.ok(!toolNames.includes("transfer_to_agent"));
  calls++;
  const childTurn = body.input.filter((entry) => entry.type === "message" && entry.role === "user")
    .at(-1)?.content?.some((entry) => entry.text?.includes("CHILD_ONLY_NATIVE"));
  if (!memoryTurn) { if (childTurn) childCalls++; else rootCalls++; }
  if (rootCalls === 1 && !childTurn && !memoryTurn) assert.ok(JSON.stringify(body.input).includes("legacy-kubectl-evidence"),
    "restoring a Pi transcript into Codex must preserve its historical tool evidence");
  const id = `response_${calls}`;
  let item;
  if (memoryTurn) item = {id:`memory_${calls}`,type:"message",role:"assistant",status:"completed",
    content:[{type:"output_text",text:"Native memory consolidation complete",annotations:[]}]};
  else if (childTurn && childCalls === 1) item = { id: `child_cmd_${calls}`, type: "function_call", name: "exec_command",
    call_id: "child-command", arguments: JSON.stringify(clusterCommand), status: "completed" };
  else if (childTurn && childCalls === 2) {
    const output = body.input.find((entry) => entry.type === "function_call_output" && entry.call_id === "child-command");
    assertCommandOutput(output.output);
    item = { id: `child_deny_${calls}`, type: "function_call", name: "exec_command", call_id: "child-denied",
      arguments: JSON.stringify({cmd:`touch ${childDeniedFile}`,login:false}), status: "completed" };
  } else if (childTurn) {
    const output = body.input.find((entry) => entry.type === "function_call_output" && entry.call_id === "child-denied");
    assert.match(output.output, /not.*(allowed|authorized)|blocked|denied/i, "native child must not bypass the policy relay");
    assert.ok(!existsSync(childDeniedFile));
    item = { id: `child_${calls}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "native child completed", annotations: [] }] };
  } else if (rootCalls === 1) item = { id: `function_${calls}`, type: "function_call", name: "update_plan",
    call_id: "plan", arguments: '{"plan":[{"step":"Inspect","status":"in_progress"}]}', status: "completed" };
  else if (rootCalls === 2) item = { id: `function_${calls}`, type: "function_call", name: "exec_command",
    call_id: "command", arguments: JSON.stringify(clusterCommand), status: "completed" };
  else if (rootCalls === 3) {
    const output = body.input.find((entry) => entry.type === "function_call_output" && entry.call_id === "command");
    assertCommandOutput(output.output);
    item = { id: `search_${calls}`, type: "tool_search_call", call_id: "discover",
      execution: "client", arguments: { query: "spawn_agent wait_agent", limit: 5 }, status: "completed" };
  }
  else if (rootCalls === 4) {
    assert.ok(toolNames.includes("spawn_agent"), "native tool_search must load the native child tool");
    item = { id: `function_${calls}`, type: "function_call", namespace: "multi_agent_v1", name: "spawn_agent",
      call_id: "spawn", arguments: '{"message":"CHILD_ONLY_NATIVE","fork_context":false}', status: "completed" };
  } else if (rootCalls === 5) {
    const output = body.input.find((entry) => entry.type === "function_call_output" && entry.call_id === "spawn");
    const spawned = JSON.parse(output.output);
    childId = spawned.agent_id;
    assert.ok(childId, "native spawn must return a child id");
    item = { id: `function_${calls}`, type: "function_call", namespace: "multi_agent_v1", name: "wait_agent",
      call_id: "wait", arguments: JSON.stringify({ targets: [childId], timeout_ms: 10000 }), status: "completed" };
  } else if (rootCalls === 6) {
    item = { id: `patch_${calls}`, type: "custom_tool_call", name: "apply_patch", call_id: "patch",
      input: patch, status: "completed" };
  } else if (rootCalls === 7) {
    assert.equal(readFileSync(outputFile, "utf8"), "native read marker\npassword: native-test-secret\n");
    item = { id: `read_${calls}`, type: "function_call", name: "exec_command", call_id: "read",
      arguments: '{"cmd":"cat native.txt","login":false}', status: "completed" };
  } else if (rootCalls === 8) {
    const output = body.input.find((entry) => entry.type === "function_call_output" && entry.call_id === "read");
    assert.match(output.output, /native read marker/);
    assert.ok(!output.output.includes("native-test-secret"), "native file output must be sanitized before reaching the model");
    item = { id: `deny_${calls}`, type: "function_call", name: "exec_command", call_id: "denied-command",
      arguments: '{"cmd":"touch must-not-exist","login":false}', status: "completed" };
  } else if (rootCalls === 9) {
    const output = body.input.find((entry) => entry.type === "function_call_output" && entry.call_id === "denied-command");
    assert.match(output.output, /not.*(allowed|authorized)|blocked|denied/i);
    assert.ok(!existsSync(join(workspace, ".siclaw", "user-data", "must-not-exist")));
    item = { id: `deny_path_${calls}`, type: "function_call", name: "exec_command", call_id: "denied-path",
      arguments: JSON.stringify({cmd: `cat ${join(sessionDir, "config", "settings.json")}`, login: false}), status: "completed" };
  } else if (rootCalls === 11) {
    item = { id: `resume_deny_${calls}`, type: "function_call", name: "exec_command", call_id: "resume-denied",
      arguments: '{"cmd":"cat /etc/hosts","login":false}', status: "completed" };
  } else if (rootCalls === 12) {
    const output = body.input.find((entry) => entry.type === "function_call_output" && entry.call_id === "resume-denied");
    assert.ok(/grant|denied|not authorized/i.test(output.output),
      "resumed default execution must still enforce the native file grant");
    item = { id: `resume_read_${calls}`, type: "function_call", name: "exec_command", call_id: "resume-read",
      arguments: '{"cmd":"cat native.txt","login":false}', status: "completed" };
  } else if (rootCalls === 13) {
    const output = body.input.find((entry) => entry.type === "function_call_output" && entry.call_id === "resume-read");
    assert.ok(output.output.includes("native read marker") && !output.output.includes("native-test-secret"),
      "resumed default execution must sanitize native file output");
    item = { id: `resume_local_${calls}`, type: "function_call", name: "exec_command", call_id: "resume-local",
      arguments: '{"cmd":"cat native.txt","login":false,"environment_id":"local"}', status: "completed" };
  } else {
    if (rootCalls === 10) {
      const output = body.input.find((entry) => entry.type === "function_call_output" && entry.call_id === "denied-path");
      assert.match(output.output, /grant|denied|not authorized/i);
    }
    if (rootCalls === 14) {
      const output = body.input.find((entry) => entry.type === "function_call_output" && entry.call_id === "resume-local");
      assert.ok(!output.output.includes("native-test-secret") &&
        /environment|grant|denied|not authorized/i.test(output.output),
        "an explicit local environment must not bypass the native policy relay");
    }
    item = { id: `message_${calls}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "hello from codex", annotations: [] }] };
  }
  const toolCall = item.type === "function_call";
  const envelope = { id, object: "response", created_at: Math.floor(Date.now() / 1000),
    status: "completed", model: "gpt-5.5", output: [item],
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 }, parallel_tool_calls: false, tools: [] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  send("response.created", { response: { ...envelope, status: "in_progress", output: [] } });
  if (holdNextResponse && !memoryTurn) {
    holdNextResponse = false;
    streamingRequestSeen?.();
    return; // Keep the real model request open until Codex interrupts it.
  }
  if (!memoryTurn && !childTurn) completedRootResponses++;
  send("response.output_item.added", { output_index: 0,
    item: toolCall ? { ...item, arguments: "", status: "in_progress" }
      : { ...item, ...(item.type === "message" ? { content: [] } : {}),
        ...(item.type === "custom_tool_call" ? { input: "" } : {}), status: "in_progress" } });
  if (toolCall) {
    send("response.function_call_arguments.delta", { output_index: 0, delta: item.arguments });
  } else if (item.type === "custom_tool_call") {
    send("response.custom_tool_call_input.delta", { output_index: 0, delta: item.input });
  } else if (item.type === "message") {
    send("response.content_part.added", { output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } });
    send("response.output_text.delta", { output_index: 0, content_index: 0, delta: item.content[0].text });
    send("response.output_text.done", { output_index: 0, content_index: 0, text: item.content[0].text });
    send("response.content_part.done", { output_index: 0, content_index: 0, part: item.content[0] });
  }
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", { response: envelope });
  response.end();
});

await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const port = model.address().port;
const makeBrain = async (sessionManager) => {
  resources = await createSiclawSession({ sessionManager, agentEngine: "codex", agentType: "custom",
    ...(realCluster ? {kubeconfigRef:{credentialBroker:{refreshClusters:async () => [{name:"roce-test"}],
      acquireCluster:async (name) => {assert.equal(name,"roce-test");},
      ensureCluster:async (name) => {assert.equal(name,"roce-test");brokerRefreshes++;return {path:realCredential};}}}} : {}),
    harnessResolved: true, allowedTools: ["bash", "read", "write", "edit", "task_create", "task_update", "spawn_subagent"],
    sessionEventEmitter: (event) => planEvents.push(event), userId: "native-smoke", agentId: "native-smoke" });
  assert.equal(resources.session, undefined, "Codex must not instantiate a Pi AgentSession");
  assert.deepEqual(resources.customTools, [], "Codex must not receive Pi ToolDefinitions");
  const brain = resources.brain;
  brain.setNativeChildSink({ persist: async operation => childOperations.push(operation), activity: () => {} });
  brain.llmCalls.setUsageSink({context:()=>({sessionId:"native-source-smoke",executionRole:"root"}),
    record:observation=>usageObservations.push(observation)});
  brain.registerProvider("fixture", { apiKey: "test", headers: {"X-Native-Smoke": "fixture"}, baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-responses", models: [{ id: "gpt-5.5", api: "openai-responses",
      contextWindow: 128_000, maxTokens: 1_000 }] });
  await brain.setModel(brain.findModel("fixture", "gpt-5.5"));
  return brain;
};

let brain;
try {
  if (containerSecurity) {
    assert.equal(process.env.NODE_ENV, "production");
    assert.equal(process.getuid(), 1000, "Run the container smoke as agentbox, not root");
    // A fresh K8s credential emptyDir hides the image's pre-created directories.
    const clusterDir = "/app/.siclaw/credentials/clusters";
    mkdirSync(clusterDir, {recursive:true});
    chownSync(clusterDir, 1000, 1002);
    chmodSync(clusterDir, 0o2750);
    writeFileSync(credentialFixture, "fake-secret-for-isolation-test", { mode: 0o640 });
    assert.equal(spawnSync("sudo", ["-n", "-u", "sandbox", "--", "test", "-r", credentialFixture]).status,
      1, "sandbox must not be able to read AgentBox credentials");
  }
  const legacy = SessionManager.create(process.cwd(), transcriptDir);
  legacy.appendMessage({role:"user",content:"Inspect the old node",timestamp:Date.now()});
  legacy.appendMessage({role:"assistant",content:[{type:"toolCall",id:"legacy",name:"node_exec",arguments:{node:"prior-node"}}],
    stopReason:"toolUse",api:"openai-responses",provider:"fixture",model:"gpt-5.5",timestamp:Date.now(),
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  legacy.appendMessage({role:"toolResult",toolCallId:"legacy",toolName:"node_exec",
    content:[{type:"text",text:"legacy-kubectl-evidence"}],isError:false,timestamp:Date.now()});
  brain = await makeBrain(legacy);
  await brain.prompt("Hi");
  assert.equal(childCalls, 3);
  assert.equal(childOperations.filter(op => op.type === "ensure").length, 1);
  const childUsage = childOperations.filter(op => op.type === "usage");
  assert.equal(childUsage.length, childCalls, "each real native child model call must be projected exactly once");
  assert.ok(childUsage.every(op => op.observation.executionRole === "internal_subagent"));
  assert.ok(childOperations.some(op => op.type === "message" && op.content === "native child completed"));
  assert.ok(childOperations.some(op => op.type === "message" && op.toolName === "exec_command" && op.outcome === "error"));
  assert.ok(childOperations.some(op => op.type === "status" && op.status === "done"));
  assert.ok(!JSON.stringify(brain.getConversationMessages()).includes(childId), "native thread IDs stay private");
  assert.ok(childId);
  if (realCluster) assert.equal(brokerRefreshes,2,"parent and native child must refresh the selected cluster credential");
  const planUpdates = planEvents.filter((event) => event.kind === "task_event");
  assert.deepEqual(planUpdates.map((event) => event.action), ["reset", "upsert"]);
  assert.ok(brain.getConversationMessages().some((message) => message.role === "assistant" &&
    message.content?.some?.((item) => item.text === "hello from codex")));
  await brain.close();
  resources.knowledgeIndexer?.close();

  brain = await makeBrain(SessionManager.continueRecent(process.cwd(), transcriptDir));
  await brain.prompt("Again");
  assert.ok(brain.getConversationMessages().length >= 6);
  const beforeStop = rootCalls;
  const stopping = brain.prompt("Stop before model call");
  await brain.abort();
  await stopping;
  assert.equal(rootCalls, beforeStop);
  holdNextResponse = true;
  const streamingRequest = new Promise((resolve) => { streamingRequestSeen = resolve; });
  const streaming = brain.prompt("Stop during a model stream");
  streaming.catch(() => {}); // Cleanup may reject this promise after an assertion failure.
  await withTimeout(streamingRequest, "streaming model request");
  await withTimeout(brain.abort(), "active Stop");
  await withTimeout(streaming, "interrupted turn completion");
  const afterInterrupt = rootCalls;
  await brain.prompt("Continue after Stop");
  assert.equal(rootCalls, afterInterrupt + 1);
  assert.equal(usageObservations.length, completedRootResponses,
    "native resume snapshots must not add model usage observations");
  assert.equal(usageObservations.reduce((sum, entry) => sum + entry.usageEvidence.rawUsage.input_tokens +
    entry.usageEvidence.rawUsage.output_tokens, 0), completedRootResponses * 16,
    "recorded usage must match actual completed parent model responses");
  console.log(`Native Codex brain smoke passed: ${calls} model calls, 1 native child (${childCalls} calls), plan, command, patch, read/redaction, denied command/path, resume, early/active Stop, continuation${realCluster ? ", real roce-test environment, parent/child broker refresh" : ""}`);

} finally {
  await brain?.close();
  resources?.knowledgeIndexer?.close();
  process.chdir(originalCwd);
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  rmSync(sessionDir, { recursive: true, force: true });
  if (containerSecurity) rmSync(credentialFixture, { force: true });
}
