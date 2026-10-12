// Fixed upstream source binary, real native file reads/MCP/child lifecycle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CodexAgentBrain } from '../../dist/core/brains/codex-agent-brain.js';
assert.ok(process.env.SICLAW_CODEX_BIN,'Use the pinned source-built Codex');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-knowledge-smoke-'));fs.chmodSync(root,0o755);
const workspace=path.join(root,'workspace'),knowledge=path.join(root,'knowledge');fs.mkdirSync(workspace);fs.mkdirSync(knowledge);
const page=path.join(knowledge,'guide.md'),url='https://docs.example.org/runbook';
const secret='private-citation-model-key';
const raw=`---\nsources:\n  - id: src-a\n    resource: raw/runbook.md\n---\n<!-- okf:evidence {"id":"gpu-check","sources":["src-a"]} -->\n# GPU checks\nInspect the GPU before replacing it.\npassword: ${secret}\n`;
fs.writeFileSync(page,raw);fs.writeFileSync(path.join(knowledge,'.citation-manifest.json'),JSON.stringify({version:1,repos:[{id:'fixture-kb',root:'',sources:[{sourceId:'src-a',resource:'runbook.md',title:'Runbook',url}]}]}));
let calls=0,rootCalls=0,childCalls=0,childId,error,resuming=false,resumeCalls=0;
const events=[],sources=[],operations=[];
const fn=(name,args,id,namespace)=>({id,type:'function_call',...(namespace?{namespace}:{}),name,call_id:id,arguments:JSON.stringify(args),status:'completed'});
const search=(id,query)=>({id,type:'tool_search_call',call_id:id,execution:'client',arguments:{query,limit:8},status:'completed'});
const answer=id=>({id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'NATIVE_KNOWLEDGE_ACCEPTED',annotations:[]}]});
const output=(body,id)=>{const value=body.input.find(x=>x.type==='function_call_output'&&x.call_id===id)?.output??'';return typeof value==='string'?value:Array.isArray(value)?value.map(x=>x.text??'').join('\n'):JSON.stringify(value);};
const model=createServer(async(req,res)=>{try {
 let data='';for await(const part of req)data+=part;const body=JSON.parse(data);assert.ok(!data.includes(secret),'credential reached model body');
 const user=body.input.filter(x=>x.type==='message'&&x.role==='user').at(-1)?.content??[];
 const memory=user.some(x=>x.text?.startsWith('## Memory Writing Agent:'));
 const child=user.some(x=>x.text?.includes('CHILD_KNOWLEDGE_ONLY'));
 calls++;let item;
 if(memory)item=answer('memory-'+calls);
 else if(child){childCalls++;
  if(childCalls===1)item=fn('exec_command',{cmd:`cat ${page}`,login:false},'child-read');
  else if(childCalls===2)item=search('child-search','knowledge_cite');
  else if(childCalls===3)item=fn('knowledge_cite',{evidence_refs:['guide.md#gpu-check']},'child-cite','mcp__siclaw_knowledge');
  else {assert.match(String(output(body,'child-cite')),/"cited"\s*:\s*1/);item=answer('child-answer');}
 } else if(resuming){resumeCalls++;
  if(resumeCalls===1)item=search('resume-search','knowledge_cite');
  else if(resumeCalls===2)item=fn('knowledge_cite',{evidence_refs:['guide.md#gpu-check']},'resume-unread','mcp__siclaw_knowledge');
  else if(resumeCalls===3){assert.match(String(output(body,'resume-unread')),/Unresolved|unread/);item=fn('exec_command',{cmd:`cat ${page}`,login:false},'resume-read');}
  else if(resumeCalls===4)item=fn('knowledge_cite',{evidence_refs:['guide.md#gpu-check']},'resume-cite','mcp__siclaw_knowledge');
  else {assert.match(String(output(body,'resume-cite')),/"cited"\s*:\s*1/);item=answer('resumed-answer');}
 } else {rootCalls++;
  if(rootCalls===1)item=search('search','knowledge_cite spawn_agent wait_agent');
  else if(rootCalls===2)item=fn('knowledge_cite',{pages:[{path:'/etc/shadow',claim:'This private file must never be read.'}]},'path-denial','mcp__siclaw_knowledge');
  else if(rootCalls===3){assert.match(String(output(body,'path-denial')),/not authorized|private|blocked/i);item=fn('knowledge_cite',{evidence_refs:['guide.md#gpu-check']},'unread','mcp__siclaw_knowledge');}
  else if(rootCalls===4){assert.match(String(output(body,'unread')),/Unresolved|unread/);item=fn('exec_command',{cmd:`cat ${page}`,login:false},'read');}
  else if(rootCalls===5){assert.ok(!String(output(body,'read')).includes(secret));item=fn('knowledge_cite',{evidence_refs:['guide.md#gpu-check']},'cite','mcp__siclaw_knowledge');}
  else if(rootCalls===6){if(process.env.SICLAW_CITATION_SMOKE_TRACE==='1')console.log('CITE_REPLY',output(body,'cite'));assert.match(String(output(body,'cite')),/"cited"\s*:\s*1/);item=fn('spawn_agent',{message:'CHILD_KNOWLEDGE_ONLY: read and cite the mounted guide, then finish.',fork_context:false},'spawn','multi_agent_v1');}
  else if(rootCalls===7){childId=JSON.parse(output(body,'spawn')).agent_id;assert.ok(childId);item=fn('wait_agent',{targets:[childId],timeout_ms:10000},'wait','multi_agent_v1');}
  else if(rootCalls===8)item=fn('close_agent',{agent_id:childId},'close','multi_agent_v1');
  else item=answer('root-answer');
 }
 const rid='response-'+calls,envelope={id:rid,object:'response',created_at:1,status:'completed',model:'gpt-5.5',output:[item],usage:{input_tokens:100,output_tokens:20,total_tokens:120}};
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const send=(type,value)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
 send('response.created',{response:{...envelope,output:[],status:'in_progress'}});
 send('response.output_item.added',{output_index:0,item:{...item,...(item.type==='function_call'?{arguments:''}:item.type==='message'?{content:[]}:{}),status:'in_progress'}});
 if(item.type==='function_call')send('response.function_call_arguments.delta',{output_index:0,delta:item.arguments});
 else if(item.type==='message')send('response.output_text.delta',{output_index:0,content_index:0,delta:item.content[0].text});
 send('response.output_item.done',{output_index:0,item});send('response.completed',{response:envelope});res.end();
 }catch(e){error??=e;console.error('Native citation model assertion failed',calls,rootCalls,childCalls,resumeCalls,e.message);res.writeHead(500).end('{"error":{"message":"citation fixture failed"}}');}});
