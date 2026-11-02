import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChannelsController } from '../public/channels.js';

// Exercise polling and dialog lifecycles without using a real account or QR code.
function harness(t, handler) {
  const elements = new Map(), timers = new Set(), requests = [];
  const document = { activeElement: null, body: { append() {} } };
  class Element {
    constructor(tag = 'div', className = '', text = '') { Object.assign(this, { tag, className, textContent: text, children: [], dataset: {}, attributes: {}, listeners: {}, open: false, value: '', hidden: false }); }
    set innerHTML(html) { for (const match of html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"/g)) elements.set(match[2], new Element(match[1])); }
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
    replaceChildren(...items) { this.children.forEach(child => { child.parent = null; }); this.children = []; this.append(...items); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    querySelectorAll(selector) { return selector === 'dialog' ? [...elements.values()].filter(element => element.tag === 'dialog') : selector === 'input' ? descendants(this).filter(element => element.tag === 'input') : []; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    async trigger(type) { for (const handler of this.listeners[type] || []) await handler({ preventDefault() {} }); }
    showModal() { this.open = true; }
    close() { if (this.open) { this.open = false; void this.trigger('close'); } }
    focus() { document.activeElement = this; }
    reset() { this.value = ''; }
  }
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => timers.delete(timer));
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const state = { user: { id: 'admin', role: 'admin' }, identityEpoch: 1 };
  const api = async (path, options = {}) => { requests.push({ path, ...options }); return handler(path, options); };
  const controller = createChannelsController({ $, api, state, node: (...args) => new Element(...args), icon: () => new Element('svg'), toast() {}, company: { isAdmin: () => state.user?.role === 'admin' }, closeSidebar() {}, onCreated() {} });
  t.after(() => { controller.reset(); if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete globalThis.document; });
  return {
    $, state, controller, requests, timers, document,
    next: async delay => { const timer = [...timers].find(timer => timer.delay === delay); assert.ok(timer, `expected ${delay} ms timer`); timers.delete(timer); await timer.callback(); },
  };
}
const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
const card = h => h.$('channels-list').children[0];
const byText = (element, text) => descendants(element).find(child => child.textContent === text);
const sample = () => ({ id: 'wx', name: '同事微信', connected: false, enabled: true, status: 'connecting' });
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('manager refresh updates status and action closures without losing edits, focus, or delete confirmation', async t => {
  const channel = sample();
  const h = harness(t, async (_path, options) => { if (options.method === 'PATCH') Object.assign(channel, options.body); return { channels: [{ ...channel }] }; });
  await h.controller.openManager();
  const initialCard = card(h), input = descendants(initialCard).find(element => element.tag === 'input');
  input.value = '尚未保存的名称'; input.focus();
  Object.assign(channel, { connected: true, enabled: false, status: 'connected', name: '服务器新名称' });
  await h.next(2500);
  assert.equal(card(h), initialCard); assert.equal(input.value, '尚未保存的名称'); assert.equal(h.document.activeElement, input);
  assert.ok(byText(initialCard, '重新扫码')); assert.ok(byText(initialCard, '暂停'));
  await byText(initialCard, '启用渠道').trigger('click');
  assert.deepEqual(h.requests.find(request => request.method === 'PATCH').body, { enabled: true });
  assert.ok(byText(initialCard, '已连接'));
  await byText(initialCard, '删除').trigger('click');
  const confirmationFocus = h.document.activeElement;
  await h.next(2500);
  assert.equal(h.$('channel-delete-dialog').open, true); assert.equal(h.document.activeElement, confirmationFocus);
});

test('closing the manager aborts an active refresh and discards its late response', async t => {
  let calls = 0, resolveRefresh;
  const h = harness(t, async () => ++calls === 1 ? { channels: [sample()] } : new Promise(resolve => { resolveRefresh = resolve; }));
  await h.controller.openManager();
  const pending = h.next(2500);
  const request = h.requests.at(-1);
  h.$('channels-dialog').close();
  assert.equal(request.signal.aborted, true);
  resolveRefresh({ channels: [{ ...sample(), connected: true }] }); await pending;
  assert.equal(h.$('channels-list').children.length, 0); assert.equal(h.timers.size, 0);
});

test('login retries a transient failure, shows redirect progress, and refreshes the connected manager card', async t => {
  let statusCalls = 0;
  const h = harness(t, async (path, options) => {
    if (path === '/api/admin/channels') return { channels: [{ ...sample(), connected: statusCalls >= 3 }] };
    if (options.method === 'POST') return { login: { id: 'qr', status: 'wait' } };
    statusCalls++;
    if (statusCalls === 1) throw new Error('temporary network failure');
    return { login: { id: 'qr', status: statusCalls === 2 ? 'scaned_but_redirect' : 'confirmed' }, channel: { connected: statusCalls >= 3 } };
  });
  await h.controller.openManager(); await byText(card(h), '扫码登录').trigger('click');
  await h.next(2000); assert.match(h.$('channel-login-status').textContent, /自动重试/);
  await h.next(2000); assert.match(h.$('channel-login-status').textContent, /已扫码，确认处理中/);
  await h.next(2000); await flush();
  assert.equal(h.$('channel-login-qr').hidden, true); assert.match(h.$('channel-login-status').textContent, /微信已连接/);
  assert.ok(byText(card(h), '已连接')); assert.equal([...h.timers].some(timer => timer.delay === 2000), false);
});

test('blocked verification stops polling, hides the stale QR, and asks for a new scan', async t => {
  const h = harness(t, async (path, options) => path === '/api/admin/channels' ? { channels: [sample()] } : { login: { id: 'qr', status: options.method === 'POST' ? 'wait' : 'verify_code_blocked' } });
  await h.controller.openManager(); await byText(card(h), '扫码登录').trigger('click');
  h.$('channel-verify-code').value = '1234'; await h.next(2000);
  assert.match(h.$('channel-login-status').textContent, /刷新二维码后重新扫码/);
  assert.equal(h.$('channel-verify-form').hidden, true); assert.equal(h.$('channel-verify-code').value, '');
  assert.equal(h.$('channel-login-qr').hidden, true); assert.equal([...h.timers].some(timer => timer.delay === 2000), false);
});

test('login retry is bounded and reset clears timers and aborts the pending login request', async t => {
  let deferLogin = false, resolveLogin;
  const h = harness(t, async (path, options) => {
    if (path === '/api/admin/channels') return { channels: [sample()] };
    if (options.method === 'POST') return deferLogin ? new Promise(resolve => { resolveLogin = resolve; }) : { login: { id: 'qr', status: 'wait' } };
    throw new Error('temporary network failure');
  });
  await h.controller.openManager(); await byText(card(h), '扫码登录').trigger('click');
  for (const delay of [2000, 2000, 4000, 8000, 10000]) await h.next(delay);
  assert.match(h.$('channel-login-status').textContent, /可关闭窗口后查看渠道连接状态/);
  assert.deepEqual([...h.timers].map(timer => timer.delay), [2500]);
  deferLogin = true;
  const pending = byText(card(h), '扫码登录').trigger('click'); const request = h.requests.at(-1);
  h.controller.reset(); assert.equal(request.signal.aborted, true); assert.equal(h.timers.size, 0);
  resolveLogin({ login: { id: 'stale', status: 'wait' } }); await pending;
  assert.equal(h.$('channel-login-dialog').open, false); assert.equal(h.timers.size, 0);
});

test('returning from channel management preserves new group name and selected bindings', async t => {
  const h = harness(t, async () => ({ channels: [sample()] }));
  h.controller.openCreate(); await flush();
  h.$('group-channel-name').value = '报价协作群';
  const checkbox = descendants(h.$('group-channel-options')).find(element => element.tag === 'input');
  checkbox.checked = true; await checkbox.trigger('change');
  await h.controller.openManager(); await h.next(2500); h.$('channels-dialog').close(); await flush();
  assert.equal(h.$('group-channel-name').value, '报价协作群');
  assert.equal(descendants(h.$('group-channel-options')).find(element => element.tag === 'input').checked, true);
});

const wecomSample = () => ({ id: 'corp', type: 'wecom', name: '报价协作机器人', botId: 'bot-1', secretSet: true, connected: true, enabled: true, status: 'connected', target: null });

test('creating WeCom sends its credential contract, clears the password immediately, and never opens a QR login', async t => {
  let rejectCreate;
  const h = harness(t, async (path, options) => options.method === 'POST' ? new Promise((_resolve, reject) => { rejectCreate = reject; }) : { channels: [] });
  await h.controller.openManager();
  h.$('channel-create-type').value = 'wecom'; await h.$('channel-create-type').trigger('change');
  assert.equal(h.$('channel-create-wecom').hidden, false); assert.equal(h.$('channel-create-secret').required, true);
  h.$('channel-create-name').value = '报价协作'; h.$('channel-create-bot-id').value = 'bot-1'; h.$('channel-create-secret').value = 'test-secret';
  const pending = h.$('channel-create-form').trigger('submit');
  assert.equal(h.$('channel-create-secret').value, '');
  assert.deepEqual(h.requests.at(-1).body, { type: 'wecom', name: '报价协作', botId: 'bot-1', secret: 'test-secret' });
  rejectCreate(new Error('connection unavailable')); await pending;
  assert.equal(h.$('channel-create-secret').value, ''); assert.equal(h.$('channel-login-dialog').open, false);
  assert.match(h.$('channels-error').textContent, /connection unavailable/);
});

test('WeCom discovers conversations without auto-selecting one, preserves drafts, and only saves an explicit target', async t => {
  const channel = wecomSample(), conversation = { id: 'group-1', chatType: 'group', label: '<b>业务群</b>', memberCount: 8, lastSeen: '2026-10-28T09:30:00Z' };
  const h = harness(t, async (path, options) => {
    if (path.endsWith('/conversations')) return { conversations: [conversation] };
    if (options.method === 'PATCH') { Object.assign(channel, options.body); return { channel: { ...channel } }; }
    return { channels: [{ ...channel }] };
  });
  await h.controller.openManager(); await byText(card(h), '配置企业微信').trigger('click'); await flush();
  assert.equal(h.$('channel-wecom-dialog').open, true); assert.equal(h.$('channel-login-dialog').open, false);
  assert.equal(h.$('channel-wecom-target').value, '');
  assert.match(h.$('channel-wecom-target').children[1].textContent, /^群聊 · ID：group-1 · 最近收到/);
  assert.equal(h.$('channel-wecom-target').children[1].textContent.includes('<b>'), false);
  h.$('channel-wecom-bot-id').value = 'edited-bot'; h.$('channel-wecom-secret').value = 'new-secret'; h.$('channel-wecom-secret').focus();
  h.$('channel-wecom-target').value = JSON.stringify(['group', 'group-1']);
  await h.next(2500); await h.$('channel-wecom-refresh').trigger('click');
  assert.equal(h.$('channel-wecom-bot-id').value, 'edited-bot'); assert.equal(h.$('channel-wecom-secret').value, 'new-secret');
  assert.equal(h.document.activeElement, h.$('channel-wecom-secret')); assert.equal(h.$('channel-wecom-target').value, JSON.stringify(['group', 'group-1']));
  h.$('channel-wecom-bot-id').value = 'bot-1'; h.$('channel-wecom-secret').value = '';
  await h.$('channel-wecom-form').trigger('submit');
  assert.deepEqual(h.requests.find(request => request.method === 'PATCH').body, { botId: 'bot-1', target: { id: 'group-1', chatType: 'group' } });
  assert.equal(h.$('channel-wecom-secret').value, ''); assert.equal(h.$('channel-wecom-dialog').open, false);
});

test('WeCom blank Secret preserves server credentials and reconnect uses a separate non-QR endpoint', async t => {
  const channel = wecomSample();
  const h = harness(t, async (path, options) => path.endsWith('/conversations') ? { conversations: [] } : options.method === 'PATCH' ? { channel } : { channels: [channel] });
  await h.controller.openManager(); await byText(card(h), '重新连接').trigger('click');
  assert.deepEqual(h.requests.find(request => request.method === 'POST'), { path: '/api/admin/channels/corp/connect', method: 'POST', body: {} });
  assert.equal(h.$('channel-login-dialog').open, false);
  await byText(card(h), '配置企业微信').trigger('click'); await flush(); await h.$('channel-wecom-form').trigger('submit');
  assert.deepEqual(h.requests.find(request => request.method === 'PATCH').body, { botId: 'bot-1', target: null });
});

test('WeCom reset clears credentials, aborts discovery, and ignores a response after identity changes', async t => {
  let resolveDiscovery;
  const h = harness(t, async path => path.endsWith('/conversations') ? new Promise(resolve => { resolveDiscovery = resolve; }) : { channels: [wecomSample()] });
  await h.controller.openManager(); await byText(card(h), '配置企业微信').trigger('click');
  const request = h.requests.at(-1); h.$('channel-wecom-secret').value = 'draft-secret'; h.$('channel-create-secret').value = 'create-draft';
  h.state.identityEpoch++; h.state.user = { id: 'staff', role: 'employee' }; h.controller.sync();
  assert.equal(request.signal.aborted, true); assert.equal(h.$('channel-wecom-dialog').open, false);
  assert.equal(h.$('channel-wecom-secret').value, ''); assert.equal(h.$('channel-create-secret').value, ''); assert.equal(h.timers.size, 0);
  resolveDiscovery({ conversations: [{ id: 'late', chatType: 'group', label: 'stale' }] }); await flush();
  assert.equal(h.$('channel-wecom-target').children.length, 0);
  const requests = h.requests.length; await h.controller.openManager(); assert.equal(h.requests.length, requests);
});

test('changing WeCom credentials omits the previously selected target so old conversation access is not inherited', async t => {
  const target = { id: 'old-group', chatType: 'group' }, channel = { ...wecomSample(), target };
  const h = harness(t, async (path, options) => path.endsWith('/conversations') ? { conversations: [target] } : options.method === 'PATCH' ? { channel: { ...channel, botId: options.body.botId, target: null } } : { channels: [channel] });
  await h.controller.openManager(); await byText(card(h), '配置企业微信').trigger('click'); await flush();
  assert.equal(h.$('channel-wecom-target').value, JSON.stringify(['group', 'old-group']));
  h.$('channel-wecom-bot-id').value = 'bot-2'; h.$('channel-wecom-secret').value = 'replacement-secret';
  await h.$('channel-wecom-form').trigger('submit');
  assert.deepEqual(h.requests.find(request => request.method === 'PATCH').body, { botId: 'bot-2', secret: 'replacement-secret' });
  assert.equal(h.$('channel-wecom-secret').value, ''); assert.equal(h.$('channel-wecom-dialog').open, false);
});
