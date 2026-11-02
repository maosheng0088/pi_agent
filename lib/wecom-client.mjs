import { WSClient } from '@wecom/aibot-node-sdk';
import { randomUUID } from 'node:crypto';

// Tencent's official SDK owns authentication, heartbeat, acknowledgements and reconnects.
// https://github.com/WecomTeam/aibot-node-sdk
const WS_URL = 'wss://openws.work.weixin.qq.com';
const SILENT_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

export class WecomError extends Error {
  constructor(message, { code = 'WECOM_ERROR' } = {}) {
    super(message);
    this.name = 'WecomError';
    this.code = code;
  }
}

function identifier(value, limit = 2048) {
  return typeof value === 'string' && value.length <= limit && !/[\u0000-\u0020\u007f]/.test(value) ? value : '';
}

function abortError() { return new DOMException('企业微信请求已取消。', 'AbortError'); }

function safeError(error) {
  if (error?.code === 'WS_AUTH_FAILURE_EXHAUSTED') {
    return new WecomError('企业微信认证失败，请检查 Bot ID 和 Secret。', { code: 'AUTH_FAILED' });
  }
  if (error?.code === 'WS_RECONNECT_EXHAUSTED') {
    return new WecomError('企业微信连接失败，请检查网络后重新连接。', { code: 'NETWORK_ERROR' });
  }
  return new WecomError('企业微信请求失败，请检查连接后重试。', { code: 'PROVIDER_ERROR' });
}

/** Accepts only human text callbacks addressed to the configured robot. */
export function normalizeWecomIncomingMessage(frame, botId) {
  if (!frame || frame.cmd !== 'aibot_msg_callback' || !frame.body || typeof frame.body !== 'object') return null;
  const body = frame.body;
  const messageId = identifier(body.msgid, 512);
  const userId = identifier(body.from?.userid);
  const requestId = identifier(frame.headers?.req_id, 512);
  const configuredBotId = identifier(botId);
  if (!messageId || !userId || !requestId || !configuredBotId || body.aibotid !== configuredBotId || userId === configuredBotId) return null;
  if (body.chattype !== 'single' && body.chattype !== 'group') return null;
  const targetId = body.chattype === 'group' ? identifier(body.chatid) : userId;
  if (!targetId) return null;
  let text;
  if (body.msgtype === 'text') text = body.text?.content;
  else if (body.msgtype === 'voice') text = body.voice?.content;
  else if (body.msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
    text = body.mixed.msg_item.filter(item => item?.msgtype === 'text' && typeof item.text?.content === 'string')
      .map(item => item.text.content).join('\n');
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 100000 || /\u0000/.test(text)) return null;
  const created = Number(body.create_time);
  return {
    messageId, userId, chatType: body.chattype, targetId, text,
    timestamp: Number.isFinite(created) && created > 0 ? (created < 1e12 ? created * 1000 : created) : Date.now(),
    botId: configuredBotId, requestId,
  };
}

export class WecomClient {
  #botId;
  #secret;
  #factory;
  #onMessage;
  #onState;
  #client = null;
  #connected = false;
  #closed = false;
  #fatal = false;
  #closing = new AbortController();

