// Pinned source exec-server, actual local/SSH script processes and an argv-only
// kubectl fixture. Namespace/physical-node deployment evidence is separate.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";
import { WebSocket } from "ws";
import { CodexExecutorRelay } from "../../dist/core/brains/codex-executor-relay.js";
import { createNativeSkillScriptGrants } from "../../dist/core/brains/codex-skill-scripts.js";
import { createSkillScriptResolver } from "../../dist/tools/infra/script-resolver.js";
import { CredentialBroker } from "../../dist/agentbox/credential-broker.js";
assert.ok(process.env.SICLAW_CODEX_BIN, "Use the pinned official source-built Codex binary");
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"native-skill-smoke-")));
fs.chmodSync(root,0o755);
const workspace=path.join(root,"workspace"),base=path.join(root,"skills"),skill=path.join(base,"resolved","diagnose"),bin=path.join(root,"bin");
for(const d of [workspace,path.join(skill,"scripts"),bin])fs.mkdirSync(d,{recursive:true});
fs.chmodSync(workspace,0o777);
fs.writeFileSync(path.join(skill,"SKILL.md"),"---\nname: diagnose\ndescription: Read-only native acceptance fixture\n---\nUse read.sh or read.py.\n");
const shell=path.join(skill,"scripts","read.sh"),python=path.join(skill,"scripts","read.py"),long=path.join(skill,"scripts","long.sh");
fs.writeFileSync(shell,"#!/bin/bash\nprintf 'SKILL_SHELL_OK:%s\\n' \"$1\"\nprintf 'password: source-script-secret\\n'\n");
fs.writeFileSync(python,"import sys\nprint('SKILL_PYTHON_OK:'+sys.argv[1])\nprint('password: source-python-secret')\n");
fs.writeFileSync(long,"#!/bin/bash\nsleep 60 &\nprintf '%s %s\\n' \"$$\" \"$!\" > \"$1\"\nwait\n");
const originalPath=process.env.PATH;
fs.writeFileSync(path.join(bin,"kubectl"),"#!/bin/bash\nfor arg in \"$@\"; do if [ \"$arg\" = get ]; then echo pod/fixture; exit 0; fi; done\nwhile [ \"$#\" -gt 0 ] && [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n",{mode:0o755});
process.env.PATH=bin+path.delimiter+originalPath;
const resolver=createSkillScriptResolver({skillsBaseDir:base,resolvedSkillsDir:path.join(base,"resolved"),builtinDirs:[]});
const scripts=createNativeSkillScriptGrants([{name:"diagnose",filePath:path.join(skill,"SKILL.md")}],resolver,
  {local:true,pod:true,node:true,host:true});
