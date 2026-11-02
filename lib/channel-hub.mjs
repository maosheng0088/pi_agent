import { ChannelService } from './channels.mjs';
import { WecomService } from './wecom-channels.mjs';
import { HttpError } from './security.mjs';

/** Keep each transport's credentials and actors inside its own service. */
export class ChannelHub {
  constructor(store, options = {}) {
    this.store = store; this.db = store.db;
    this.weixin = new ChannelService(store, options);
    this.wecom = new WecomService(store, { ...options.wecom, onMessage: options.onMessage, audit: options.audit });
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_channel_batches (
      message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,payload TEXT NOT NULL,targets TEXT NOT NULL,created_at TEXT NOT NULL);`);
  }
  _service(id) {
    try { this.weixin.get(id); return this.weixin; }
    catch (error) { if (error.status !== 404) throw error; }
    this.wecom.get(id); return this.wecom;
  }
  list() { return [...this.weixin.list(), ...this.wecom.list()]; }
  get(id) { return this._service(id).get(id); }
  create(body, actor) {
    const type = body.type ?? 'weixin';
    if (!['weixin', 'wecom'].includes(type)) throw new HttpError(400, '请选择个人微信或企业微信智能机器人。');
    return (type === 'wecom' ? this.wecom : this.weixin).create(body, actor);
  }
  update(id, body, actor) {
    const service = this._service(id);
    const allowed = service === this.wecom ? ['name', 'enabled', 'botId', 'secret', 'target'] : ['name', 'enabled'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, '渠道配置中包含不支持的字段。');
    return service.update(id, body, actor);
  }
  remove(id, actor) { return this._service(id).remove(id, actor); }
  _weixin(id) { if (this._service(id) !== this.weixin) throw new HttpError(400, '企业微信使用 Bot ID 和 Secret 连接。'); return this.weixin; }
  startLogin(id, actor) { return this._weixin(id).startLogin(id, actor); }
  loginStatus(id, loginId, actor, verifyCode) { return this._weixin(id).loginStatus(id, loginId, actor, verifyCode); }
  qrContent(id, loginId, actor) { return this._weixin(id).qrContent(id, loginId, actor); }
  _wecom(id) { if (this._service(id) !== this.wecom) throw new HttpError(400, '此操作仅适用于企业微信渠道。'); return this.wecom; }
  connect(id, actor) { return this._wecom(id).connect(id, actor); }
  conversations(id, actor) { return this._wecom(id).conversations(id, actor); }
  _split(ids) {
    if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new HttpError(400, '请选择不重复的消息渠道，最多 20 个。');
    const groups = { weixin: [], wecom: [] };
    for (const id of ids) groups[this._service(id) === this.weixin ? 'weixin' : 'wecom'].push(id);
    return groups;
  }
  validateBindings(ids, sessionId = null) {
    const groups = this._split(ids);
    this.weixin.validateBindings(groups.weixin, sessionId);
    this.wecom.validateBindings(groups.wecom, sessionId);
    return groups;
  }
  bind(sessionId, ids, actor) {
    const groups = this.validateBindings(ids, sessionId);
    this.weixin.bind(sessionId, groups.weixin, actor);
    this.wecom.bind(sessionId, groups.wecom, actor);
    return this.forSession(sessionId);
  }
  forSession(sessionId) { return [...this.weixin.forSession(sessionId), ...this.wecom.forSession(sessionId)]; }
  suspendSession(sessionId) {
    for (const row of this.db.prepare('SELECT id FROM im_channels WHERE session_id=?').all(sessionId)) this.weixin._revoke(row.id, '智能体已移入垃圾箱。');
    for (const row of this.db.prepare('SELECT id FROM wecom_channels WHERE session_id=?').all(sessionId)) this.wecom._revoke(row.id);
  }
  externalMembers(sessionId) {
    return [...this.weixin.forSession(sessionId).map(channel => ({ id: `weixin:${channel.id}`, channelId: channel.id,
      displayName: `微信 · ${channel.name}`, source: 'weixin', status: channel.status })), ...this.wecom.externalMembers(sessionId)];
  }
  assertActor(sessionId, actor) {
    if (actor?.source === 'weixin') return this.weixin.assertActor(sessionId, actor);
    if (actor?.source === 'wecom') return this.wecom.assertActor(sessionId, actor);
    throw new HttpError(403, '消息渠道身份无效。');
  }
  publish(sessionId, message) {
    const a = this.weixin.publish(sessionId, message), b = this.wecom.publish(sessionId, message);
    return { queued: (a?.queued || 0) + (b?.queued || 0) };
  }
  // Capture the recipients once. A later retry must never send old results to a
  // newly bound channel or a new remote recipient on the same channel.
  prepareTask(sessionId, message) {
    if (!message.messageId) throw new Error('任务投递缺少消息标识。');
    let batch = this.db.prepare('SELECT * FROM task_channel_batches WHERE message_id=?').get(message.messageId);
    if (!batch) {
      const targets = [];
      for (const [type, table, service] of [['weixin', 'im_channels', this.weixin], ['wecom', 'wecom_channels', this.wecom]]) {
        for (const row of this.db.prepare(`SELECT * FROM ${table} WHERE session_id=? AND enabled=1`).all(sessionId)) {
          if (type === 'weixin' ? service._authorized(row) : service._canAccess(row)) targets.push({ type, id: row.id, epoch: row.binding_epoch });
        }
      }
      this.db.prepare('INSERT INTO task_channel_batches VALUES (?,?,?,?,?)').run(message.messageId, sessionId, JSON.stringify(message), JSON.stringify(targets), new Date().toISOString());
      batch = this.db.prepare('SELECT * FROM task_channel_batches WHERE message_id=?').get(message.messageId);
    }
    if (batch.session_id !== sessionId) throw new HttpError(409, '任务投递目标不能变更。');
    return batch;
  }
  publishTask(sessionId, message) { return this._publishBatch(this.prepareTask(sessionId, message)); }
  _publishBatch(batch) {
    const message = JSON.parse(batch.payload), targets = JSON.parse(batch.targets);
    this.weixin.publish(batch.session_id, { ...message, waitForContext: true, onlyChannels: targets.filter(target => target.type === 'weixin') });
    this.wecom.publish(batch.session_id, { ...message, onlyChannels: targets.filter(target => target.type === 'wecom') });
    return this.deliveryStatus(batch.message_id);
  }
  deliveryStatus(messageId) {
    const batch = this.db.prepare('SELECT * FROM task_channel_batches WHERE message_id=?').get(messageId);
    if (!batch) return null;
    const targets = JSON.parse(batch.targets);
    const result = { queued: 0, sent: 0, failed: 0, pending: 0 };
    for (const target of targets) {
      const table = target.type === 'weixin' ? 'im_channel_outbox' : 'wecom_outbox';
      const rows = this.db.prepare(`SELECT status FROM ${table} WHERE channel_id=? AND binding_epoch=? AND (dedupe_key=? OR substr(dedupe_key,1,?)=?)`)
        .all(target.id, target.epoch, messageId, messageId.length + 1, `${messageId}:`);
      result.queued += rows.length;
      if (!rows.length) { result.failed++; continue; }
      for (const row of rows) result[['pending', 'sending'].includes(row.status) ? 'pending' : row.status === 'sent' ? 'sent' : 'failed']++;
    }
    return result;
  }
  retryDelivery(messageId) {
    const batch = this.db.prepare('SELECT * FROM task_channel_batches WHERE message_id=?').get(messageId);
    if (!batch) return null;
    for (const target of JSON.parse(batch.targets)) {
      const service = target.type === 'weixin' ? this.weixin : this.wecom;
      const table = target.type === 'weixin' ? 'im_channel_outbox' : 'wecom_outbox';
      const channelTable = target.type === 'weixin' ? 'im_channels' : 'wecom_channels';
      const row = this.db.prepare(`SELECT * FROM ${channelTable} WHERE id=?`).get(target.id);
      if (!row || !row.enabled || row.binding_epoch !== target.epoch || row.session_id !== batch.session_id
        || !(target.type === 'weixin' ? service._authorized(row) : service._canAccess(row))) continue;
      this.db.prepare(`UPDATE ${table} SET status='pending',attempts=0,next_attempt_at=0,last_error=NULL,finished_at=NULL
        WHERE channel_id=? AND binding_epoch=? AND status='failed' AND (dedupe_key=? OR substr(dedupe_key,1,?)=?)`)
        .run(target.id, target.epoch, messageId, messageId.length + 1, `${messageId}:`);
    }
    return this._publishBatch(batch);
  }
  invalidateUser(userId) { this.weixin.invalidateUser(userId); this.wecom.invalidateUser(userId); }
  start() { this.weixin.start(); this.wecom.start(); }
  close() {
    return this.closePromise ||= (async () => {
      const results = await Promise.allSettled([this.weixin.close(), this.wecom.close()]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
  }
}
