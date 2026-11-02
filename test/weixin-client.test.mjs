import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WeixinClient, WeixinError, normalizeIncomingMessage } from '../lib/weixin-client.mjs';

function mockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, options);
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('QR creation uses the fixed Tencent endpoint and does not expose bot credentials', async () => {
  const mock = mockFetch([{ qrcode: 'private-qr', qrcode_img_content: 'https://liteapp.weixin.qq.com/login?token=qr' }]);
  const client = new WeixinClient({ fetchImpl: mock.fetchImpl, token: 'bot-secret', baseUrl: 'https://ilinkai2.weixin.qq.com' });
  assert.deepEqual(await client.getQrCode(), { qrcode: 'private-qr', qrCodeUrl: 'https://liteapp.weixin.qq.com/login?token=qr' });
  const call = mock.calls[0];
  assert.equal(call.url, 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
  assert.equal(call.method, 'POST');
  assert.equal(call.redirect, 'error');
  assert.deepEqual(JSON.parse(call.body), { local_token_list: [] });
  assert.equal(call.headers.Authorization, undefined);
  assert.equal(call.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(call.headers['iLink-App-Id'], 'bot');
  assert.match(Buffer.from(call.headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
  assert.equal(Number.isInteger(Number(call.headers['iLink-App-ClientVersion'])), true);
  assert.doesNotMatch(JSON.stringify(client), /bot-secret/);
});

test('QR status sends only application headers, handles verification and allowed IDC redirects', async () => {
  const mock = mockFetch([
    { status: 'need_verifycode' },
    { status: 'scaned_but_redirect', redirect_host: 'ilinkai2.weixin.qq.com' },
    { status: 'confirmed', bot_token: 'new-token', ilink_bot_id: 'bot-id', ilink_user_id: 'scanner-id', baseurl: 'https://ilinkai3.weixin.qq.com/' },
  ]);
  const client = new WeixinClient({ fetchImpl: mock.fetchImpl, token: 'unused-secret' });
  assert.deepEqual(await client.getQrStatus('a&? q'), { status: 'need_verifycode' });
  await client.getQrStatus('a&? q', { verifyCode: 'AB 12' });
  assert.equal(client.baseUrl, 'https://ilinkai2.weixin.qq.com');
  assert.equal(new URL(mock.calls[1].url).searchParams.get('verify_code'), 'AB 12');
  assert.equal(new URL(mock.calls[1].url).searchParams.get('qrcode'), 'a&? q');
  assert.deepEqual(await client.getQrStatus('qr'), { status: 'confirmed', token: 'new-token', accountId: 'bot-id', userId: 'scanner-id', baseUrl: 'https://ilinkai3.weixin.qq.com' });
  assert.equal(new URL(mock.calls[2].url).origin, 'https://ilinkai2.weixin.qq.com');
  for (const call of mock.calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(call.headers.AuthorizationType, undefined);
    assert.equal(call.headers['X-WECHAT-UIN'], undefined);
    assert.equal(call.body, undefined);
  }
});

test('credentials and QR redirects cannot target unapproved hosts or follow HTTP redirects', async () => {
  for (const baseUrl of [
    'http://ilinkai.weixin.qq.com', 'https://127.0.0.1', 'https://weixin.qq.com.evil.test',
    'https://ilinkai.weixin.qq.com@evil.test', 'https://name:pass@ilinkai.weixin.qq.com',
    'https://ilinkai.weixin.qq.com:8443', 'https://ilinkai.weixin.qq.com/path',
    'https://ilinkai.weixin.qq.com/?token=secret',
  ]) assert.throws(() => new WeixinClient({ baseUrl }), error => error.code === 'INVALID_BASE_URL');
  for (const response of [
    { status: 'scaned_but_redirect', redirect_host: 'localhost' },
    { status: 'confirmed', bot_token: 'secret', ilink_bot_id: 'id', ilink_user_id: 'user', baseurl: 'https://evil.test' },
  ]) {
    const mock = mockFetch([response]);
    const client = new WeixinClient({ fetchImpl: mock.fetchImpl });
    await assert.rejects(client.getQrStatus('qr'), error => error.code === 'INVALID_BASE_URL');
    assert.equal(mock.calls.length, 1);
    assert.equal(client.baseUrl, 'https://ilinkai.weixin.qq.com');
  }
});

test('long polling carries bot authentication and keeps the last nonempty cursor', async () => {
  const message = { message_id: 7, message_type: 1 };
  const mock = mockFetch([
    { ret: 0, msgs: [message], get_updates_buf: 'next-cursor', longpolling_timeout_ms: 45000 },
    { ret: 0, msgs: [], get_updates_buf: '', sync_buf: 'deprecated-buffer' },
  ]);
  const client = new WeixinClient({ fetchImpl: mock.fetchImpl, token: 'bot-token' });
  assert.deepEqual(await client.getUpdates('old-cursor'), { messages: [message], cursor: 'next-cursor', longPollTimeoutMs: 45000 });
  assert.equal((await client.getUpdates('next-cursor')).cursor, 'next-cursor');
  assert.equal(mock.calls[0].headers.Authorization, 'Bearer bot-token');
  const body = JSON.parse(mock.calls[0].body);
  assert.equal(body.get_updates_buf, 'old-cursor');
  assert.equal(body.base_info.bot_agent, 'PiWeb/0.9.0');
  assert.equal(typeof body.base_info.channel_version, 'string');
  assert.equal(body.sync_buf, undefined);
});

test('text sending uses the official completed bot-message envelope and a stable client ID', async () => {
  const mock = mockFetch([{ ret: 0 }]);
  const client = new WeixinClient({ fetchImpl: mock.fetchImpl, token: 'bot-token' });
  assert.deepEqual(await client.sendText({ toUserId: 'scanner', text: '任务完成\n第二行', contextToken: 'context-secret', clientId: 'stable-id' }), { clientId: 'stable-id' });
  assert.equal(new URL(mock.calls[0].url).pathname, '/ilink/bot/sendmessage');
  assert.deepEqual(JSON.parse(mock.calls[0].body).msg, {
    from_user_id: '', to_user_id: 'scanner', client_id: 'stable-id', message_type: 2, message_state: 2,
    context_token: 'context-secret', item_list: [{ type: 1, text_item: { text: '任务完成\n第二行' } }],
  });
});

test('normalization accepts genuine direct text and transcribed voice, excluding echoes and groups', () => {
  const raw = {
    message_id: 123, message_type: 1, from_user_id: 'scanner', to_user_id: 'bot', context_token: 'context', create_time_ms: 1000,
    item_list: [{ type: 1, text_item: { text: '查询任务' } }, { type: 3, voice_item: { text: '语音文字' } }, { type: 2, image_item: {} }],
  };
  assert.deepEqual(normalizeIncomingMessage(raw), { messageId: '123', userId: 'scanner', toUserId: 'bot', text: '查询任务\n语音文字', contextToken: 'context', timestamp: 1000 });
  assert.equal(normalizeIncomingMessage({ ...raw, message_id: 0 }).messageId, '0');
  for (const excluded of [
    { ...raw, message_type: 2 }, { ...raw, message_type: undefined }, { ...raw, message_id: undefined },
    { ...raw, from_user_id: '' }, { ...raw, group_id: 'native-wechat-group' }, { ...raw, delete_time_ms: 2000 },
    { ...raw, item_list: [{ type: 3, voice_item: { media: {} } }] },
    { ...raw, item_list: [{ type: 11, text_item: { text: 'tool call' } }] },
  ]) assert.equal(normalizeIncomingMessage(excluded), null);
});

test('provider and transport errors are redacted and authentication expiration is explicit', async () => {
  for (const result of [
    { ret: -14, errmsg: 'secret-bot-token context-secret' },
    { ret: 0, errcode: -14, errmsg: 'secret-bot-token context-secret' },
  ]) {
    const mock = mockFetch([result]);
    const client = new WeixinClient({ fetchImpl: mock.fetchImpl, token: 'secret-bot-token' });
    await assert.rejects(client.getUpdates(), error => {
      assert.ok(error instanceof WeixinError);
      assert.equal(error.authExpired, true);
      assert.equal(error.code, -14);
      assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /secret-bot-token|context-secret/);
      return true;
    });
  }
  for (const response of [
    new Error('http request Authorization Bearer secret-bot-token'),
    () => new Response('secret-bot-token', { status: 503 }),
    () => new Response('secret-bot-token', { status: 200 }),
    { ret: 42, errmsg: 'secret-bot-token' },
  ]) {
    const mock = mockFetch([response]);
    await assert.rejects(new WeixinClient({ fetchImpl: mock.fetchImpl, token: 'secret-bot-token' }).getUpdates(), error => {
      assert.ok(error instanceof WeixinError);
      assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /secret-bot-token/);
      return true;
    });
  }
});

test('long-poll timeouts keep the cursor while external cancellation exits promptly', async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => resolve(new Response('{}')), 500);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new DOMException('secret', 'AbortError')); }, { once: true });
  });
  const client = new WeixinClient({ fetchImpl, token: 'token', apiTimeoutMs: 5 });
  assert.deepEqual(await client.getUpdates('unchanged'), { messages: [], cursor: 'unchanged', longPollTimeoutMs: 5, timedOut: true });
  assert.deepEqual(await client.getQrStatus('qr'), { status: 'wait' });
  const controller = new AbortController();
  const pending = new WeixinClient({ fetchImpl, token: 'token' }).getUpdates('saved', { signal: controller.signal });
  controller.abort(new Error('secret cancellation reason'));
  await assert.rejects(pending, error => error.name === 'AbortError' && !error.message.includes('secret'));
  await assert.rejects(client.getUpdates('saved', { signal: controller.signal }), error => error.name === 'AbortError');
});

test('invalid QR status, incomplete credentials, and invalid outgoing fields fail without leakage', async () => {
  for (const response of [{ status: 'unknown-secret-status' }, { status: 'confirmed', bot_token: 'secret' }]) {
    const mock = mockFetch([response]);
    await assert.rejects(new WeixinClient({ fetchImpl: mock.fetchImpl }).getQrStatus('qr'), error => error.code === 'INVALID_RESPONSE' && !error.message.includes('secret'));
  }
  const mock = mockFetch([]);
  const client = new WeixinClient({ fetchImpl: mock.fetchImpl });
  await assert.rejects(client.sendText({ toUserId: 'peer', text: ' ' }), error => error.code === 'INVALID_MESSAGE');
  await assert.rejects(client.sendText({ toUserId: 'peer', text: 'valid' }), error => error.code === 'NOT_AUTHENTICATED');
  await assert.rejects(client.getQrStatus(''), error => error.code === 'INVALID_QR_CODE');
  assert.equal(mock.calls.length, 0);
});
