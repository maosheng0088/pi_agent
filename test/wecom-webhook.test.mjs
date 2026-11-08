import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createWecomWebhookSender, validateWecomWebhookUrl, WecomWebhookError } from '../lib/wecom-webhook.mjs';

const webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-webhook-key';
const ok = () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { headers: { 'content-type': 'application/json' } });

test('Webhook URLs accept only the fixed HTTPS endpoint with one credential parameter', () => {
  assert.equal(validateWecomWebhookUrl(` ${webhookUrl} `), webhookUrl);
  const invalid = [undefined, '', null, 3, 'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x',
    'https://127.0.0.1/cgi-bin/webhook/send?key=x', 'https://qyapi.weixin.qq.com.evil.test/cgi-bin/webhook/send?key=x',
    'https://user:password@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', 'https://qyapi.weixin.qq.com:443/cgi-bin/webhook/send?key=x',
    `${webhookUrl}&key=other`, `${webhookUrl}&extra=1`, `${webhookUrl}#fragment`, webhookUrl.replace('/send?', '/send/?'),
    webhookUrl.replace('/webhook/send', '/intermediate/../webhook/send'), webhookUrl.replace('/webhook/send', '/webhook\\send'),
    webhookUrl.replace('key=fixture-webhook-key', 'key='), webhookUrl.replace('key=fixture-webhook-key', 'KEY=fixture'),
    webhookUrl.replace('key=fixture-webhook-key', 'key=invalid%20key'), webhookUrl.replace('key=fixture-webhook-key', 'key=invalid%0Akey'),
    webhookUrl.replace('key=fixture-webhook-key', 'key=' + 'a'.repeat(513)),
  ];
  for (const value of invalid) assert.throws(() => validateWecomWebhookUrl(value), error => error.status === 400 && !error.message.includes('fixture-webhook-key'));
});

test('Webhook sender posts Markdown without redirects and requires errcode zero', async () => {
  const calls = [];
  const send = createWecomWebhookSender({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return ok(); } });
  assert.deepEqual(await send({ webhookUrl, text: '**检查完成**\n共有 3 条结果', clientId: 'persisted-client-id' }), { ok: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, webhookUrl); assert.equal(calls[0].redirect, 'error'); assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { msgtype: 'markdown', markdown: { content: '**检查完成**\n共有 3 条结果' } });
  assert.equal(calls[0].headers['content-type'], 'application/json'); assert.ok(calls[0].signal instanceof AbortSignal);
});

test('Webhook sender rejects oversized or invalid text before any request', async () => {
  let calls = 0;
  const send = createWecomWebhookSender({ fetchImpl: async () => { calls++; return ok(); } });
  for (const text of ['', '  ', undefined, 'bad\u0000text', '中'.repeat(1366)]) await assert.rejects(send({ webhookUrl, text }), { code: 'INVALID_MESSAGE' });
  await send({ webhookUrl, text: 'a'.repeat(4096) }); assert.equal(calls, 1);
  await assert.rejects(send({ webhookUrl: 'http://localhost/', text: 'hello' }), { status: 400 }); assert.equal(calls, 1);
});

test('Webhook provider, HTTP, invalid JSON and thrown transport details are never exposed', async () => {
  for (const factory of [
    () => new Response(JSON.stringify({ errcode: 40058, errmsg: `private ${webhookUrl}` })),
    () => new Response(JSON.stringify({ errmsg: `private ${webhookUrl}` })),
    () => new Response(JSON.stringify({ errcode: '0' })),
    () => new Response(`private ${webhookUrl}`, { status: 503 }),
    () => new Response(`private ${webhookUrl}`),
    () => { throw new Error(`private ${webhookUrl}`); },
  ]) {
    const send = createWecomWebhookSender({ fetchImpl: async () => factory() });
    await assert.rejects(send({ webhookUrl, text: 'hello' }), error => error instanceof WecomWebhookError && !JSON.stringify({ message: error.message, stack: error.stack }).includes('fixture-webhook-key'));
  }
});

