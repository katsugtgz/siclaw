// Fixed native app-server: changed Skill set, legacy sidecar, same thread/home,
// withdrawn execution denial, cross-owner refusal and new-conversation scope.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {CodexAgentBrain} from '../../dist/core/brains/codex-agent-brain.js';
import {codexHomeForScope} from '../../dist/core/brains/codex-home.js';
assert.ok(process.env.SICLAW_CODEX_BIN,'Use the fixed source-built binary');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-home-resume-'));
const workspace=path.join(root,'workspace'),data=path.join(root,'data'),transcripts=path.join(root,'transcripts');
const skill={name:'withdrawn',filePath:path.join(root,'skill','SKILL.md')};
for(const dir of [workspace,data,path.join(root,'skill','scripts')])fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(skill.filePath,'---\nname: withdrawn\ndescription: Harmless selected Skill fixture\n---\nNo production access.\n');
fs.writeFileSync(path.join(root,'skill','scripts','read.sh'),'#!/bin/bash\nprintf FORBIDDEN_SKILL_EXECUTION\n');
let modelCalls=0,resumeCalls=0,fixtureError,oldHome,brain;
const model=createServer(async(req,res)=>{try{
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
 const texts=body.input.filter(x=>x.type==='message'&&x.role==='user').flatMap(x=>x.content??[]).map(x=>x.text??'');
 const last=texts.at(-1)??'';let item;
 const output=id=>{const value=body.input.find(x=>x.type==='function_call_output'&&x.call_id===id)?.output;return typeof value==='string'?value:JSON.stringify(value);};
 const call=(id,cmd)=>({id,type:'function_call',name:'exec_command',call_id:id,arguments:JSON.stringify({cmd,login:false,environment_id:'siclaw'}),status:'completed'});
 const answer=text=>({id:'answer-'+modelCalls,type:'message',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]});
 if(last==='SEED_HOME_HISTORY'){modelCalls++;item=answer('SEED_HOME_HISTORY_ACK');}
 else if(last==='RESUME_WITHOUT_SKILL'){
  modelCalls++;resumeCalls++;assert.ok(raw.includes('SEED_HOME_HISTORY_ACK'),'Native history must survive the changed Skill set');
  if(resumeCalls===1)item=call('withdrawn-read',`cat ${path.join(oldHome,'skills','withdrawn','SKILL.md')}`);
  else if(resumeCalls===2){assert.match(output('withdrawn-read'),/grant|denied|not authorized|not allowed/i);item=call('withdrawn-script',`bash ${path.join(oldHome,'skills','withdrawn','scripts','read.sh')}`);}
  else{assert.match(output('withdrawn-script'),/grant|denied|Skill|script|allowed|authorized/i);assert.ok(!output('withdrawn-script').includes('FORBIDDEN_SKILL_EXECUTION'));item=answer('NATIVE_HOME_RESUME_OK');}
 }else if(last==='NEW_EMPTY_SCOPE'){
  modelCalls++;assert.ok(!raw.includes('SEED_HOME_HISTORY_ACK'),'New conversation must not inherit old history');item=answer('NEW_HOME_SCOPE_OK');
 }else item=answer('Background fixture complete');
 const envelope={id:'response-'+modelCalls+'-'+Date.now(),object:'response',model:body.model,status:'completed',output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25}};
 res.writeHead(200,{'content-type':'text/event-stream'});const send=(type,value)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
 send('response.created',{response:{...envelope,output:[],status:'in_progress'}});
 send('response.output_item.added',{output_index:0,item:{...item,...(item.type==='function_call'?{arguments:''}:{content:[]}),status:'in_progress'}});
 if(item.type==='function_call')send('response.function_call_arguments.delta',{output_index:0,delta:item.arguments});else send('response.output_text.delta',{output_index:0,content_index:0,delta:item.content[0].text});
 send('response.output_item.done',{output_index:0,item});send('response.completed',{response:envelope});res.end();
}catch(error){fixtureError??=error;res.writeHead(500).end(JSON.stringify({error:{message:'Scope fixture assertion failed'}}));}});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
const make=async(manager,userId,skills)=>{
 const owner={agentId:'fixture',userId,sessionId:manager.getSessionId()},home=codexHomeForScope(data,{...owner,skills});
 const created=await CodexAgentBrain.create({sessionManager:manager,cwd:workspace,systemPrompt:'Use only the specified fixture operations.',
  codexHome:home,codexHomeScope:{...owner,userDataDir:data},skillPaths:skills,toolsetsByName:new Map(),
  grants:{readRoots:[workspace,...skills.map(s=>path.dirname(s.filePath))],writeRoots:[],deniedRoots:[path.join(data,'agent','codex'),transcripts],allowCommands:false,allowFileCommands:true,production:false}});
 created.registerProvider('fixture',{api:'openai-responses',apiKey:'synthetic-home-fixture',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,models:[{id:'gpt-5.5',api:'openai-responses',contextWindow:128000,maxTokens:1000}]});
 await created.setModel(created.findModel('fixture','gpt-5.5'));return created;
};
try{
 const manager=SessionManager.create(workspace,transcripts);
 brain=await make(manager,'alice',[skill]);oldHome=brain.home;await brain.prompt('SEED_HOME_HISTORY');await brain.close();
 const marker=path.join(transcripts,'codex-thread.json');const original=JSON.parse(fs.readFileSync(marker,'utf8'));
 assert.ok(original.rolloutPath);assert.equal(original.home,oldHome);assert.ok(original.ownerKey);
 // Exactly the old format observed in the live failed conversation.
 const legacy={threadId:original.threadId,lastTurnId:original.lastTurnId,rolloutPath:original.rolloutPath};fs.writeFileSync(marker,JSON.stringify(legacy));
 brain=await make(SessionManager.continueRecent(workspace,transcripts),'alice',[]);
 assert.equal(brain.home,oldHome);await brain.prompt('RESUME_WITHOUT_SKILL');await brain.close();
 const migrated=JSON.parse(fs.readFileSync(marker,'utf8'));assert.equal(migrated.threadId,original.threadId);assert.equal(migrated.home,oldHome);assert.ok(migrated.ownerKey);
 const before=fs.readFileSync(marker,'utf8'),calls=modelCalls;
 await assert.rejects(make(SessionManager.continueRecent(workspace,transcripts),'bob',[]),/different owner/);
 assert.equal(modelCalls,calls);assert.equal(fs.readFileSync(marker,'utf8'),before,'Owner refusal must not discard history or sidecar');
 const newManager=SessionManager.create(workspace,path.join(root,'new-transcripts'));
 brain=await make(newManager,'alice',[]);assert.notEqual(brain.home,oldHome);await brain.prompt('NEW_EMPTY_SCOPE');
 if(fixtureError)throw fixtureError;
 assert.equal(resumeCalls,3);
 console.log('Native home resume smoke passed: legacy owner-verified restore, same native thread/history, revoked Skill read/script denied, cross-owner refused before model, new-conversation scope unchanged; no DB or memory copy');
}finally{await brain?.close();model.closeAllConnections();await new Promise(resolve=>model.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
