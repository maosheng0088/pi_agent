import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { WecomClient, WecomError, normalizeWecomIncomingMessage } from '../lib/wecom-client.mjs';

const incoming = (overrides = {}) => ({
  cmd: 'aibot_msg_callback', headers: { req_id: 'req-inbound' },
  body: { msgid: 'msg-1', aibotid: 'bot-id', chattype: 'group', chatid: 'group-id', from: { userid: 'employee' }, msgtype: 'text', text: { content: '查询订单' }, create_time: 1700000000, ...overrides },
});

function setup(overrides = {}) {
  const sdk = new EventEmitter();
  const state = { connects: 0, disconnects: 0, replies: [], states: [], messages: [], options: null };
  sdk.connect = () => { state.connects++; return sdk; };
  sdk.disconnect = () => { state.disconnects++; sdk.emit('disconnected', 'private-server-reason'); };
  sdk.reply = async (...args) => { state.replies.push(args); return { errcode: 0 }; };
  const client = new WecomClient({
    botId: 'bot-id', secret: 'secret-value',
    onMessage: message => state.messages.push(message), onState: value => state.states.push(value),
    sdkFactory: options => { state.options = options; return sdk; }, ...overrides,
  });
  return { client, sdk, state };
}

test('WeCom connects only to the official endpoint and publishes connected only after authentication', async () => {
  const { client, sdk, state } = setup();
  assert.equal(client.start(), client);
  client.start();
  assert.equal(state.connects, 1);
  assert.equal(state.options.wsUrl, 'wss://openws.work.weixin.qq.com');
  assert.equal(state.options.botId, 'bot-id');
  assert.equal(state.options.secret, 'secret-value');
  assert.equal(state.options.maxReconnectAttempts, -1);
  assert.equal(state.options.maxAuthFailureAttempts, 1);
  sdk.emit('connected');
  assert.equal(state.states.at(-1).status, 'connecting');
  await assert.rejects(client.sendText({ targetId: 'group-id', text: 'hi' }), error => error.code === 'NOT_CONNECTED');
  sdk.emit('authenticated');
  assert.deepEqual(state.states.at(-1), { status: 'connected' });
  for (const level of ['debug', 'info', 'warn', 'error']) assert.equal(state.options.logger[level]('secret-value'), undefined);
  assert.doesNotMatch(JSON.stringify(client), /bot-id|secret-value/);
  await client.close();
});

test('WeCom normalization accepts group text, direct voice and safe mixed text', () => {
  assert.deepEqual(normalizeWecomIncomingMessage(incoming(), 'bot-id'), {
    messageId: 'msg-1', userId: 'employee', chatType: 'group', targetId: 'group-id',
    text: '查询订单', timestamp: 1700000000000, botId: 'bot-id', requestId: 'req-inbound',
  });
  const voice = normalizeWecomIncomingMessage(incoming({ chattype: 'single', msgtype: 'voice', voice: { content: '语音文字' } }), 'bot-id');
  assert.equal(voice.targetId, 'employee');
  assert.equal(voice.text, '语音文字');
  const mixed = normalizeWecomIncomingMessage(incoming({ msgtype: 'mixed', mixed: { msg_item: [
    { msgtype: 'text', text: { content: '第一行' } }, { msgtype: 'image', image: { url: 'private-media' } }, { msgtype: 'text', text: { content: '第二行' } },
  ] } }), 'bot-id');
  assert.equal(mixed.text, '第一行\n第二行');
  assert.doesNotMatch(JSON.stringify(mixed), /private-media/);
});

test('WeCom drops other robots, echoes, events, malformed routing and unsupported media', () => {
  for (const frame of [
    { ...incoming(), cmd: 'aibot_event_callback' }, { ...incoming(), cmd: undefined },
    { ...incoming(), headers: {} }, incoming({ aibotid: 'other-bot' }), incoming({ msgid: '' }),
    incoming({ from: { userid: 'bot-id' } }), incoming({ from: { userid: '' } }), incoming({ chatid: '' }),
    incoming({ chattype: 'unknown' }), incoming({ msgtype: 'image', image: { url: 'private' } }),
    incoming({ msgtype: 'event' }), incoming({ text: { content: '  ' } }), incoming({ msgid: 'bad\nvalue' }),
    incoming({ msgtype: 'voice', voice: {} }), incoming({ text: { content: '\u0000text' } }),
  ]) assert.equal(normalizeWecomIncomingMessage(frame, 'bot-id'), null);
});

