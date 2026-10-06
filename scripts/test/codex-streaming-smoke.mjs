// Source-built upstream exec-server owns output retention/lifecycle. The service
// emits only safe bytes; this probes streaming, native replay, budgets and Stop.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { CodexExecutorRelay } from '../../dist/core/brains/codex-executor-relay.js';
import { createNativeSkillScriptGrants } from '../../dist/core/brains/codex-skill-scripts.js';
import { createSkillScriptResolver } from '../../dist/tools/infra/script-resolver.js';
import { createModelOutputRedactor } from '../../dist/shared/model-output-redactor.js';
assert.ok(process.env.SICLAW_CODEX_BIN, 'Use the pinned official source-built binary');
const long = process.env.SICLAW_CODEX_LONG_SMOKE === '1';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-stream-smoke-')));
fs.chmodSync(root, 0o755);
const workspace = path.join(root, 'workspace'), base = path.join(root, 'skills'), skill = path.join(base, 'resolved', 'stream');
fs.mkdirSync(workspace, {mode:0o777}); fs.chmodSync(workspace,0o777);
fs.mkdirSync(path.join(skill, 'scripts'), {recursive:true});
fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: stream\ndescription: Reviewed streaming fixture\n---\nRun the selected scripts.\n');
const script = path.join(skill, 'scripts', 'stream.py'), alive = path.join(skill, 'scripts', 'alive.sh');
const secret = 'private-native-stream-fixture';
fs.writeFileSync(script, `import sys,time\nprint('EARLY_SAFE',flush=True)\nsys.stdout.write('unlabelled private-native-');sys.stdout.flush();time.sleep(.1)\nprint('stream-fixture',flush=True)\nsys.stderr.write('-----BEGIN PRIVATE KEY-----\\nhidden-pem\\n');sys.stderr.flush();time.sleep(.1)\nsys.stderr.write('hidden-pem-next\\n-----END PRIVATE KEY-----\\nSAFE_STDERR\\n');sys.stderr.flush()\nprint('{"data":{"unknown":"hidden-json"},',flush=True);time.sleep(.1);print('"kind":"Secret"}',flush=True)\nfor i in range(140000): print('SAFE_LOG_'+str(i)+'_'+'x'*70)\nprint('LARGE_LOG_END',flush=True)\n`);
fs.writeFileSync(alive, `#!/bin/bash\nprintf 'LIVE_SAFE\\n'\nsleep ${long ? 310 : 4} &\nprintf '%s %s\\n' "$$" "$!" > "$1"\nwait\nprintf 'NATIVE_END\\n'\n`);
const resolver = createSkillScriptResolver({skillsBaseDir:base,resolvedSkillsDir:path.join(base,'resolved'),builtinDirs:[]});
const scripts = createNativeSkillScriptGrants([{name:'stream',filePath:path.join(skill,'SKILL.md')}],resolver,
 {local:true,pod:false,node:false,host:false});
const source = () => [secret];
const relay = new CodexExecutorRelay({executable:process.env.SICLAW_CODEX_BIN,home:path.join(root,'executor'),cwd:workspace,
 grants:{readRoots:[workspace],writeRoots:[],deniedRoots:[],allowCommands:true,production:process.env.NODE_ENV==='production',
 skillScripts:scripts,environment:{PATH:process.env.PATH},sensitiveValues:source,redactOutput:createModelOutputRedactor(source)}});
