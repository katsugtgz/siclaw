// Source-built native catalog/Code Mode test. Run inside the AgentBox image,
// which includes the matching codex-code-mode-host and upstream V8 sandbox.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CodexAgentBrain } from "../../dist/core/brains/codex-agent-brain.js";
import { mcpDigest } from "../../dist/core/mcp-operation-policy.js";

const root = mkdtempSync(join(tmpdir(), "siclaw-code-mode-"));
chmodSync(root, 0o755);
let calls = 0;
let rootCalls = 0, childCalls = 0;
const nativeChildren = process.env.SICLAW_CODEX_CODE_MODE_CHILDREN === "1";
const nativeMcp = process.env.SICLAW_CODEX_CODE_MODE_MCP === "1";
const mcpSecret = "native-js-mcp-private-fixture-20261007";
const counter = join(root, "mcp-calls");
let fixtureError;
const code = nativeMcp ? `
if (['process','require','fetch','WebSocket','Deno','Bun'].some(name=>typeof globalThis[name] !== 'undefined')) throw new Error('JS host IO exposed');
if (typeof tools.mcp__fixture__write_fixture !== 'undefined') throw new Error('Write tool exposed');
const result = await tools.mcp__fixture__read_fixture({namespace:'sicore-test'});
if (!JSON.stringify(result).includes('healthy')) throw new Error('MCP read failed');
for (const args of [{namespace:'prod'}, {namespace:'sicore-test',tenant:'other-tenant'}]) {
  let blocked = false;
  try { const denied = await tools.mcp__fixture__read_fixture(args); blocked = JSON.stringify(denied).includes('MCP operation failed') || denied.isError === true; }
  catch { blocked = true; }
  if (!blocked) throw new Error('MCP argument scope bypassed');
}
text('NATIVE_JS_MCP_ACCEPTED');
` : 'text(JSON.stringify(await tools.exec_command({cmd:"kubectl version --client",login:false})));';
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const part of request) raw += part;
    if (nativeMcp) assert.ok(!raw.includes(mcpSecret), "MCP credential must not reach model requests");
    const body = JSON.parse(raw);
    assert.equal(body.model, "gpt-6.1-sol");
    assert.equal(request.url, "/v1/responses");
    const tools = body.input.find((item) => item.type === "additional_tools")?.tools;
    assert.ok(tools?.flatMap((tool) => [tool,...(tool.tools ?? [])]).some((tool) => tool.name === "exec"), "preserve the catalog's native Code Mode tools: " +
      JSON.stringify((tools ?? body.tools ?? []).map((tool) => ({name:tool.name,type:tool.type}))));
    assert.equal(body.tools, undefined, "preserve native Responses Lite presentation");
    calls++;
    const memoryTurn=body.input.filter(x=>x.type==="message"&&x.role==="user").at(-1)
      ?.content?.some(x=>x.text?.startsWith("## Memory Writing Agent:"));
    // V2 model-originated messages are opaque encrypted_content, not text.
    const child = body.input.filter((item) => ["message","agent_message"].includes(item.type))
      .some((message) => JSON.stringify(message).includes("CODE_MODE_NATIVE_CHILD"));
    const turn = memoryTurn ? 0 : child ? ++childCalls : ++rootCalls;
    const side = child ? "child" : "root";
    if (turn === 2) {
      const output = body.input.find((item) => item.type === "custom_tool_call_output" && item.call_id === `${side}-1`);
      assert.match(JSON.stringify(output), nativeMcp ? /NATIVE_JS_MCP_ACCEPTED/ : /Client Version/);
      assert.ok(!JSON.stringify(output).includes("host unavailable"));
    }
    let source = turn === 1 ? code : undefined;
    let nativeCall;
    if (nativeChildren && child && turn === 2) nativeCall = {name:"send_message",arguments:JSON.stringify({
      target:"/root",message:"CODE_MODE_V2_CHILD_RESULT"})};
    if (nativeChildren && !child) {
      // Upstream's V2 default is non_code_mode_only: child controls are direct
      // Responses tools alongside Code Mode, rather than tools.* JS functions.
      if (turn === 2) nativeCall = { name:"spawn_agent",arguments:JSON.stringify({
        message:"CODE_MODE_NATIVE_CHILD",task_name:"native_child",fork_turns:"none"}) };
      else if (turn >= 3 && !JSON.stringify(body.input).includes("CODE_MODE_V2_CHILD_RESULT")) {
        if (turn === 3) assert.match(JSON.stringify(body.input.filter((item) => item.type === "function_call_output")), /task_name/,
          "native spawn failed: " + JSON.stringify(body.input.filter((item) => item.type === "function_call_output")).slice(0,3000));
        assert.ok(turn < 8, "native wait must deliver the child result: " + JSON.stringify({childCalls,
          outputs:body.input.filter((item) => item.type === "function_call_output").slice(-3)}).slice(0,5000));
        nativeCall = {name:"wait_agent",arguments:'{"timeout_ms":10000}'};
      }
    }
    const answer = memoryTurn ? "Native memory consolidation complete" : child ? "Code Mode child complete" : "Code Mode complete";
    const item = nativeCall ? {id:`${side}-${turn}`,type:"function_call",namespace:"collaboration",call_id:`${side}-${turn}`,...nativeCall}
      : source ? { id:`${side}-${turn}`, type:"custom_tool_call",namespace:"functions",name:"exec",call_id:`${side}-${turn}`,input:source }
      : { id:`answer-${calls}`, type:"message",role:"assistant",content:[{type:"output_text",text:answer,annotations:[]}] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({type,...payload})}\n\n`);
    const envelope = { id:`resp-${calls}`, object:"response", model:body.model, output:[item], status:"completed",
      usage:{input_tokens:20,output_tokens:5,total_tokens:25} };
    send("response.created", {response:{...envelope,status:"in_progress",output:[]}});
    send("response.output_item.added", {output_index:0,item:{...item,...(nativeCall?{arguments:""}:source?{input:""}:{content:[]}),status:"in_progress"}});
    if (nativeCall) send("response.function_call_arguments.delta", {output_index:0,delta:nativeCall.arguments});
    else if (source) send("response.custom_tool_call_input.delta", {output_index:0,delta:source});
    else send("response.output_text.delta", {output_index:0,content_index:0,delta:answer});
    send("response.output_item.done", {output_index:0,item:{...item,status:"completed"}});
    send("response.completed", {response:envelope});
    response.end();
  } catch (error) {
    fixtureError ??= error;
    response.writeHead(500).end(JSON.stringify({error:{message:error.message}}));
  }
});
await new Promise((resolve) => model.listen(0,"127.0.0.1",resolve));
let brain;
try {
  brain = await CodexAgentBrain.create({sessionManager:SessionManager.create(root,join(root,"transcripts")),
    systemPrompt:"Reply briefly",grants:{readRoots:[root],writeRoots:[],deniedRoots:[join(root,"transcripts")],
      allowCommands:true,production:process.env.NODE_ENV==="production",environment:{PATH:process.env.PATH}},
    cwd:root,skillPaths:[],toolsetsByName:new Map(),allowSubagents:nativeChildren,
    ...(nativeMcp ? {
      mcpServers: { fixture: { transport:'stdio',command:process.execPath,args:[resolve('scripts/test/fixtures/mcp-security-server.mjs')],
        env:{FIXTURE_SECRET:mcpSecret,COUNTER_FILE:counter,SICLAW_MCP_OPERATION_POLICY:JSON.stringify({version:1,tools:{
          read_fixture:{effect:'read',fixedArguments:{'/tenant':'team-a'},allowedArguments:{'/namespace':['sicore-test']}},
          write_fixture:{effect:'write'},
        }})} } },
      authorizeMcp: async operation => {
        assert.equal(operation.kind,'tool');assert.equal(operation.name,'read_fixture');
        assert.equal(operation.arguments.tenant,'team-a');assert.equal(operation.arguments.namespace,'sicore-test');
        return {protocol:1,effect:'read',agentId:'fixture-agent',userId:'fixture-user',sessionId:'fixture-session',server:operation.server,kind:operation.kind,
          name:operation.name,argumentsDigest:mcpDigest(operation.arguments),configurationDigest:operation.configurationDigest,policyDigest:'a'.repeat(64)};
      },
    } : {}),
  });
  brain.registerProvider("fixture", {apiKey:"test",baseUrl:`http://127.0.0.1:${model.address().port}/v1`,
    api:"openai-responses",models:[{id:"gpt-6.1-sol",api:"openai-responses",contextWindow:128000,maxTokens:1000}]});
  await brain.setModel(brain.findModel("fixture","gpt-6.1-sol"));
  try { await brain.prompt("Inspect the kubectl client with native tools"); }
  catch (error) { throw fixtureError ?? error; }
  if (fixtureError) throw fixtureError;
  if (nativeMcp) {
    assert.ok(existsSync(counter));
    assert.deepEqual(readFileSync(counter,'utf8').trim().split('\n'),nativeChildren ? ['read_fixture','read_fixture'] : ['read_fixture']);
    assert.ok(!JSON.stringify(brain.getConversationMessages()).includes(mcpSecret));
    assert.ok(brain.getTools().some(tool=>tool.name==='mcp__fixture__read_fixture'));
    assert.ok(!brain.getTools().some(tool=>tool.name==='mcp__fixture__write_fixture'));
  }
  if (nativeChildren) {
    const deadline=Date.now()+5000;
    while (childCalls<3 && Date.now()<deadline) await new Promise((resolve) => setTimeout(resolve,50));
    assert.equal(childCalls,3);
  } else assert.equal(rootCalls,2);
  assert.ok(brain.getConversationMessages().some((message) => message.role==="assistant" &&
    message.content?.some?.((item) => item.text==="Code Mode complete")));
  console.log(`Native Code Mode smoke passed: gpt-6.1-sol, Responses Lite, source-built host, ${nativeMcp ? "native MCP, fixed tenant/namespace scope, no credential delivery, upstream write executions=0" : "native exec_command"}${nativeChildren ? ", native V2 spawn/wait and child execution" : ""}`);
} finally {
  await brain?.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  rmSync(root,{recursive:true,force:true});
}
