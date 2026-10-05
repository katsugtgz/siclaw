// Real exec-server protocol/security test; the trusted kubectl fixture keeps a
// process tree alive so cancellation must cross the AgentBox/sandbox UID boundary.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { CodexExecutorRelay } from "../../dist/core/brains/codex-executor-relay.js";

const root = mkdtempSync(join(tmpdir(),"siclaw-executor-smoke-"));
chmodSync(root,0o755);
const workspace = join(root,"workspace");
mkdirSync(workspace); chmodSync(workspace,0o777);
const bin = join(root,"bin"); mkdirSync(bin);
const pidFile = join(workspace,"pids");
const credential = join(root,"credential"); writeFileSync(credential,"trusted-broker-path");
const quote = (value) => `'${value.replace(/'/g,"'\\''")}'`;
writeFileSync(join(bin,"kubectl"),`#!/bin/bash
printf '%s %s\\n' "$$" "$(id -u)" > ${quote(pidFile)}
sleep 30 &
printf '%s child\\n' "$!" >> ${quote(pidFile)}
printf '%s\\n' '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"native"},"data":{"password":"native-executor-secret"}}'
wait
`,{mode:0o755});
let refreshes = 0;
const production = process.env.NODE_ENV === "production";
const relay = new CodexExecutorRelay({executable:process.env.SICLAW_CODEX_BIN || "codex",
  home:join(root,"private"),cwd:workspace,
  grants:{readRoots:[workspace],writeRoots:[workspace],deniedRoots:[],allowCommands:true,production,
    environment:{PATH:`${bin}:${process.env.PATH}`},resolveKubeconfig:async () => {
      if (++refreshes > 1) throw new Error("revoked");
      return credential;
    }}});
const clients = [];
const waitUntil = async (predicate,label) => {
  const deadline = Date.now()+8000;
  while (!predicate()) {
    if (Date.now()>deadline) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve,50));
  }
};
async function connect() {
  const socket = new WebSocket(relay.url,{headers:{Authorization:`Bearer ${relay.bearerToken}`}});
  const pending = new Map(); const notifications=[]; let id=0;
  socket.on("message",(raw) => {
    const message=JSON.parse(raw.toString());
    if (message.id !== undefined) { const handler=pending.get(message.id); pending.delete(message.id); handler?.(message); }
    else notifications.push(message);
  });
  await new Promise((resolve,reject) => {socket.once("open",resolve);socket.once("error",reject);});
  const rpc = (method,params) => new Promise((resolve,reject) => {
    const requestId=++id;
    const timer=setTimeout(() => reject(new Error(`executor ${method} timed out`)),10000);
    pending.set(requestId,(result) => {clearTimeout(timer);resolve(result);});
    socket.send(JSON.stringify({id:requestId,method,params}));
  });
  assert.ok((await rpc("initialize",{clientName:"siclaw-native-smoke"})).result);
  socket.send(JSON.stringify({method:"initialized",params:{}}));
  const client={socket,rpc,notifications};clients.push(client);return client;
}
let pids=[];
try {
  if (production) assert.equal(process.getuid(),1000,"run as agentbox using the normal entrypoint");
  await relay.start();
  const first=await connect();
  const second=await connect();
  const params={processId:"long-running",argv:["/bin/bash","-c","kubectl get secret native -o json"],
    cwd:pathToFileURL(workspace).href,env:{KUBECONFIG:"/attacker",OPENAI_API_KEY:"must-not-propagate"},tty:false,pipeStdin:true};
  assert.ok((await first.rpc("process/start",params)).result);
  await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile,"utf8").split("\n").filter(Boolean).length===2,"process tree");
  const records=readFileSync(pidFile,"utf8").trim().split("\n").map((line)=>line.split(" "));
  pids=records.map(([pid])=>Number(pid));
  assert.equal(Number(records[0][1]),production?1001:process.getuid());
  assert.ok((await second.rpc("process/terminate",{processId:"long-running"})).error,"cross-session handle must be denied");
  assert.ok((await first.rpc("process/write",{processId:"long-running",chunk:"dG91Y2ggcHduCg=="})).error);
  assert.equal(first.notifications.filter((event)=>event.method==="process/output").length,0,"raw partial output must be withheld");
  assert.ok((await first.rpc("process/terminate",{processId:"long-running"})).result);
  await waitUntil(() => pids.every((pid)=> {
    const state=spawnSync("ps",["-o","stat=","-p",String(pid)],{encoding:"utf8"}).stdout.trim();
    return !state || state.startsWith("Z");
  }),"sandbox session reaping");
  await waitUntil(() => first.notifications.some((event)=>event.method==="process/exited"),"sanitized exit");
  const output=first.notifications.filter((event)=>event.method==="process/output")
    .map((event)=>Buffer.from(event.params.chunk,"base64").toString()).join("");
  assert.ok(!output.includes("native-executor-secret"));
  assert.match(output,/native/);
  assert.ok((await first.rpc("process/start",{...params,processId:"revoked"})).error,"broker failure must reject launch");
  assert.equal(refreshes,2);
  assert.ok((await first.rpc("process/read",{processId:"revoked"})).error);
  console.log(`Native executor smoke passed: UID ${records[0][1]}, process tree cancellation, session isolation, stdin denial, complete-document redaction, broker failure`);
} finally {
  for (const client of clients) client.socket.close();
  await relay.close();
  rmSync(root,{recursive:true,force:true});
}