const sockets=[];
const waitUntil = async (test, timeout=20000) => {const until=Date.now()+timeout;while(!test()){assert.ok(Date.now()<until,'timed out');await new Promise(r=>setTimeout(r,40));}};
function pidAlive(pid) {try {process.kill(pid,0);return !(process.platform==='linux'&&/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`,'utf8')));}catch{return false;}}
async function connect() {
 const socket = new WebSocket(relay.url,{headers:{Authorization:`Bearer ${relay.bearerToken}`}});sockets.push(socket);
 let next=0;const pending=new Map(), states=new Map();
 socket.on('message', raw => {const x=JSON.parse(raw.toString());if(x.id!==undefined){pending.get(x.id)?.(x);pending.delete(x.id);return;}
  const id=x.params?.processId;if(!id)return;const s=states.get(id)||{bytes:0,tail:'',seq:0,exited:false};states.set(id,s);
  if(x.method==='process/output') {assert.ok(x.params.seq>s.seq);s.seq=x.params.seq;
   const text=Buffer.from(x.params.chunk,'base64').toString();s.bytes+=Buffer.byteLength(text);s.tail=(s.tail+text).slice(-100000);
   for(const forbidden of [secret,'hidden-pem','hidden-json'])assert.ok(!s.tail.includes(forbidden),'raw sensitive output');
  } else if(x.method==='process/exited'){s.exited=true;s.exitCode=x.params.exitCode;}
  else if(x.method==='process/closed')s.closed=true;
 });
 await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>reject(Error(method+' timeout')),20000);
 pending.set(id,x=>{clearTimeout(timer);resolve(x);});socket.send(JSON.stringify({id,method,params}));});
 assert.ok((await rpc('initialize',{clientName:'native-stream-smoke'})).result);socket.send(JSON.stringify({method:'initialized',params:{}}));
 const start=(id,cmd)=>rpc('process/start',{processId:id,argv:['/bin/bash','-c',cmd],cwd:pathToFileURL(workspace).href,tty:false});
 return {rpc,start,states};
}
try {
 await relay.start();const a=await connect(),b=await connect();
 const pidfile=path.join(workspace,'alive.pid'), scriptStart=Date.now();
 assert.ok((await a.start('alive',`bash ${alive} ${pidfile}`)).result);
 await waitUntil(()=>a.states.get('alive')?.tail.includes('LIVE_SAFE'));
 assert.equal(a.states.get('alive').exited,false,'early output is visible while running');
 const ordinaryStart=Date.now();
 assert.ok((await a.start('ordinary',`sleep ${long ? 70 : 2}`)).result);
 assert.ok((await a.start('large',`python3 ${script}`)).result);
 await waitUntil(()=>a.states.get('large')?.closed,60000);
 const large=a.states.get('large');assert.equal(large.exitCode,0);assert.ok(large.bytes>8*1024*1024);assert.ok(large.tail.includes('LARGE_LOG_END'),'native stdout tail marker missing after stream close');
 // Replay is native and bounded; no adapter-created chunks or replacement output.
 const replay=await a.rpc('process/read',{processId:'large',afterSeq:0,maxBytes:1024*1024,waitMs:0});
 assert.ok(replay.result);assert.ok(replay.result.chunks.length);assert.ok(replay.result.nextSeq>1);
 assert.ok(!JSON.stringify(replay.result).includes('Output suppressed'));
 // A different connection cannot poll or stop another connection's handles.
 assert.ok((await b.rpc('process/read',{processId:'alive',afterSeq:0})).error);
 assert.ok((await b.rpc('process/terminate',{processId:'alive'})).error);
 if(long){
  await new Promise(r=>setTimeout(r,Math.max(0,ordinaryStart+65000-Date.now())));
  assert.equal((await a.rpc('process/read',{processId:'ordinary',afterSeq:0,waitMs:0})).result.exited,false,'ordinary execution survived 60 seconds');
  console.log('Native streaming smoke: ordinary command survived adapter 60s deadline');
  await waitUntil(()=>a.states.get('ordinary')?.exited,20000);assert.equal(a.states.get('ordinary').exitCode,0);
  await new Promise(r=>setTimeout(r,Math.max(0,scriptStart+305000-Date.now())));
  assert.equal((await a.rpc('process/read',{processId:'alive',afterSeq:0,waitMs:0})).result.exited,false,'reviewed script survived 300 seconds');
  console.log('Native streaming smoke: script survived adapter 180s/300s deadlines');
 }
 // Stop is tested on a separate long process after lifetime assertions.
 assert.ok((await a.start('stop',`bash ${alive} ${path.join(workspace,'stop.pid')}`)).result);
 await waitUntil(()=>fs.existsSync(path.join(workspace,'stop.pid')));
 const pids=fs.readFileSync(path.join(workspace,'stop.pid'),'utf8').trim().split(/\s+/).map(Number);
 assert.ok((await a.rpc('process/terminate',{processId:'stop'})).result);
 await waitUntil(()=>a.states.get('stop')?.exited);
 await waitUntil(()=>pids.every(pid=>!pidAlive(pid)),10000);
 await waitUntil(()=>a.states.get('alive')?.exited,long?20000:10000);
 assert.equal(a.states.get('alive').exitCode,0);
 console.log('Native streaming smoke passed: early output, split credentials/PEM/JSON, >8MiB safe logs, native replay/seq, connection isolation and process-tree Stop'+(long?', actual >60s command and >300s script':''));
} finally {for(const socket of sockets)socket.close();await relay.close();fs.rmSync(root,{recursive:true,force:true});}
