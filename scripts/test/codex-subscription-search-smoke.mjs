// Explicit local opt-in only. Never package a user's auth file or upload it.
// Uses only the existing access token in host memory; never transfers refresh.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CodexAgentBrain } from "../../dist/core/brains/codex-agent-brain.js";

assert.equal(process.env.SICLAW_TEST_EXISTING_SUBSCRIPTION, "1", "Explicit local subscription-test opt-in required");
assert.ok(process.env.SICLAW_CODEX_BIN, "Select the locally installed native binary explicitly");
const mode=process.argv[2]??"live";assert.ok(["live","cached"].includes(mode),"Choose live or cached");
const auth=path.join(os.homedir(),".codex","auth.json");
assert.ok(fs.lstatSync(auth).isFile(), "Existing native file-backed login required");
const accessToken=JSON.parse(fs.readFileSync(auth,"utf8")).tokens?.access_token;
assert.equal(typeof accessToken,"string","Missing native access token");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"siclaw-subscription-search-"));fs.chmodSync(root,0o700);
const nativeHome=path.join(root,"native");fs.mkdirSync(nativeHome,{mode:0o700});
let brain;const events=[];let timer;
try{
 brain=await CodexAgentBrain.create({sessionManager:SessionManager.create(root,path.join(root,"transcripts")),
  cwd:root,codexHome:nativeHome,skillPaths:[],toolsetsByName:new Map(),webSearchMode:mode,
  systemPrompt:"Only research public Kubernetes documentation with native web search. Do not use filesystem, shell, MCP or other agents. Cite a public URL. Never inspect local authentication files.",
  grants:{readRoots:[],writeRoots:[],deniedRoots:[nativeHome,auth],allowCommands:false,production:false}});
 brain.registerProvider("subscription-test",{authHeader:false,apiKey:accessToken,api:"openai-codex-responses",baseUrl:"https://chatgpt.com/backend-api",
  models:[{id:"gpt-5.6-luna",api:"openai-codex-responses",contextWindow:128000,maxTokens:1000}]});
 await brain.setModel(brain.findModel("subscription-test","gpt-5.6-luna"));
 brain.subscribe(event=>{if(event.type==="tool_execution_start"||event.type==="tool_execution_end")events.push({type:event.type,name:event.toolName,isError:event.isError});
  if(event.type==="message_end"&&event.message?.role==="assistant")events.push({type:"answer",text:event.message.content?.filter(c=>c.type==="text").map(c=>c.text).join("\n")});});
 timer=setTimeout(()=>void brain.abort(),180000);
 await brain.prompt("Use native web search now to find official Kubernetes documentation about readiness and liveness probes. Return one short comparison with its verified official URL and SICLAW_SUBSCRIPTION_SEARCH_OK. Do not answer from memory if search is unavailable.");
 assert.ok(events.some(e=>e.type==="tool_execution_end"&&e.name==="web_search"&&!e.isError),"No completed real native search through Siclaw");
 assert.ok(events.some(e=>e.type==="answer"&&e.text?.includes("SICLAW_SUBSCRIPTION_SEARCH_OK")&&e.text.includes("https://kubernetes.io/")),"Missing researched answer/citation");
 assert.ok(events.filter(e=>e.type==="tool_execution_start").every(e=>["web_search"].includes(e.name)),"Unexpected non-search execution");
 assert.ok(!JSON.stringify(events).includes(accessToken));
 console.log(JSON.stringify({passed:true,mode,engine:"Siclaw CodexAgentBrain",auth:"standard subscription provider mapping; access token only",binary:"installed local Codex; not pinned Linux build",events,credentialsExported:false,refreshTokenUsed:false}));
}finally{
 clearTimeout(timer);await brain?.close();
 // Remove only the new owned directory; the native login is never modified.
 fs.rmSync(root,{recursive:true,force:true});
}
