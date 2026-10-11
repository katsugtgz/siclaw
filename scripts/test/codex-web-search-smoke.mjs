// Pinned native Codex, synthetic Responses endpoint; no external search or secrets.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CodexAgentBrain } from "../../dist/core/brains/codex-agent-brain.js";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-web-search-"));fs.chmodSync(root,0o755);
let mode="disabled",modelName="gpt-5.5",failure,calls=0,searchCalls=0;
const server=createServer(async(req,res)=>{try{
 let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
 if(req.url==="/v1/alpha/search"){
  assert.notEqual(mode,"disabled");assert.equal(body.settings.external_web_access,mode==="live");
  assert.equal(body.commands.search_query[0].q,"Kubernetes documentation");searchCalls++;
  res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({output:"Kubernetes docs: https://kubernetes.io/docs/"}));return;
 }
 const tools=body.tools??body.input.find(x=>x.type==="additional_tools")?.tools??[];
 const lite=modelName!=="gpt-5.5";
 const directSearch=tools.find(x=>x.name==="web"&&x.tools?.some(t=>t.name==="run"));
 const codeSearch=lite&&JSON.stringify(tools).includes("web__run");
 const search=lite?(directSearch||codeSearch):tools.find(x=>x.type==="web_search");
 assert.equal(Boolean(search),mode!=="disabled",JSON.stringify(tools.map(x=>({type:x.type,name:x.name}))));
 if(search&&!lite)assert.equal(search.external_web_access,mode==="live");
 calls++;
 const message={id:"answer-"+calls,type:"message",role:"assistant",content:[{type:"output_text",text:"See [Kubernetes docs](https://kubernetes.io/docs/).",annotations:[]}]};
 const returned=body.input.some(x=>["function_call_output","custom_tool_call_output"].includes(x.type)&&String(x.call_id).startsWith("search-"));
 const call=codeSearch&&!directSearch?{id:"search-"+calls,call_id:"search-"+calls,type:"custom_tool_call",namespace:"functions",name:"exec",input:'text(await tools.web__run({search_query:[{q:"Kubernetes documentation"}]}));'}
 :{id:"search-"+calls,call_id:"search-"+calls,type:"function_call",namespace:"web",name:"run",arguments:JSON.stringify({search_query:[{q:"Kubernetes documentation"}]})};
 const items=mode==="disabled"||returned?[message]:lite?[call]:[{id:"search-"+calls,type:"web_search_call",status:"completed",action:{type:"search",query:"Kubernetes documentation"}},message];
 res.writeHead(200,{"content-type":"text/event-stream"});
 const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
 const response={id:"response-"+calls,object:"response",model:body.model,status:"completed",output:items,usage:{input_tokens:20,output_tokens:5,total_tokens:25}};
 emit("response.created",{response:{...response,output:[],status:"in_progress"}});
 for(const [output_index,item]of items.entries()){
 emit("response.output_item.added",{output_index,item:{...item,status:"in_progress",...(item.type==="message"?{content:[]}:item.type==="function_call"?{arguments:""}:item.type==="custom_tool_call"?{input:""}: {})}});
 if(item.type==="message")emit("response.output_text.delta",{output_index,content_index:0,delta:item.content[0].text});
 if(item.type==="function_call")emit("response.function_call_arguments.delta",{output_index,delta:item.arguments});
 if(item.type==="custom_tool_call")emit("response.custom_tool_call_input.delta",{output_index,delta:item.input});
 emit("response.output_item.done",{output_index,item});
 }
 emit("response.completed",{response});res.end();
}catch(error){failure??=error;res.writeHead(500).end("Fixture assertion failed");}});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
try{
for(modelName of ["gpt-5.5","gpt-5.6-luna","gpt-6-astra"])for(mode of ["disabled","cached","live"]){
 searchCalls=0;const events=[];const cwd=path.join(root,modelName+mode);fs.mkdirSync(cwd,{mode:0o755});
 const brain=await CodexAgentBrain.create({sessionManager:SessionManager.create(cwd,path.join(cwd,"transcripts")),cwd,skillPaths:[],toolsetsByName:new Map(),systemPrompt:"Reply briefly with a public source link.",webSearchMode:mode,
 grants:{readRoots:[],writeRoots:[],deniedRoots:[],allowCommands:false,production:false}});
 try{
 brain.subscribe(e=>events.push(e));brain.registerProvider("fixture",{api:"openai-responses",baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:"synthetic-only",models:[{id:modelName,api:"openai-responses",contextWindow:128000,maxTokens:1000}]});
 await brain.setModel(brain.findModel("fixture",modelName));try{await brain.prompt("Research Kubernetes docs.");}catch(e){throw failure??e;}
 if(failure)throw failure;
 assert.equal(events.some(e=>e.type==="tool_execution_end"&&e.toolName==="web_search"),mode!=="disabled");
 assert.ok(JSON.stringify(brain.getConversationMessages()).includes("https://kubernetes.io/docs/"));
 assert.equal(searchCalls,modelName!=="gpt-5.5"&&mode!=="disabled"?1:0);
 console.log(JSON.stringify({gate:"native-web-search",model:modelName,mode,passed:true,publicCitations:true,shellNetworkingChanged:false}));
 }finally{await brain.close();}
}
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
