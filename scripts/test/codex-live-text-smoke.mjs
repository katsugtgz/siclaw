// Real pinned app-server; hold response completion until a text delta reaches
// the Siclaw brain. A final-only adapter cannot pass by replaying a whole reply.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CodexAgentBrain } from '../../dist/core/brains/codex-agent-brain.js';

assert.ok(process.env.SICLAW_CODEX_BIN);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-live-text-'));
let brain, failure, calls = 0, completed = false, firstDelta;
let release, ready;
const released = new Promise(resolve => { release = resolve; });
const deltaReady = new Promise(resolve => { ready = resolve; });
const model = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const item = { id: 'live-message', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'LIVE_PREFIX\nLIVE_FINAL', annotations: [] }] };
    const response = { id: 'live-response', object: 'response', created_at: 1, model: body.model,
      status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } };
    send('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    send('response.content_part.added', { output_index: 0, content_index: 0, item_id: item.id,
      part: { type: 'output_text', text: '', annotations: [] } });
    send('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: 'LIVE_PREFIX\n' });
    await released;
    send('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: 'LIVE_FINAL' });
    send('response.output_text.done', { output_index: 0, content_index: 0, item_id: item.id, text: item.content[0].text });
    send('response.output_item.done', { output_index: 0, item });
    completed = true; send('response.completed', { response }); res.end();
  } catch (error) { failure = error; res.destroy(); }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
let timer;
try {
  brain = await CodexAgentBrain.create({ sessionManager: SessionManager.create(root), cwd: root,
    systemPrompt: 'Stream public text normally.', skillPaths: [], toolsetsByName: new Map(),
    grants: { executionRoots: [root], readRoots: [], writeRoots: [], deniedRoots: [], allowCommands: false,
      production: false, environment: { PATH: process.env.PATH } } });
  brain.registerProvider('fixture', { api: 'openai-responses', apiKey: 'live-stream-fixture',
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
    models: [{ id: 'gpt-5.5', contextWindow: 128000, maxTokens: 1000 }] });
  await brain.setModel(brain.findModel('fixture', 'gpt-5.5'));
  brain.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      firstDelta ??= { delta: event.assistantMessageEvent.delta, beforeCompletion: !completed };
      ready();
    }
  });
  const running = brain.prompt('Return the fixture reply.');
  await Promise.race([deltaReady, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('No public text delta before native response completion')), 12000);
  })]);
  clearTimeout(timer);
  assert.equal(firstDelta.beforeCompletion, true);
  assert.match(firstDelta.delta, /LIVE_PREFIX/);
  release(); await running;
  if (failure) throw failure;
  assert.equal(calls, 1);
  console.log('Native live text smoke passed: first delta before completion, one real pinned response');
} finally {
  clearTimeout(timer); release(); await brain?.close();
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
