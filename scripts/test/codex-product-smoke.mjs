// Pinned source-built app-server; real native tools/MCP, fixture Responses/Runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CodexAgentBrain } from '../../dist/core/brains/codex-agent-brain.js';
assert.ok(process.env.SICLAW_CODEX_BIN, 'Use the official source-built Codex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-product-smoke-')); fs.chmodSync(root, 0o755);
const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
const events = [], questions = [], requests = [], tasks = new Map();
const secret = 'owner-product-secret', rotated = 'owner-rotated-secret', headerSecret = 'owner-header-secret';
let phase = 'product', step = 0, calls = 0, failure, brain;
const fn = (name, args, id, namespace) => ({ id, type: 'function_call', ...(namespace ? { namespace } : {}), name, call_id: id, arguments: JSON.stringify(args), status: 'completed' });
const answer = text => ({ id: `answer-${calls}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const output = (body, id) => {
  const value = body.input.find(x => x.type === 'function_call_output' && x.call_id === id)?.output ?? '';
  return typeof value === 'string' ? value : Array.isArray(value) ? value.map(x => x.text ?? '').join('\n') : JSON.stringify(value);
};
const runtime = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const body = raw ? JSON.parse(raw) : {}, url = new URL(req.url, 'http://fixture');
  requests.push({ method: req.method, path: url.pathname, body });
  assert.equal(body.session_id ?? url.searchParams.get('session_id'), 'trusted-public-session');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET') res.end(JSON.stringify({ tasks: [...tasks.values()] }));
  else if (req.method === 'POST') { const task = { ...body, id: 'owned-task' }; tasks.set(task.id, task); res.end(JSON.stringify(task)); }
  else if (req.method === 'PUT') { Object.assign(tasks.get('owned-task'), body); res.end(JSON.stringify(tasks.get('owned-task'))); }
  else { tasks.delete('owned-task'); res.end('{}'); }
});
const handleModel = async (req, res) => { try {
  let data = ''; for await (const part of req) data += part;
  const body = JSON.parse(data); calls++;
  assert.ok(![secret, rotated, headerSecret].some(value => data.includes(value)), 'credential reached a model body');
  const alternate = ['url', 'header', 'anonymous'].includes(phase);
  assert.equal(req.headers.host, `127.0.0.1:${(alternate ? alternateModel : model).address().port}`, 'stale provider URL');
  assert.equal(req.headers.authorization, ['header', 'anonymous'].includes(phase) ? undefined : `Bearer ${phase === 'product' ? secret : rotated}`);
  assert.equal(req.headers['x-fixture-token'], phase === 'header' ? headerSecret : undefined, 'stale provider headers');
  let item;
  if (phase === 'fail') { res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: `Unauthorized token ${rotated}` } })); return; }
  if (['rotate', 'recover', 'switch', 'url', 'header', 'anonymous'].includes(phase)) {
    assert.equal(body.model, phase === 'switch' ? 'gpt-5.4' : 'gpt-5.5'); item = answer(`NATIVE_${phase.toUpperCase()}_ACCEPTED`);
  } else {
    const user = body.input.filter(x=>x.type==='message'&&x.role==='user').at(-1)?.content??[];
    if(process.env.SICLAW_PRODUCT_TRACE==='1')console.log('USER_TRACE',user.map(x=>(x.text??'').slice(0,200)));
    const memory=user.some(x=>x.text?.startsWith('## Memory Writing Agent:')||x.text?.startsWith('## Global Memory Consolidation Agent:'));
    if(memory) item=answer('Memory fixture has no facts to store.');
    else { step++;
    if(process.env.SICLAW_PRODUCT_TRACE==='1' && step<=3) console.log('TOOL_TRACE', step, (body.tools??[]).map(x=>({type:x.type,name:x.name,tools:x.tools?.map(t=>t.name)})), step===3?output(body,'attachment-read'):step===2?output(body,'exec-search'):'');
    if (step === 1) item = { id: "exec-search", type: "tool_search_call", call_id: "exec-search", execution: "client", arguments: { query: "exec_command", limit: 5 }, status: "completed" };
    else if (step === 2) {
      const text = JSON.stringify(body.input);
      assert.match(text, /Codex's native child tools/); assert.ok(!text.includes('ONE spawn_subagent'));
      const filename = text.match(/\/[^\s"\\]+\.attachments[^\s"\\]+\.log/)[0];
      item = fn('exec_command', { cmd: `cat ${filename}`, login: false }, 'attachment-read');
    } else if (step === 3) {
      assert.match(output(body, 'attachment-read'), /healthy/); assert.ok(!output(body, 'attachment-read').includes(secret));
      item = fn('request_user_input', { questions: [{ id: 'target', header: 'Target', question: 'Which namespace should be checked?', options: [{ label: 'sicore-test', description: 'Test namespace' }, { label: 'default', description: 'Default namespace' }] }] }, 'question');
    } else if (step === 4) {
      assert.match(output(body, 'question'), /sicore-test/);
      item = { id: 'search', type: 'tool_search_call', call_id: 'search', execution: 'client', arguments: { query: 'manage_schedule task_report', limit: 5 }, status: 'completed' };
    } else if (step === 5) item = fn('manage_schedule', { action: 'create', name: 'Native fixture', schedule: '0 9 * * *', status: 'paused', description: 'Read pods in sicore-test on the test cluster' }, 'create', 'mcp__siclaw_workflow');
    else if (step === 6) { assert.match(output(body, 'create'), /Created/); item = fn('manage_schedule', { action: 'list' }, 'list', 'mcp__siclaw_workflow'); }
    else if (step === 7) { assert.match(output(body, 'list'), /Native fixture/); item = fn('manage_schedule', { action: 'update', id: 'owned-task', schedule: '0 10 * * *' }, 'update', 'mcp__siclaw_workflow'); }
    else if (step === 8) item = fn('manage_schedule', { action: 'resume', id: 'owned-task' }, 'resume', 'mcp__siclaw_workflow');
    else if (step === 9) item = fn('manage_schedule', { action: 'pause', id: 'owned-task' }, 'pause', 'mcp__siclaw_workflow');
    else if (step === 10) item = fn('manage_schedule', { action: 'rename', id: 'owned-task', newName: 'Renamed native fixture' }, 'rename', 'mcp__siclaw_workflow');
    else if (step === 11) item = fn('manage_schedule', { action: 'delete', id: 'owned-task' }, 'delete', 'mcp__siclaw_workflow');
    else if (step === 12) item = fn('task_report', { summary: '# Findings\nThe native attachment and namespace checks passed.' }, 'report', 'mcp__siclaw_workflow');
    else { assert.match(output(body, 'report'), /Findings/); item = answer('NATIVE_PRODUCT_ACCEPTED'); }
    }
  }
  const envelope = { id: `response-${calls}`, object: 'response', created_at: 1, status: 'completed', model: body.model,
    output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send('response.created', { response: { ...envelope, output: [], status: 'in_progress' } });
  send('response.output_item.added', { output_index: 0, item: { ...item, ...(item.type === 'function_call' ? { arguments: '' } : item.type === 'message' ? { content: [] } : {}), status: 'in_progress' } });
  if (item.type === 'function_call') send('response.function_call_arguments.delta', { output_index: 0, delta: item.arguments });
  else if (item.type === 'message') send('response.output_text.delta', { output_index: 0, content_index: 0, delta: item.content[0].text });
  send('response.output_item.done', { output_index: 0, item }); send('response.completed', { response: envelope }); res.end();
} catch (error) { failure ??= error; res.writeHead(500).end('{"error":{"message":"product fixture failed"}}'); } };
const model = createServer(handleModel), alternateModel = createServer(handleModel);
await Promise.all([runtime, model, alternateModel].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
process.env.SICLAW_GATEWAY_URL = `http://127.0.0.1:${runtime.address().port}`;
const state = { active: false }, transcripts = path.join(root, 'transcripts');
const provider = (key, server = model) => ({ api: 'openai-responses', apiKey: key, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  models: ['gpt-5.5', 'gpt-5.4'].map(id => ({ id, api: 'openai-responses', contextWindow: 128000, maxTokens: 1000 })) });
const make = async manager => {
  const result = await CodexAgentBrain.create({ sessionManager: manager, cwd: workspace, systemPrompt: 'Use native tools. Produce the requested final report.', skillPaths: [], toolsetsByName: new Map(),
    grants: { executionRoots: [workspace], readRoots: [], writeRoots: [], deniedRoots: [], allowCommands: false, production: process.env.NODE_ENV === 'production', environment: { PATH: process.env.PATH } }, dpStateRef: state,
    workflow: { schedule: true, report: true, sessionId: () => 'trusted-public-session' }, userQuestions: { emit: event => { questions.push(event); void result.steer('A'); } } });
  result.subscribe(event => events.push(event)); return result;
};
try {
  brain = await make(SessionManager.create(workspace, transcripts)); brain.registerProvider('fixture', provider(secret)); await brain.setModel(brain.findModel('fixture', 'gpt-5.5'));
  if(process.env.SICLAW_PRODUCT_TRACE==='1'){console.log('SHELL_TRACE',brain.codexConfig().features.shell_tool,brain.native.grants.inputRoots);const origConnect=brain.executor.connect.bind(brain.executor);brain.executor.connect=(s)=>{console.log('CONNECT_TRACE');origConnect(s);};const policy=brain.executor;const start=policy.backendMessage.bind(policy);policy.backendMessage=(c,m)=>{if(m.id!==undefined)console.log('RPC_TRACE',c.pending.get(m.id)?.method,m.error?.message);return start(c,m);};}
  await brain.ensureClient();
  if(process.env.SICLAW_PRODUCT_TRACE==='1')console.log('ENV_TRACE',JSON.stringify(await brain.client.request('environment/status',{environmentId:'siclaw'})));
  await brain.prompt('[Deep Investigation]\nCheck the attached log and submit a final report.', { files: [{ filename: 'pod.log', mimeType: 'text/plain', data: Buffer.from(`password: ${secret}\nstatus: healthy\n`).toString('base64') }] }, { requiredResultToolName: 'task_report' });
  if (failure) throw failure;
  assert.equal(state.active, true); assert.equal(questions.length, 1); assert.equal(tasks.size, 0);
  assert.ok(events.some(event => event.type === 'tool_execution_end' && event.toolName === 'task_report' && !event.isError));
  assert.equal(requests.length, 12); assert.ok(!JSON.stringify({ events, questions, requests }).includes(secret));
  phase = 'rotate'; brain.registerProvider('fixture', provider(rotated)); await brain.prompt('[DP_EXIT]\nVerify the new credential'); assert.equal(state.active, false);
  phase = 'switch'; await brain.setModel(brain.findModel('fixture', 'gpt-5.4')); await brain.prompt('Verify model switching');
  phase = 'fail'; await brain.setModel(brain.findModel('fixture', 'gpt-5.5')); await assert.rejects(brain.prompt('Verify authentication failure'), error => !error.message.includes(rotated) && /Unauthorized|401|unauthorized/i.test(error.message));
  phase = 'recover'; await brain.prompt('Verify recovery after failure');
  phase = 'url'; brain.registerProvider('fixture', provider(rotated, alternateModel)); await brain.prompt('Verify provider URL rebinding');
  phase = 'header'; brain.registerProvider('fixture', { ...provider('', alternateModel), authHeader: false, headers: { 'X-Fixture-Token': headerSecret } }); await brain.prompt('Verify explicit header-only authentication');
  phase = 'anonymous'; brain.registerProvider('fixture', { ...provider('', alternateModel), authHeader: false, headers: {} }); await brain.prompt('Verify removal of all authentication headers');
  const messages = JSON.stringify(brain.getConversationMessages()); assert.ok(![secret, rotated, headerSecret].some(value => messages.includes(value)));
  await brain.close(); brain = await make(SessionManager.continueRecent(workspace, transcripts)); brain.registerProvider('fixture', provider(rotated)); await brain.setModel(brain.findModel('fixture', 'gpt-5.5'));
  phase = 'recover';
  await brain.prompt('Verify cold resume after provider recovery'); assert.equal(state.active, false); if (failure) throw failure;
  console.log('Native product smoke passed: sanitized file reads, native question/answer, all schedule actions with trusted owner, task report, DP mode, credential rotation, model/URL/header-only/no-auth changes, safe 401, failure recovery and cold resume');
} catch (error) { throw failure ?? error; } finally { await brain?.close(); await Promise.all([runtime, model, alternateModel].map(server => new Promise(resolve => server.close(resolve)))); fs.rmSync(root, { recursive: true, force: true }); }