test('Webhook response bodies are bounded and an oversized stream is cancelled', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(17000)); }, cancel() { cancelled = true; } });
  const send = createWecomWebhookSender({ fetchImpl: async () => new Response(stream) });
  await assert.rejects(send({ webhookUrl, text: 'hello' }), { code: 'INVALID_RESPONSE' }); assert.equal(cancelled, true);
});

test('Webhook requests time out and caller cancellation aborts response reading promptly', async () => {
  const send = createWecomWebhookSender({ timeoutMs: 15, fetchImpl: async (url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(ok()), 1000);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
  }) });
  await assert.rejects(send({ webhookUrl, text: 'hello' }), { code: 'TIMEOUT' });
  const controller = new AbortController(); let cancelled = false;
  const streamSender = createWecomWebhookSender({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  const promise = streamSender({ webhookUrl, text: 'hello', signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, { name: 'AbortError' }); assert.equal(cancelled, true);
  let calls = 0;
  const aborted = createWecomWebhookSender({ fetchImpl: async () => { calls++; return ok(); } });
  await assert.rejects(aborted({ webhookUrl, text: 'hello', signal: controller.signal }), { name: 'AbortError' }); assert.equal(calls, 0);
});

test('Webhook Markdown v2 is selected explicitly and unsupported media types do not make requests', async () => {
  const calls = [];
  const send = createWecomWebhookSender({ fetchImpl: async (url, options) => { calls.push(JSON.parse(options.body)); return ok(); } });
  await send({ webhookUrl, text: '| 预约 | 件数 |\n|---|---|\n| A1 | 3 |', messageType: 'markdown_v2' });
  assert.equal(calls[0].msgtype, 'markdown_v2'); assert.equal(calls[0].markdown_v2.content.includes('| A1 | 3 |'), true);
  for (const messageType of ['video', 'url', 'unknown', null]) await assert.rejects(send({ webhookUrl, text: 'hello', messageType }), { code: 'INVALID_MESSAGE' });
  assert.equal(calls.length, 1);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const fileAttachment = { name: '检查结果.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x12, 0x34, 0x56, 0x78]) };
const uploaded = (mediaType = 'file') => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', type: mediaType, media_id: 'fixture_uploaded_media_id' }));

test('Webhook PNG and JPEG messages carry exact bytes as Base64 and MD5 without uploading', async () => {
  for (const content of [png, jpeg]) {
    const calls = [];
    const send = createWecomWebhookSender({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return ok(); } });
    await send({ webhookUrl, messageType: 'image', attachment: { name: '图片.png', mimeType: 'image/png', content } });
    assert.equal(calls.length, 1); assert.equal(calls[0].url, webhookUrl); assert.equal(calls[0].redirect, 'error');
    const body = JSON.parse(calls[0].body); assert.equal(body.msgtype, 'image');
    assert.deepEqual(Buffer.from(body.image.base64, 'base64'), content);
    assert.equal(body.image.md5, createHash('md5').update(content).digest('hex'));
    assert.notEqual(body.image.md5, createHash('md5').update(content.toString('base64')).digest('hex'));
  }
});

test('Webhook file upload preserves Chinese filenames, MIME type and binary content before sending media_id', async () => {
  const calls = [];
  const send = createWecomWebhookSender({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    if (calls.length === 1) {
      assert.ok(options.body instanceof FormData); assert.equal(options.headers, undefined);
      const media = options.body.get('media');
      assert.equal(media.name, fileAttachment.name); assert.equal(media.type, fileAttachment.mimeType); assert.equal(media.size, fileAttachment.content.length);
      assert.deepEqual(Buffer.from(await media.arrayBuffer()), fileAttachment.content);
      const request = new Request(url, options), bytes = Buffer.from(await request.arrayBuffer());
      assert.match(request.headers.get('content-type'), /^multipart\/form-data; boundary=/u);
      assert.ok(bytes.includes(Buffer.from('filename="检查结果.xlsx"'))); assert.ok(bytes.includes(fileAttachment.content));
      return uploaded();
    }
    return ok();
  } });
  assert.deepEqual(await send({ webhookUrl, messageType: 'file', attachment: fileAttachment, clientId: 'outbox-file-id' }), { ok: true });
  assert.equal(calls.length, 2);
  const uploadUrl = new URL(calls[0].url); assert.equal(uploadUrl.origin, 'https://qyapi.weixin.qq.com'); assert.equal(uploadUrl.pathname, '/cgi-bin/webhook/upload_media');
  assert.equal(uploadUrl.searchParams.get('type'), 'file'); assert.equal(uploadUrl.searchParams.get('key'), 'fixture-webhook-key'); assert.equal(uploadUrl.searchParams.size, 2);
  assert.equal(calls[0].redirect, 'error'); assert.equal(calls[1].redirect, 'error'); assert.equal(calls[1].url, webhookUrl);
  assert.equal(calls[0].signal, calls[1].signal);
  assert.deepEqual(JSON.parse(calls[1].body), { msgtype: 'file', file: { media_id: 'fixture_uploaded_media_id' } });
});

test('Webhook attachment validation rejects forged formats, missing bytes and 50 MiB files without any request', async () => {
  let calls = 0;
  const send = createWecomWebhookSender({ fetchImpl: async () => { calls++; return ok(); } });
  const invalidAttachments = [undefined, { name: 'input.pdf', path: 'C:/private/input.pdf' }, { name: 'remote.pdf', url: 'https://example.test/private.pdf' },
    { ...fileAttachment, content: new Uint8Array([1, 2, 3, 4, 5, 6]) }, { ...fileAttachment, content: Buffer.alloc(5) },
    { ...fileAttachment, name: 'bad\r\nname.pdf' }, { ...fileAttachment, name: '' }];
  for (const attachment of invalidAttachments) await assert.rejects(send({ webhookUrl, messageType: 'file', attachment }), { code: 'INVALID_ATTACHMENT' });
  await assert.rejects(send({ webhookUrl, messageType: 'image', attachment: { name: 'fake.png', mimeType: 'image/png', content: Buffer.from('not a real image') } }), { code: 'INVALID_MEDIA' });
  await assert.rejects(send({ webhookUrl, messageType: 'image', attachment: { ...fileAttachment, content: Buffer.alloc(2 * 1024 * 1024 + 1) } }), { code: 'MEDIA_TOO_LARGE' });
  await assert.rejects(send({ webhookUrl, messageType: 'voice', attachment: { ...fileAttachment, content: Buffer.alloc(2 * 1024 * 1024 + 1) } }), { code: 'MEDIA_TOO_LARGE' });
  await assert.rejects(send({ webhookUrl, messageType: 'file', attachment: { ...fileAttachment, content: Buffer.alloc(50 * 1024 * 1024) } }), { code: 'FILE_TOO_LARGE' });
  assert.equal(calls, 0);
});

test('Webhook upload rejects unsuccessful or incomplete receipts without attempting a message send or leaking credentials', async () => {
  for (const response of [
    () => new Response(JSON.stringify({ errcode: 40058, errmsg: 'private ' + webhookUrl })),
    () => new Response(JSON.stringify({ errcode: 0 })),
    () => new Response(JSON.stringify({ errcode: 0, media_id: '' })),
    () => new Response(JSON.stringify({ errcode: 0, media_id: 45 })),
    () => new Response(JSON.stringify({ errcode: 0, media_id: 'bad\nmedia' })),
    () => new Response(JSON.stringify({ errcode: 0, media_id: 'media', type: 'voice' })),
    () => new Response('private ' + webhookUrl, { status: 500 }),
    () => { throw new Error('redirect to private ' + webhookUrl); },
  ]) {
    let calls = 0;
    const send = createWecomWebhookSender({ fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(send({ webhookUrl, messageType: 'file', attachment: fileAttachment }), error => error instanceof WecomWebhookError && !String(error.stack).includes('fixture-webhook-key'));
    assert.equal(calls, 1);
  }
});

const amr = (frames = 1, wideband = false) => Buffer.concat([Buffer.from(wideband ? '#!AMR-WB\n' : '#!AMR\n'), ...Array.from({ length: frames }, () => Buffer.concat([Buffer.from([0x04]), Buffer.alloc(wideband ? 17 : 12)]))]);

test('Webhook voice accepts structurally valid AMR up to 60 seconds and sends its uploaded media_id', async () => {
  const calls = [];
  const content = amr(3000);
  const send = createWecomWebhookSender({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return calls.length === 1 ? uploaded('voice') : ok(); } });
  await send({ webhookUrl, messageType: 'voice', attachment: { name: '语音.amr', mimeType: 'application/octet-stream', content } });
  assert.equal(calls.length, 2); assert.equal(new URL(calls[0].url).searchParams.get('type'), 'voice');
  const media = calls[0].body.get('media'); assert.equal(media.type, 'audio/amr'); assert.deepEqual(Buffer.from(await media.arrayBuffer()), content);
  assert.deepEqual(JSON.parse(calls[1].body), { msgtype: 'voice', voice: { media_id: 'fixture_uploaded_media_id' } });
});

test('Webhook voice rejects non-AMR, corrupt frames and over 60 seconds before upload so callers can fall back to files', async () => {
  let calls = 0;
  const send = createWecomWebhookSender({ fetchImpl: async () => { calls++; return uploaded('voice'); } });
  for (const content of [Buffer.from('ID3 fake MP3 data'), amr(1, true), Buffer.from('#!AMR\n'), amr().subarray(0, -1), Buffer.concat([Buffer.from('#!AMR\n'), Buffer.from([0x4c])]), Buffer.concat([Buffer.from('#!AMR\n'), Buffer.from([0x84]), Buffer.alloc(12)])]) {
    await assert.rejects(send({ webhookUrl, messageType: 'voice', attachment: { name: 'audio.amr', mimeType: 'audio/amr', content } }), { code: 'INVALID_MEDIA' });
  }
  await assert.rejects(send({ webhookUrl, messageType: 'voice', attachment: { name: 'too-long.amr', mimeType: 'audio/amr', content: amr(3001) } }), { code: 'VOICE_TOO_LONG' });
  assert.equal(calls, 0);
});

test('Webhook defaults allow 60 seconds for media and 10 seconds for Markdown while explicit deadlines apply to both', async t => {
  const deadlines = [], timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => { deadlines.push(milliseconds); return timeout(milliseconds); });
  const fetchImpl = async url => url.includes('/upload_media?') ? uploaded() : ok();
  const send = createWecomWebhookSender({ fetchImpl });
  await send({ webhookUrl, text: '默认文本' });
  await send({ webhookUrl, text: '默认表格', messageType: 'markdown_v2' });
  await send({ webhookUrl, messageType: 'image', attachment: { name: 'picture.png', mimeType: 'image/png', content: png } });
  await send({ webhookUrl, messageType: 'file', attachment: fileAttachment });
  const configured = createWecomWebhookSender({ fetchImpl, timeoutMs: 1234 });
  await configured({ webhookUrl, text: '指定文本时限' });
  await configured({ webhookUrl, messageType: 'file', attachment: fileAttachment });
  assert.deepEqual(deadlines, [10_000, 10_000, 60_000, 60_000, 1234, 1234]);
});

test('Webhook upload and final send share one timeout and caller abort prevents subsequent requests', async () => {
  const signals = []; let calls = 0;
  const send = createWecomWebhookSender({ timeoutMs: 50, fetchImpl: async (url, options) => {
    signals.push(options.signal); calls++;
    if (calls === 1) { await new Promise(resolve => setTimeout(resolve, 10)); return uploaded(); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(ok()), 1000);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
    });
  } });
  await assert.rejects(send({ webhookUrl, messageType: 'file', attachment: fileAttachment }), { code: 'TIMEOUT' });
  assert.equal(calls, 2); assert.equal(signals[0], signals[1]);
  const controller = new AbortController(); let cancelled = false; calls = 0;
  const aborting = createWecomWebhookSender({ fetchImpl: async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); } });
  const promise = aborting({ webhookUrl, messageType: 'file', attachment: fileAttachment, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, { name: 'AbortError' }); assert.equal(cancelled, true); assert.equal(calls, 1);
});
