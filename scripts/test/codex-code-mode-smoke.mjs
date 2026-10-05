// Source-built native catalog/Code Mode test. Run inside the AgentBox image,
// which includes the matching codex-code-mode-host and upstream V8 sandbox.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CodexAgentBrain } from "../../dist/core/brains/codex-agent-brain.js";

const root = mkdtempSync(join(tmpdir(), "siclaw-code-mode-"));
chmodSync(root, 0o755);
let calls = 0;
let fixtureError;
const code = 'text(JSON.stringify(await tools.exec_command({cmd:"kubectl version --client",login:false})));';
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    assert.equal(body.model, "gpt-6.1-sol");
    assert.equal(request.url, "/v1/responses");
    const tools = body.input.find((item) => item.type === "additional_tools")?.tools;
    assert.ok(tools?.some((tool) => tool.name === "exec"), "preserve the catalog's native Code Mode tools");
    assert.equal(body.tools, undefined, "preserve native Responses Lite presentation");
    calls++;
    if (calls === 2) {
      const output = body.input.find((item) => item.type === "custom_tool_call_output" && item.call_id === "code");
      assert.match(JSON.stringify(output), /Client Version/);
      assert.ok(!JSON.stringify(output).includes("host unavailable"));
    }
    const item = calls === 1 ? { id: "code-1", type: "custom_tool_call", name: "exec", call_id: "code", input: code }
      : { id: "answer", type: "message", role: "assistant", content: [{type:"output_text",text:"Code Mode complete",annotations:[]}] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({type,...payload})}\n\n`);
    const envelope = { id:`resp-${calls}`, object:"response", model:body.model, output:[item], status:"completed",
      usage:{input_tokens:20,output_tokens:5,total_tokens:25} };
    send("response.created", {response:{...envelope,status:"in_progress",output:[]}});
    send("response.output_item.added", {output_index:0,item:{...item,...(calls===1?{input:""}:{content:[]}),status:"in_progress"}});
    if (calls === 1) send("response.custom_tool_call_input.delta", {output_index:0,delta:code});
    else send("response.output_text.delta", {output_index:0,content_index:0,delta:"Code Mode complete"});
    send("response.output_item.done", {output_index:0,item:{...item,status:"completed"}});
    send("response.completed", {response:envelope});
    response.end();
  } catch (error) {
    fixtureError = error;
    response.writeHead(500).end(JSON.stringify({error:{message:error.message}}));
  }
});
await new Promise((resolve) => model.listen(0,"127.0.0.1",resolve));
let brain;
try {
  brain = await CodexAgentBrain.create({sessionManager:SessionManager.create(root,join(root,"transcripts")),
    systemPrompt:"Reply briefly",grants:{readRoots:[root],writeRoots:[],deniedRoots:[join(root,"transcripts")],
      allowCommands:true,production:process.env.NODE_ENV==="production",environment:{PATH:process.env.PATH}},
    cwd:root,skillPaths:[],toolsetsByName:new Map()});
  brain.registerProvider("fixture", {apiKey:"test",baseUrl:`http://127.0.0.1:${model.address().port}/v1`,
    api:"openai-responses",models:[{id:"gpt-6.1-sol",api:"openai-responses",contextWindow:128000,maxTokens:1000}]});
  await brain.setModel(brain.findModel("fixture","gpt-6.1-sol"));
  await brain.prompt("Inspect the kubectl client with native tools");
  if (fixtureError) throw fixtureError;
  assert.equal(calls,2);
  assert.ok(brain.getConversationMessages().some((message) => message.role==="assistant" &&
    message.content?.some?.((item) => item.text==="Code Mode complete")));
  console.log("Native Code Mode smoke passed: gpt-6.1-sol, Responses Lite, source-built host, native exec_command");
} finally {
  await brain?.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  rmSync(root,{recursive:true,force:true});
}
