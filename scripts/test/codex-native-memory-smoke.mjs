// Uses the actual factory + official source-built app-server/memories extension.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {createSiclawSession} from "../../dist/core/agent-factory.js";
import {CodexAgentBrain} from "../../dist/core/brains/codex-agent-brain.js";

if (!process.env.SICLAW_CODEX_BIN) throw new Error("Set SICLAW_CODEX_BIN to the pinned source-built CLI");
const root=mkdtempSync(join(tmpdir(),"siclaw-native-memory-"));
const cwd=process.cwd();process.chdir(root);
process.env.SICLAW_CONFIG_DIR=join(root,"config");mkdirSync(process.env.SICLAW_CONFIG_DIR);
writeFileSync(join(process.env.SICLAW_CONFIG_DIR,"settings.json"),JSON.stringify({providers:{}}));
// The legacy switch must have no effect on Codex ownership.
process.env.SICLAW_MEMORY_ENABLED="true";
const filename="2026-10-06T00-00-00-native-memory-smoke.md";
const notePath=`extensions/ad_hoc/notes/${filename}`;
const marker="ALICE_PRIVATE_NATIVE_MEMORY";
let calls=0,phase="write",step=0,fixtureError;
const model=createServer(async (request,response)=>{
  try {
    let raw="";for await(const part of request)raw+=part;
    const body=JSON.parse(raw);assert.equal(body.model,"gpt-5.5");calls++;
    const memoryTurn=body.input.filter(x=>x.type==="message"&&x.role==="user").at(-1)
      ?.content?.some(x=>x.text?.startsWith("## Memory Writing Agent:"));
    if(!memoryTurn)step++;
    const definitions=[...(body.tools??[]),...body.input.filter(x=>x.type==="tool_search_output").flatMap(x=>x.tools)];
    assert.ok(!definitions.flatMap(x=>[x.name,...(x.tools??[]).map(y=>y.name)]).includes("memory_search"));
    let item;
    if(phase==="legacy"){
      assert.ok(JSON.stringify(body.input).includes("Native legacy history"));
      item={id:`legacy-${calls}`,type:"message",role:"assistant",status:"completed",
        content:[{type:"output_text",text:"Native legacy history preserved",annotations:[]}]};
    }else if(phase==="legacy-seed"||memoryTurn)item={id:`background-${calls}`,type:"message",role:"assistant",status:"completed",
      content:[{type:"output_text",text:"Native memory consolidation complete",annotations:[]}]};
    else if(step===1)item={id:`search-${calls}`,type:"tool_search_call",call_id:`search-${phase}`,execution:"client",
      arguments:{query:"memories add_ad_hoc_note read",limit:5},status:"completed"};
    else if(step===2){
      assert.ok(definitions.some(x=>x.name==="memories"),"the official memory namespace must be discoverable");
      item={id:`call-${calls}`,type:"function_call",namespace:"memories",name:phase==="write"?"add_ad_hoc_note":"read",
        call_id:`memory-${phase}`,arguments:JSON.stringify(phase==="write"?{filename,note:`# Native note\n${marker}\n`}:{path:notePath}),status:"completed"};
    }else{
      const result=body.input.find(x=>x.type==="function_call_output"&&x.call_id===`memory-${phase}`);
      assert.ok(result,"native memory call must return a result");
      const text=JSON.stringify(result.output);
      if(phase==="read")assert.ok(text.includes(marker),"a new conversation must read its owner's native note");
      if(phase==="other")assert.ok(!text.includes(marker),"another owner must not read the note");
      item={id:`answer-${calls}`,type:"message",role:"assistant",status:"completed",
        content:[{type:"output_text",text:"Native memory verified",annotations:[]}]};
    }
    const envelope={id:`resp-${calls}`,object:"response",created_at:Math.floor(Date.now()/1000),model:body.model,
      status:"completed",output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25}};
    response.writeHead(200,{"content-type":"text/event-stream"});
    const send=(type,payload)=>response.write(`event: ${type}\ndata: ${JSON.stringify({type,...payload})}\n\n`);
    send("response.created",{response:{...envelope,status:"in_progress",output:[]}});
    send("response.output_item.added",{output_index:0,item:{...item,...(item.type==="function_call"?{arguments:""}:item.type==="message"?{content:[]}:{}),status:"in_progress"}});
    if(item.type==="function_call")send("response.function_call_arguments.delta",{output_index:0,delta:item.arguments});
    if(item.type==="message")send("response.output_text.delta",{output_index:0,content_index:0,delta:item.content[0].text});
    send("response.output_item.done",{output_index:0,item});send("response.completed",{response:envelope});response.end();
  }catch(error){fixtureError??=error;response.writeHead(500).end(JSON.stringify({error:{message:error.message}}));}
});
await new Promise(resolve=>model.listen(0,"127.0.0.1",resolve));
let resource;
async function run(nextPhase,userId,sessionName){
  phase=nextPhase;step=0;
  resource=await createSiclawSession({agentEngine:"codex",agentType:"custom",harnessResolved:true,
    allowedTools:["read","write","bash"],agentId:"memory-agent",userId,
    sessionManager:SessionManager.create(root,join(root,"transcripts",sessionName))});
  assert.equal(resource.memoryIndexer,undefined);assert.equal(resource.contextManifest.resources.memoryEnabled,false);
  assert.ok(!existsSync(join(root,".siclaw","user-data","memory")));
  resource.brain.registerProvider("fixture",{api:"openai-responses",apiKey:"test",baseUrl:`http://127.0.0.1:${model.address().port}/v1`,
    models:[{id:"gpt-5.5",api:"openai-responses",contextWindow:128000,maxTokens:1000}]});
  await resource.brain.setModel(resource.brain.findModel("fixture","gpt-5.5"));
  try{await resource.brain.prompt(nextPhase==="write"?"Remember this native test note":"Read the native test note");}
  catch(error){throw fixtureError??error;}
  const home=resource.brain.home;
  await resource.brain.close();resource.knowledgeIndexer?.close();resource=undefined;
  return home;
}
function bind(brain){
  brain.registerProvider("fixture",{api:"openai-responses",apiKey:"test",baseUrl:`http://127.0.0.1:${model.address().port}/v1`,
    models:[{id:"gpt-5.5",api:"openai-responses",contextWindow:128000,maxTokens:1000}]});
  return brain.setModel(brain.findModel("fixture","gpt-5.5"));
}
try{
  const first=await run("write","alice","first");
  assert.ok(existsSync(join(first,"memories",notePath)));
  const second=await run("read","alice","second");assert.equal(first,second);
  const other=await run("other","bob","third");assert.notEqual(first,other);
  const legacyDir=join(root,"transcripts","old-private-home");
  const oldSession=SessionManager.create(root,legacyDir);
  const oldBrain=await CodexAgentBrain.create({sessionManager:oldSession,systemPrompt:"Reply briefly",
    grants:{readRoots:[root],writeRoots:[],deniedRoots:[],allowCommands:false,production:false},
    cwd:root,skillPaths:[],toolsetsByName:new Map()});
  phase="legacy-seed";step=0;await bind(oldBrain);await oldBrain.prompt("Native legacy history");await oldBrain.close();
  const markerFile=join(legacyDir,"codex-thread.json");
  const saved=JSON.parse(readFileSync(markerFile,"utf8"));delete saved.rolloutPath;writeFileSync(markerFile,JSON.stringify(saved));
  resource=await createSiclawSession({agentEngine:"codex",agentType:"custom",harnessResolved:true,
    allowedTools:["read"],agentId:"legacy-agent",userId:"legacy-owner",sessionManager:SessionManager.continueRecent(root,legacyDir)});
  await bind(resource.brain);phase="legacy";step=0;await resource.brain.prompt("Continue after moving native storage");
  await resource.brain.close();resource.knowledgeIndexer?.close();resource=undefined;
  console.log(`Native memory smoke passed: ${calls} model calls, official memories namespace, write/read, cross-conversation persistence, owner isolation, legacy memory switch independence`);
}finally{
  await resource?.brain.close();resource?.knowledgeIndexer?.close();model.closeAllConnections();
  await new Promise(resolve=>model.close(resolve));process.chdir(cwd);rmSync(root,{recursive:true,force:true});
}
