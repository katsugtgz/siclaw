// Real Linux upstream exec-server / sandbox UID with a broker-owned Kubernetes
// API fixture. This proves protocol/security, not a live production-cluster run.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { KubeConfig } from "@kubernetes/client-node";
import { CredentialBroker } from "../../dist/agentbox/credential-broker.js";
import { CodexExecutorRelay } from "../../dist/core/brains/codex-executor-relay.js";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"siclaw-channel-smoke-"));fs.chmodSync(root,0o755);
const workspace=path.join(root,"workspace");fs.mkdirSync(workspace,{mode:0o777});fs.chmodSync(workspace,0o777);
const canary="REAL-CHANNEL-KUBECONFIG-CANARY";let active=true;const paths=[];
const upstream=http.createServer((req,res)=>{
 paths.push(req.url);assert.equal(req.headers.authorization,"Bearer "+canary);
 res.setHeader("content-type","application/json");
 if(req.url.startsWith("/api/v1/namespaces/allowed/pods"))res.end(JSON.stringify({apiVersion:"v1",kind:"PodList",items:[{apiVersion:"v1",kind:"Pod",metadata:{name:"channel-safe",namespace:"allowed"}}]}));
 else if(req.url.startsWith("/api/v1"))res.end(JSON.stringify({apiVersion:"v1",kind:"APIResourceList",groupVersion:"v1",resources:[{name:"pods",singularName:"pod",namespaced:true,kind:"Pod",verbs:["get","list"]}]}));
 else if(req.url.startsWith("/apis"))res.end(JSON.stringify({apiVersion:"v1",kind:"APIGroupList",groups:[]}));
 else res.end(JSON.stringify({apiVersion:"v1",kind:"APIVersions",versions:["v1"]}));
});
await new Promise(resolve=>upstream.listen(0,"127.0.0.1",resolve));
const real=JSON.stringify({apiVersion:"v1",kind:"Config","current-context":"private",clusters:[{name:"private",cluster:{server:`http://127.0.0.1:${upstream.address().port}`,"insecure-skip-tls-verify":true}}],contexts:[{name:"private",context:{cluster:"private",user:"private"}}],users:[{name:"private",user:{token:canary}}]});
const policy={version:1,revision:"fixture:1",fingerprint:"a".repeat(64),operations:["query"],namespaces:["allowed"],mcp:[],knowledgeIds:[],reports:false,attachments:false};
assert.equal(typeof KubeConfig.prototype.applyToHTTPSOptions,"function","Image Kubernetes SDK must match source broker API");
const validate=async()=>{if(!active)throw new Error("revoked")};
const broker=new CredentialBroker({listClusters:async()=>[{name:"fixture"}],listHosts:async()=>[],getHostCredential:async()=>{throw Error("no hosts")},getClusterCredential:async()=>({credential:{name:"fixture",type:"kubeconfig",metadata:{name:"fixture"},files:[{name:"kubeconfig",content:real}]}})},path.join(root,"credentials"),{policy,validate});
let scopedPath="";
const relay=new CodexExecutorRelay({executable:process.env.SICLAW_CODEX_BIN,home:path.join(root,"executor"),cwd:workspace,grants:{readRoots:[workspace],writeRoots:[workspace],deniedRoots:[path.join(root,"credentials")],allowCommands:true,allowFileCommands:false,production:process.env.NODE_ENV==="production",channelPolicy:policy,validateChannelPolicy:validate,resolveKubeconfig:async()=>{
 await broker.acquireCluster("fixture","channel-native-smoke",{bypassCache:true});scopedPath=(await broker.ensureCluster("fixture")).path;return scopedPath;
}}});
let socket;const events=[];
try {
 await relay.start();socket=new WebSocket(relay.url,{headers:{Authorization:`Bearer ${relay.bearerToken}`}});
 const pending=new Map();let next=0;
 socket.on("message",raw=>{const msg=JSON.parse(raw.toString());if(msg.id!==undefined){pending.get(msg.id)?.(msg);pending.delete(msg.id);}else events.push(msg);});
 await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject)});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>reject(Error(method+" timeout")),20000);pending.set(id,msg=>{clearTimeout(timer);resolve(msg)});socket.send(JSON.stringify({id,method,params}));});
 assert.ok((await rpc("initialize",{clientName:"channel-policy-smoke"})).result);socket.send(JSON.stringify({method:"initialized",params:{}}));
 const execute=async(id,cmd)=>{
  const result=await rpc("process/start",{processId:id,argv:["/bin/bash","-c",cmd],cwd:pathToFileURL(workspace).href,env:{KUBECONFIG:"/attacker"},tty:false,pipeStdin:true});
  if(result.error)return {error:result.error};
  const end=Date.now()+20000;while(!events.some(e=>e.method==="process/exited"&&e.params.processId===id)){assert.ok(Date.now()<end,"process exit timeout");await new Promise(resolve=>setTimeout(resolve,25));}
  return events.find(e=>e.method==="process/exited"&&e.params.processId===id).params;
 };
 const allowed=await execute("allowed","kubectl get pods -n allowed -o json");
 assert.equal(allowed.exitCode,0,JSON.stringify({allowed,paths,output:events.filter(e=>e.method==="process/output").map(e=>Buffer.from(e.params.chunk,"base64").toString()).join("")}));
 assert.ok(paths.some(p=>p.startsWith("/api/v1/namespaces/allowed/pods")));
 assert.ok(!fs.readFileSync(scopedPath,"utf8").includes(canary));
 const denied=await execute("other","kubectl get pods -n forbidden -o json");assert.ok(denied.error||denied.exitCode!==0);
 const all=await execute("all","kubectl get pods -A -o json");assert.ok(all.error||all.exitCode!==0);
 const write=await execute("write","kubectl delete pod channel-safe -n allowed");assert.ok(write.error||write.exitCode!==0);
 const readCredential=await execute("read-credential",`cat '${scopedPath}'`);assert.ok(readCredential.error||readCredential.exitCode!==0);
 assert.ok(!paths.some(p=>p.includes("forbidden")||/^\/api\/v1\/pods/.test(p)));
 const before=paths.length;active=false;
 const revoked=await execute("revoked","kubectl get pods -n allowed -o json");assert.ok(revoked.error||revoked.exitCode!==0);assert.equal(paths.length,before);
 const text=events.filter(e=>e.method==="process/output").map(e=>Buffer.from(e.params.chunk,"base64").toString()).join("");
 assert.match(text,/channel-safe/);assert.ok(!text.includes(canary));
 console.log("Channel native smoke passed: real upstream exec-server, scoped kubectl, no raw credential, cross-namespace/all-namespace/write/file-read denial and revocation; fixture API, not production cluster.");
}finally{
 socket?.close();await relay.close();broker.dispose();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
 // kubectl's cache belongs to sandbox UID 1001. Adjust only this freshly
 // created disposable fixture workspace so cleanup cannot hide an assertion.
 if(process.env.NODE_ENV==="production")spawnSync("sudo",["-n","-u","sandbox","--","chmod","-R","a+rwX","--",workspace]);
 fs.rmSync(root,{recursive:true,force:true});
}
