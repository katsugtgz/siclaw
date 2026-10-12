// Pinned real app-server + deterministic Responses fixture. No infrastructure IO.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CodexAgentBrain } from '../../dist/core/brains/codex-agent-brain.js';

assert.ok(process.env.SICLAW_CODEX_BIN);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-question-smoke-'));
let brain, failure, request, sawAnswer = false, calls = 0;
let releaseQuestion;
const questionReady = new Promise(resolve => { releaseQuestion = resolve; });
const model = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls++;
    const answer = body.input.find(x => x.type === 'function_call_output' && x.call_id === 'question-call');
    let item;
    if (!answer) item = { type: 'function_call', id: 'question-call', call_id: 'question-call', name: 'request_user_input',
      arguments: JSON.stringify({ questions: [{ id: 'format', header: 'Format', question: 'Which output format?',
        options: [{ label: 'Summary', description: 'One sentence' }, { label: 'Detailed', description: 'Two sentences' }] }] }) };
    else {
      assert.match(JSON.stringify(answer), /Detailed/); sawAnswer = true;
      item = { id: 'answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'NATIVE_STRUCTURED_QUESTION_PASS', annotations: [] }] };
    }
    const response = { id: 'question-response', object: 'response', created_at: 1, status: 'completed', model: body.model,
      output: [item], usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35, input_tokens_details: { cached_tokens: 0 } } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    send('response.created', { response: { ...response, output: [], status: 'in_progress' } });
    send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress' } });
    if (item.type === 'message') send('response.output_text.delta', { output_index: 0, content_index: 0, delta: item.content[0].text });
    send('response.output_item.done', { output_index: 0, item }); send('response.completed', { response }); res.end();
  } catch (error) { failure = error; res.writeHead(500).end('{"error":{"message":"question fixture failed"}}'); }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
let timer;
try {
  brain = await CodexAgentBrain.create({ sessionManager: SessionManager.create(root), cwd: root, systemPrompt: 'Ask the native question and wait.', skillPaths: [], toolsetsByName: new Map(),
    userQuestions: { emit: event => { if (event.type === 'input_required') { request = event.nativeUserInput; releaseQuestion(); } } },
    grants: { executionRoots: [root], readRoots: [], writeRoots: [], deniedRoots: [], allowCommands: false,
      production: process.env.NODE_ENV === 'production', environment: { PATH: process.env.PATH } } });
  brain.registerProvider('fixture', { api: 'openai-responses', apiKey: 'question-fixture-key', baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
    models: [{ id: 'gpt-5.5', contextWindow: 128000, maxTokens: 1000 }] });
  await brain.setModel(brain.findModel('fixture', 'gpt-5.5'));
  const running = brain.prompt('Ask which output format to use.');
  await Promise.race([questionReady, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Native question did not arrive')), 20000); })]);
  clearTimeout(timer);
  assert.equal(request.engine, 'codex'); assert.equal(request.questions[0].options[1].description, 'Two sentences');
  assert.equal(brain.getPendingUserInput().requestId, request.requestId);
  assert.throws(() => brain.prepareUserInput({ requestId: 'old', answers: { format: 'Detailed' } }), /USER_INPUT_EXPIRED/);
  const reply = { requestId: request.requestId, answers: { format: 'Detailed' } };
  assert.equal(brain.prepareUserInput(reply).text, 'Detailed');
  assert.ok(brain.getPendingUserInput(), 'Preparation released the native wait before persistence');
  assert.equal(calls, 1);
  brain.submitUserInput(reply);
  await running;
  if (failure) throw failure;
  assert.ok(sawAnswer); assert.equal(brain.getPendingUserInput(), undefined);
  assert.throws(() => brain.submitUserInput(reply), /USER_INPUT_EXPIRED/);
  console.log('Native structured question smoke passed: real request, prepare/wait, exact-ID reply, model continuation, expired reply denied');
} finally { clearTimeout(timer); await brain?.close(); await new Promise(resolve => model.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