await new Promise(r=>model.listen(0,'127.0.0.1',r));let brain;
const make=async manager=>{
 const value=await CodexAgentBrain.create({sessionManager:manager,cwd:workspace,systemPrompt:'Read mounted knowledge with native cat, then use native MCP knowledge_cite. Use only real tools.',skillPaths:[],toolsetsByName:new Map(),allowSubagents:true,
  grants:{readRoots:[workspace,knowledge],writeRoots:[],deniedRoots:[],allowCommands:false,allowFileCommands:true,production:process.env.NODE_ENV==='production',environment:{PATH:process.env.PATH}},
  knowledge:{directory:knowledge,emit:e=>sources.push(e)}});
 value.registerProvider('fixture',{apiKey:secret,baseUrl:`http://127.0.0.1:${model.address().port}/v1`,api:'openai-responses',models:[{id:'gpt-5.5',api:'openai-responses',contextWindow:128000,maxTokens:1000}]});
 await value.setModel(value.findModel('fixture','gpt-5.5'));
 if(process.env.SICLAW_CITATION_SMOKE_TRACE==='1') {
  const k=value.knowledge,observe=k.observe.bind(k),call=k.call.bind(k);
  k.observe=e=>{const result=observe(e);if(e.params.item?.type==='mcpToolCall')console.log('CITE_ITEM',e.method,e.params.item.id,e.params.item.server,e.params.item.tool,e.params.threadId,e.params.turnId);if(e.params.item?.type==='commandExecution')console.log('CITE_READ',e.method,e.params.item.id,e.params.item.cwd,e.params.item.command,e.params.item.status,e.params.item.exitCode,[...k.reads.keys()]);return result;};
  k.call=(a,id,signal)=>{console.log('CITE_ROUTE',id,[...k.calls.keys()],[...k.scopes.keys()]);return call(a,id,signal);};
  value.mcpGateway.http.prependListener('request',req=>{let raw='';req.on('data',x=>raw+=x);req.on('end',()=>{try{const x=JSON.parse(raw);if(x.method==='tools/call')console.log('CITE_META_KEYS',Object.keys(x.params._meta??{}),x.params._meta?.callId);}catch{}});});
 }

 value.subscribe(e=>events.push(e));value.setNativeChildSink({persist:async op=>operations.push(op),activity:()=>{}});return value;
};
try {
 const transcripts=path.join(root,'transcripts');brain=await make(SessionManager.create(workspace,transcripts));await brain.prompt('Read and cite the actual guide, including one native child');if(error)throw error;
 assert.ok(sources.some(e=>e.sources.some(s=>s.url===url&&s.evidence==='gpu-check')),'root citation event absent');
 const denied=events.find(e=>e.type==='tool_execution_end'&&e.toolCallId==='path-denial');
 assert.ok(denied?.isError);assert.ok(denied.result.content[0].text,'native error-only reason absent');
 assert.ok(operations.some(op=>op.type==='message'&&op.role==='assistant'&&op.metadata?.knowledge_citations),'child citation metadata absent');
 assert.ok(!JSON.stringify({events,sources,operations}).includes(secret));
 await brain.close();resuming=true;brain=await make(SessionManager.continueRecent(workspace,transcripts));await brain.prompt('Verify native cold resume and a fresh citation turn');if(error)throw error;
 assert.equal(resumeCalls,5);assert.ok(!JSON.stringify(brain.getConversationMessages()).includes(secret));
 console.log('Native knowledge smoke passed: source-built Codex, native cat/MCP discovery, error reason, unread/private denial, root/child citation metadata, fresh-turn isolation and cold resume; model bodies secret-free');
} finally {await brain?.close();await new Promise(r=>model.close(r));fs.rmSync(root,{recursive:true,force:true});}