test('WeCom callbacks are authenticated and normalized without forwarding raw frames', async () => {
  const { client, sdk, state } = setup();
  client.start();
  sdk.emit('message', incoming());
  assert.equal(state.messages.length, 0);
  sdk.emit('authenticated');
  sdk.emit('message', incoming());
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].text, '查询订单');
  assert.equal(state.messages[0].body, undefined);
  sdk.emit('disconnected', 'secret-value');
  sdk.emit('message', incoming());
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.states.at(-1), { status: 'disconnected' });
  sdk.emit('reconnecting', 1);
  assert.deepEqual(state.states.at(-1), { status: 'connecting' });
  await client.close();
});

test('WeCom sends acknowledged Markdown with stable persisted IDs for both target kinds', async () => {
  const { client, sdk, state } = setup();
  client.start(); sdk.emit('authenticated');
  assert.deepEqual(await client.sendText({ targetId: 'group-id', text: '任务完成\n第二行', clientId: 'stable-outbox-id' }), { clientId: 'stable-outbox-id' });
  assert.deepEqual(state.replies[0], [
    { headers: { req_id: 'stable-outbox-id' } },
    { chatid: 'group-id', msgtype: 'markdown', markdown: { content: '任务完成\n第二行' } }, 'aibot_send_msg',
  ]);
  await client.sendText({ targetId: 'employee', text: '完成', clientId: 'stable-user-id' });
  assert.equal(state.replies[1][1].chatid, 'employee');
  await client.close();
});

test('WeCom errors and acknowledgement failures never reveal raw provider frames or credentials', async () => {
  const { client, sdk, state } = setup();
  client.start(); sdk.emit('authenticated');
  sdk.reply = async () => { throw { errcode: 6000, errmsg: 'secret-value', body: { secret: 'secret-value' } }; };
  await assert.rejects(client.sendText({ targetId: 'group-id', text: 'hi' }), error => {
    assert.ok(error instanceof WecomError);
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /secret-value/);
    return true;
  });
  sdk.reply = async () => ({ errcode: 6000, errmsg: 'secret-value' });
  await assert.rejects(client.sendText({ targetId: 'group-id', text: 'hi' }), error => error.code === 'PROVIDER_ERROR');
  sdk.emit('error', new Error('secret-value'));
  assert.doesNotMatch(JSON.stringify(state.states), /secret-value/);
  sdk.emit('error', Object.assign(new Error('secret-value'), { code: 'WS_AUTH_FAILURE_EXHAUSTED' }));
  assert.match(state.states.at(-1).lastError, /认证失败/);
  sdk.emit('authenticated');
  assert.equal(state.states.at(-1).status, 'error');
  await client.close();
});

test('WeCom a newer connection makes this connection terminal without reconnecting or exposing reasons', async () => {
  const { client, sdk, state } = setup();
  client.start(); sdk.emit('authenticated');
  sdk.emit('event.disconnected_event', incoming({ msgtype: 'event' }));
  const kicked = state.states.at(-1);
  assert.equal(kicked.status, 'error');
  assert.match(kicked.lastError, /其他位置/);
  sdk.emit('disconnected', 'secret-value'); sdk.emit('reconnecting'); sdk.emit('authenticated');
  assert.deepEqual(state.states.at(-1), kicked);
  await assert.rejects(client.sendText({ targetId: 'group-id', text: 'hi' }), error => error.code === 'NOT_CONNECTED');
  assert.equal(state.connects, 1);
  await client.close();
});

test('WeCom send cancellation and shutdown settle promptly and remove listener callbacks', async () => {
  const { client, sdk, state } = setup();
  client.start(); sdk.emit('authenticated');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(client.sendText({ targetId: 'group-id', text: 'hi', signal: aborted.signal }), { name: 'AbortError' });
  assert.equal(state.replies.length, 0);
  sdk.reply = () => new Promise(() => {});
  const controller = new AbortController();
  const pending = client.sendText({ targetId: 'group-id', text: 'hi', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const closing = client.sendText({ targetId: 'group-id', text: 'hi' });
  await client.close();
  await assert.rejects(closing, error => error.code === 'NOT_CONNECTED');
  assert.equal(sdk.eventNames().length, 0);
  const count = state.states.length;
  sdk.emit('authenticated'); sdk.emit('message', incoming());
  assert.equal(state.states.length, count);
  assert.equal(state.messages.length, 0);
  await client.close();
  assert.equal(state.disconnects, 1);
});

test('WeCom invalid credentials and synchronous SDK failures are sanitized', async () => {
  for (const args of [{}, { botId: 'id', secret: '' }, { botId: 'bad\nid', secret: 'secret-value' }]) {
    assert.throws(() => new WecomClient(args), error => error.code === 'INVALID_CREDENTIALS');
  }
  const states = [];
  const client = new WecomClient({ botId: 'id', secret: 'secret-value', onState: value => states.push(value), sdkFactory() { throw new Error('secret-value'); } });
  assert.throws(() => client.start(), error => error instanceof WecomError && !error.stack.includes('secret-value'));
  assert.equal(states.at(-1).status, 'error');
  await client.close();
});