let bound=true,executions=0;
const key=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs1",format:"pem"});
const server=new ssh2.Server({hostKeys:[key]},client=>{
  client.on("authentication",ctx=>ctx.method==="password"&&ctx.username==="reader"&&ctx.password==="script-fixture"?ctx.accept():ctx.reject());
  client.on("ready",()=>client.on("session",accept=>accept().on("exec",(accept,_reject,info)=>{
    assert.match(info.command,/^(?:setsid sh -c|sid=)/);
    const channel=accept();executions++;
    const child=spawn("/bin/sh",["-c",info.command],{env:{PATH:originalPath},stdio:["pipe","pipe","pipe"]});
    channel.pipe(child.stdin);child.stdin.on("error",()=>{});
    child.stdout.on("data",bytes=>channel.write(bytes));child.stderr.on("data",bytes=>channel.stderr.write(bytes));
    child.once("close",code=>{channel.exit(code??1);channel.end();});
  })));
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const meta={name:"fixture",ip:"127.0.0.1",port:server.address().port,username:"reader",auth_type:"password",is_production:false};
const broker=new CredentialBroker({listClusters:async()=>[{name:"cluster"}],listHosts:async()=>bound?[meta]:[],
 queryHosts:async()=>({hosts:[],total:0,next_cursor:null}),
 getHostCredential:async()=>({credential:{name:"fixture",type:"ssh",metadata:meta,files:[{name:"host.password",content:"script-fixture"}]}}),
 getClusterCredential:async()=>({credential:{name:"cluster",type:"kubeconfig",metadata:{name:"cluster"},files:[{name:"cluster.kubeconfig",content:"fixture"}]}}),
},path.join(root,"credentials"));
const grants={readRoots:[],writeRoots:[],deniedRoots:[],executionRoots:[workspace],allowCommands:false,allowFileCommands:false,
 production:process.env.NODE_ENV === "production",skillScripts:scripts,environment:{PATH:process.env.PATH}};
const relays=[new CodexExecutorRelay({executable:process.env.SICLAW_CODEX_BIN,home:path.join(root,"executor"),cwd:workspace,
 grants:{...grants,infrastructure:{kind:"ssh",broker,allowCommands:false}}}),
 new CodexExecutorRelay({executable:process.env.SICLAW_CODEX_BIN,home:path.join(root,"cluster-executor"),cwd:workspace,
 grants:{...grants,infrastructure:{kind:"cluster",name:"cluster",broker,userId:"fixture",allowApi:false,allowPod:false,allowNode:false}}})];
const sockets=[];
const linux = process.platform === "linux";
async function connect(relay){
 await relay.start();const socket=new WebSocket(relay.url,{headers:{Authorization:`Bearer ${relay.bearerToken}`}});sockets.push(socket);
 const pending=new Map(),events=[];let next=0;
 socket.on("message",raw=>{const x=JSON.parse(raw.toString());if(x.id!==undefined){pending.get(x.id)?.(x);pending.delete(x.id);}else events.push(x);});
 await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>reject(Error(method+" timeout")),15000);
 pending.set(id,x=>{clearTimeout(timer);resolve(x);});socket.send(JSON.stringify({id,method,params}));});
 assert.ok((await rpc("initialize",{clientName:"native-skill-smoke"})).result);socket.send(JSON.stringify({method:"initialized",params:{}}));
 const start=(id,cmd)=>rpc("process/start",{processId:id,argv:["/bin/bash","-c",cmd],cwd:pathToFileURL(workspace).href,tty:false});
 const finish=async id=>{const deadline=Date.now()+20000;while(!events.some(x=>x.method==="process/exited"&&x.params.processId===id)){
  if(Date.now()>=deadline){const status=await rpc("process/read",{processId:id,afterSeq:0});throw Error("script completion "+id+" "+JSON.stringify(status));}
  await new Promise(r=>setTimeout(r,40));}
  return {exitCode:events.find(x=>x.method==="process/exited"&&x.params.processId===id).params.exitCode,
   text:events.filter(x=>x.method==="process/output"&&x.params.processId===id).map(x=>Buffer.from(x.params.chunk,"base64").toString()).join("")};};
 return {rpc,start,finish};
}
try {
 const local=await connect(relays[0]),cluster=await connect(relays[1]);
 for(const [id,client,cmd,marker] of [
  ["local-sh",local,`bash ${shell} local`,"SKILL_SHELL_OK:local"],
  ["local-py",local,`python3 ${python} local`,"SKILL_PYTHON_OK:local"],
  ["ssh-sh",local,`ssh fixture -- bash ${shell} ssh`,"SKILL_SHELL_OK:ssh"],
  ["ssh-py",local,`ssh fixture -- python3 ${python} ssh`,"SKILL_PYTHON_OK:ssh"],
  ["pod-sh",cluster,`kubectl -n test exec pod-a -c main -- bash ${shell} pod`,"SKILL_SHELL_OK:pod"],
  ["pod-py",cluster,`kubectl -n test exec pod-a -- python3 ${python} pod`,"SKILL_PYTHON_OK:pod"],
 ].filter(([id]) => linux || id.startsWith("local-"))) {assert.ok((await client.start(id,cmd)).result);const output=await client.finish(id);assert.equal(output.exitCode,0,id+" "+output.text);assert.match(output.text,new RegExp(marker));assert.ok(!output.text.includes("source-script-secret")&&!output.text.includes("source-python-secret"));}
 for(const [id,cmd] of [["inline","bash -c 'touch /tmp/NO'"],["temp","bash /tmp/unreviewed.sh"],["chain",`bash ${shell}; touch /tmp/NO`],
  ["plain-ssh","ssh fixture -- uname"],["options",`ssh -i /tmp/key fixture -- bash ${shell}`]])assert.ok((await local.start(id,cmd)).error);
 for(const remote of linux ? [false,true] : [false]) {
  const id=remote?"stop-ssh":"stop-local",pid=path.join(workspace,id+".pid");
  assert.ok((await local.start(id,`${remote?"ssh fixture -- ":""}bash ${long} ${pid}`)).result);
  const deadline=Date.now()+10000;while(!fs.existsSync(pid)){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,40));}
  assert.ok((await local.rpc("process/terminate",{processId:id})).result);await local.finish(id);
  const pids=fs.readFileSync(pid,"utf8").trim().split(/\s+/).map(Number);
  const until=Date.now()+7000;
  while(pids.some(pid=>{try{process.kill(pid,0);return true;}catch{return false;}})&&Date.now()<until)await new Promise(r=>setTimeout(r,80));
  assert.ok(pids.every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),"stopped script descendants remain");
 }
 bound=false;assert.ok((await local.start("revoked",`ssh fixture -- python3 ${python} revoked`)).result);
 assert.notEqual((await local.finish("revoked")).exitCode,0);
 fs.appendFileSync(shell,"echo changed\n");assert.ok((await local.start("changed",`bash ${shell}`)).error);
 console.log(linux ? "Native Skill script smoke passed: source exec-server, local/SSH shell+Python, Pod argv/stdin fixture, script-only grants, immutable assets, sanitized output, revoke and process-tree Stop"
  : "Native Skill script smoke passed: source exec-server, local shell+Python, script-only grants, immutable assets, sanitized output and local process-tree Stop; Linux remote execution is a separate gate");
} finally {
 for(const socket of sockets)socket.close();for(const relay of relays)await relay.close();broker.dispose();
 await new Promise(resolve=>server.close(resolve));process.env.PATH=originalPath;fs.rmSync(root,{recursive:true,force:true});
}