  constructor({ botId, secret, onMessage = () => {}, onState = () => {}, sdkFactory = options => new WSClient(options) } = {}) {
    this.#botId = identifier(typeof botId === 'string' ? botId.trim() : '', 2048);
    this.#secret = identifier(typeof secret === 'string' ? secret.trim() : '', 8192);
    if (!this.#botId || !this.#secret) throw new WecomError('请填写有效的企业微信 Bot ID 和 Secret。', { code: 'INVALID_CREDENTIALS' });
    if (typeof sdkFactory !== 'function' || typeof onMessage !== 'function' || typeof onState !== 'function') throw new TypeError('Invalid enterprise WeChat client callbacks');
    this.#factory = sdkFactory;
    this.#onMessage = onMessage;
    this.#onState = onState;
  }

  #state(status, lastError) {
    if (this.#closed) return;
    try { Promise.resolve(this.#onState({ status, ...(lastError ? { lastError } : {}) })).catch(() => {}); } catch {}
  }

  start() {
    if (this.#client) return this;
    this.#closed = false;
    this.#fatal = false;
    this.#closing = new AbortController();
    this.#state('connecting');
    let sdk;
    try {
      sdk = this.#factory({
        botId: this.#botId, secret: this.#secret, wsUrl: WS_URL,
        logger: SILENT_LOGGER, maxReconnectAttempts: -1, maxAuthFailureAttempts: 1,
        reconnectInterval: 1000, heartbeatInterval: 30000, requestTimeout: 10000,
      });
      this.#client = sdk;
      const active = () => !this.#closed && this.#client === sdk;
      sdk.on('connected', () => { if (active() && !this.#fatal) this.#state('connecting'); });
      sdk.on('authenticated', () => {
        if (!active() || this.#fatal) return;
        this.#connected = true;
        this.#state('connected');
      });
      sdk.on('reconnecting', () => {
        if (!active() || this.#fatal) return;
        this.#connected = false;
        this.#state('connecting');
      });
      sdk.on('disconnected', () => {
        if (!active()) return;
        this.#connected = false;
        if (!this.#fatal) this.#state('disconnected');
      });
      sdk.on('event.disconnected_event', () => {
        if (!active()) return;
        this.#connected = false;
        this.#fatal = true;
        this.#state('error', '该企业微信机器人已在其他位置连接，请断开其他连接后重试。');
      });
      sdk.on('error', error => {
        if (!active() || this.#fatal) return;
        this.#connected = false;
        if (error?.code === 'WS_AUTH_FAILURE_EXHAUSTED') this.#fatal = true;
        this.#state('error', safeError(error).message);
      });
      sdk.on('message', frame => {
        if (!active() || !this.#connected || this.#fatal) return;
        const message = normalizeWecomIncomingMessage(frame, this.#botId);
        if (!message) return;
        try { Promise.resolve(this.#onMessage(message)).catch(() => {}); } catch {}
      });
      sdk.connect();
      return this;
    } catch (error) {
      this.#connected = false;
      this.#client = null;
      try { sdk?.disconnect(); } catch {}
      sdk?.removeAllListeners?.();
      const failure = safeError(error);
      this.#state('error', failure.message);
      throw failure;
    }
  }

  async close() {
    this.#closed = true;
    this.#connected = false;
    this.#closing.abort();
    const sdk = this.#client;
    this.#client = null;
    if (!sdk) return;
    try { await sdk.disconnect(); } catch {} finally { sdk.removeAllListeners?.(); }
  }

  async sendText({ targetId, text, clientId = randomUUID(), signal } = {}) {
    if (signal?.aborted) throw abortError();
    const recipient = identifier(targetId);
    const id = identifier(clientId, 512);
    if (!recipient || !id || typeof text !== 'string' || !text.trim() || /\u0000/.test(text)) {
      throw new WecomError('企业微信消息内容或接收人无效。', { code: 'INVALID_MESSAGE' });
    }
    const sdk = this.#client;
    if (!sdk || !this.#connected || this.#closed || this.#fatal) throw new WecomError('企业微信尚未连接，请先连接机器人。', { code: 'NOT_CONNECTED' });
    const closed = this.#closing.signal;
    let onAbort;
    let onClose;
    try {
      const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(abortError());
        onClose = () => reject(new WecomError('企业微信连接已关闭。', { code: 'NOT_CONNECTED' }));
        signal?.addEventListener('abort', onAbort, { once: true });
        closed.addEventListener('abort', onClose, { once: true });
      });
      // sendMessage generates a fresh request ID; reply permits the persisted outbox ID.
      const result = await Promise.race([sdk.reply({ headers: { req_id: id } }, {
        chatid: recipient, msgtype: 'markdown', markdown: { content: text },
      }, 'aibot_send_msg'), interrupted]);
      if (result?.errcode !== 0) throw new WecomError('企业微信未确认消息发送成功。', { code: 'PROVIDER_ERROR' });
      return { clientId: id };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (closed.aborted) throw new WecomError('企业微信连接已关闭。', { code: 'NOT_CONNECTED' });
      throw error instanceof WecomError ? error : safeError(error);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      closed.removeEventListener('abort', onClose);
    }
  }
}
