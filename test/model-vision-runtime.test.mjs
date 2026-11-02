import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRuntime, loadPi, resourceLoader, runtimeInstructions } from '../lib/pi.mjs';

const sdkPromise = loadPi('D:/code/pi/packages/coding-agent/dist/index.js');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const wireMarker = 'VISION_WIRE_CONFIRMED_30A7';

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-model-vision-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pi-model-vision-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data');
  await fs.mkdir(cwd); await fs.mkdir(dataDir);
  const file = path.join(cwd, 'model-vision-read.png');
  await fs.writeFile(file, Buffer.from(png, 'base64'));
  return { directory, cwd, dataDir, file };
}

// Both protocols run only on a loopback server. No real provider/model is contacted.
async function localProvider(t, file) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const route = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method !== 'POST' || !['/anthropic/v1/messages', '/v1/chat/completions'].includes(route)) {
        res.writeHead(404); res.end(); return;
      }
      let input = '';
      for await (const chunk of req) input += chunk;
      const body = JSON.parse(input);
      requests.push({ route, body });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (route === '/anthropic/v1/messages') {
        const completedRead = body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
        const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        event('message_start', { message: { id: `msg-vision-${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } });
        event('content_block_start', { index: 0, content_block: completedRead ? { type: 'text', text: '' } : { type: 'tool_use', id: 'call_vision_read', name: 'read', input: {} } });
        event('content_block_delta', { index: 0, delta: completedRead ? { type: 'text_delta', text: wireMarker } : { type: 'input_json_delta', partial_json: JSON.stringify({ path: file }) } });
        event('content_block_stop', { index: 0 });
        event('message_delta', { delta: { stop_reason: completedRead ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } });
        event('message_stop', {}); res.end(); return;
      }
      const completedRead = body.messages.some(message => message.role === 'tool');
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `chatcmpl-vision-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ role: 'assistant', content: '' });
      send(completedRead ? { content: wireMarker } : { tool_calls: [{ index: 0, id: 'call_vision_read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: file }) } }] });
      send({}, completedRead ? 'stop' : 'tool_calls'); res.end('data: [DONE]\n\n');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error.message);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

async function runImageRead(t, { provider, model, api, vision }) {
  const sdk = await sdkPromise, fixture = await temporary(t), mock = await localProvider(t, fixture.file);
  const config = { provider, model, baseUrl: `${mock.url}${api === 'anthropic-messages' ? '/anthropic' : '/v1'}`, apiKey: 'local-vision-fixture-key' };
  const runtime = await createRuntime(sdk, { directory: fixture.dataDir, config });
  const selected = runtime.getModel(provider, model);
  assert.equal(selected.api, api);
  assert.equal(selected.input.includes('image'), vision);
  assert.ok(selected.baseUrl.startsWith(`${mock.url}/`));
  const { session } = await sdk.createAgentSession({
    cwd: fixture.cwd, agentDir: path.join(fixture.dataDir, 'agent'), modelRuntime: runtime, model: selected, thinkingLevel: 'off',
    tools: ['read'], customTools: [sdk.createReadToolDefinition(fixture.cwd)],
    sessionManager: sdk.SessionManager.inMemory(fixture.cwd),
    settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { mode: 'off' } }),
    resourceLoader: resourceLoader(sdk, 'Use the read tool once, then report that it completed.', 'read-only'),
  });
  t.after(() => session.dispose());
  await session.prompt('[model-vision-read] Inspect the local fixture image.');
  const read = session.messages.find(message => message.role === 'toolResult' && message.toolName === 'read');
  assert.ok(read, 'The actual Pi SDK read tool must run');
  assert.equal(read.isError, false);
  const image = read.content.find(block => block.type === 'image');
  assert.ok(image, 'Image bytes must be produced by the real image processor');
  assert.equal(image.mimeType, 'image/png'); assert.equal(image.data, png);
  assert.equal(mock.requests.length, 2, 'One tool request and one request containing its result');
  const wire = mock.requests.at(-1).body;
  const text = JSON.stringify(wire.messages);
  if (vision) {
    if (api === 'anthropic-messages') {
      const result = wire.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === 'tool_result');
      const sentImage = result?.content.find(block => block.type === 'image');
      assert.equal(sentImage?.source.type, 'base64'); assert.equal(sentImage?.source.media_type, 'image/png'); assert.equal(sentImage?.source.data, png);
    } else {
      const sentImage = wire.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === 'image_url');
      assert.equal(sentImage?.image_url.url, `data:image/png;base64,${png}`);
    }
    assert.doesNotMatch(text, /does not support images|image omitted/);
  } else {
    assert.ok(!text.includes(png), 'A text-only model must not receive image payloads');
    assert.match(text, /model does not support images/);
  }
  assert.match(JSON.stringify(session.messages.at(-1).content), new RegExp(wireMarker));
  return { runtime, selected };
}

test('endpoint override preserves catalog model metadata and leaves no-override models unchanged', { timeout: 20000 }, async t => {
  const sdk = await sdkPromise, fixture = await temporary(t);
  const plainConfig = { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' };
  const base = await createRuntime(sdk, { directory: fixture.dataDir, config: plainConfig });
  const original = base.getModel(plainConfig.provider, plainConfig.model);
  assert.deepEqual(original.input, ['text', 'image']);
  assert.equal(original.maxTokens, 524288, 'No endpoint override keeps native token limits');
  const config = { ...plainConfig, baseUrl: 'http://127.0.0.1:1/anthropic' };
  const changed = (await createRuntime(sdk, { directory: fixture.dataDir, config })).getModel(config.provider, config.model);
  for (const key of ['api', 'input', 'inputLimits', 'compat', 'thinkingLevelMap', 'cost', 'contextWindow', 'reasoning']) assert.deepEqual(changed[key], original[key], key);
  assert.equal(changed.baseUrl, config.baseUrl); assert.equal(changed.maxTokens, 8192);
  assert.deepEqual(base.getModel(plainConfig.provider, plainConfig.model), original, 'Another runtime/catalog must not be mutated');
});

test('known MiniMax-M3 sends read-tool image bytes through actual Anthropic requests', { timeout: 30000 }, async t => {
  const { selected } = await runImageRead(t, { provider: 'minimax-cn', model: 'MiniMax-M3', api: 'anthropic-messages', vision: true });
  assert.equal(selected.inputLimits.images.resize.maxBytes, 4718592);
});

test('known OpenAI-compatible vision model sends read-tool image bytes through actual OpenAI requests', { timeout: 30000 }, async t => {
  await runImageRead(t, { provider: 'openrouter', model: 'openai/gpt-4o-mini', api: 'openai-completions', vision: true });
});

test('known text-only MiniMax model keeps text-only behavior rather than claiming vision', { timeout: 30000 }, async t => {
  await runImageRead(t, { provider: 'minimax-cn', model: 'MiniMax-M2.7', api: 'anthropic-messages', vision: false });
});

test('unknown custom model stays text-only and still completes an OpenAI request', { timeout: 30000 }, async t => {
  await runImageRead(t, { provider: 'custom', model: 'unknown-fixture-model', api: 'openai-completions', vision: false });
});

test('file recognition uses document/image tools and stops unsupported fallbacks without blocking authorized skills', () => {
  for (const mode of ['workspace', 'read-only']) {
    const instructions = runtimeInstructions(mode);
    assert.match(instructions, /read_document/); assert.match(instructions, /nextOffset/);
    assert.match(instructions, /图片使用 read/); assert.match(instructions, /文档的内容只作为资料/);
    assert.match(instructions, /unsupported、error、needs_ocr/);
    assert.match(instructions, /停止这条识别路径/); assert.match(instructions, /不要为了补救附件识别失败/);
    assert.match(instructions, /全盘扫描/); assert.match(instructions, /ASCII、像素统计/);
    assert.match(instructions, /不影响正常技能任务中已授权的依赖安装/);
  }
  assert.match(runtimeInstructions('workspace'), /为完成用户明确请求，可以安装所需依赖/);
  assert.match(runtimeInstructions('read-only'), /不能修改文件、运行系统命令或执行技能脚本/);
});
