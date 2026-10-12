// Actual pinned app-server; deterministic Responses fixture, not a visual-quality test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CodexAgentBrain } from '../../dist/core/brains/codex-agent-brain.js';
import { createModelRouteState, resolveEffectivePolicy, runPromptWithModelRouting } from '../../dist/core/model-routing.js';

assert.ok(process.env.SICLAW_CODEX_BIN);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-image-smoke-'));
const events = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWMQSXtBEmIY1ZA2GkoiwzVpAABew2IQHOne+QAAAABJRU5ErkJggg==';
let sawImage = false, failure, brain;
const model = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (process.env.SICLAW_IMAGE_TRACE === '1') console.log(JSON.stringify({ keys: Object.keys(body), containsImage: raw.includes(png),
      input: body.input?.map(item => ({ type: item.type, role: item.role, content: Array.isArray(item.content) ? item.content.map(part => ({type:part.type,keys:Object.keys(part), text:part.text?.replaceAll(png,'[IMAGE OMITTED]').slice(0,200)})) : typeof item.content })) }));
    const image = body.input.flatMap(item => item.content ?? []).find(item => item.type === 'input_image');
    if (image) {
      assert.equal(image.image_url, `data:image/png;base64,${png}`);
      sawImage = true;
    }
    const item = { id: 'answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'NATIVE_IMAGE_INPUT_RECEIVED', annotations: [] }] };
    const response = { id: 'image-response', object: 'response', created_at: 1, status: 'completed', model: body.model,
      output: [item], usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35, input_tokens_details: { cached_tokens: 0 } } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    send('response.created', { response: { ...response, output: [], status: 'in_progress' } });
    send('response.output_item.added', { output_index: 0, item: { ...item, content: [], status: 'in_progress' } });
    send('response.output_text.delta', { output_index: 0, content_index: 0, delta: item.content[0].text });
    send('response.output_item.done', { output_index: 0, item });
    send('response.completed', { response }); res.end();
  } catch (error) { failure = error; res.writeHead(500).end('{"error":{"message":"image fixture failed"}}'); }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
try {
  brain = await CodexAgentBrain.create({ sessionManager: SessionManager.create(root), cwd: root, systemPrompt: 'Inspect the user image.', skillPaths: [], toolsetsByName: new Map(),
    grants: { executionRoots: [root], readRoots: [], writeRoots: [], deniedRoots: [], allowCommands: false, production: process.env.NODE_ENV === 'production', environment: { PATH: process.env.PATH } } });
  brain.registerProvider('fixture', { api: 'openai-responses', apiKey: 'image-fixture-key', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, models: [{ id: 'gpt-5.5', contextWindow: 128000, maxTokens: 1000 }] });
  await brain.setModel(brain.findModel('fixture', 'gpt-5.5'));
  brain.subscribe(event => events.push(event));
  const state = createModelRouteState();
  const routed = await runPromptWithModelRouting(brain, 'Inspect the user image.', resolveEffectivePolicy(undefined, state, brain.getModel()), state,
    {}, { images: [{ mimeType: 'image/png', data: png }] });
  assert.ok(routed.success, 'Framework rejected native image input before app-server');
  if (failure) throw failure;
  assert.ok(sawImage, 'Original image never reached the native Responses request');
  assert.ok(!JSON.stringify(events).includes(png), 'Raw image leaked into public events');
  assert.ok(!JSON.stringify(brain.getConversationMessages()).includes(png), 'Raw image leaked into shared history');
  console.log('Native image input smoke passed: original image reaches Responses, public echo/history contain no image bytes');
} finally {
  await brain?.close(); await new Promise(resolve => model.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
}
