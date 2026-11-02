import { createHash } from 'node:crypto';
import { createConnection, isIP } from 'node:net';

export const EMAIL_LIMITS = Object.freeze({ timeoutMs: 30_000, pageSize: 50, searchMatches: 10_000,
  folders: 200, bodyBytes: 1024 * 1024, bodyCharacters: 120_000, attachmentBytes: 20 * 1024 * 1024,
  attachmentCount: 20, recipients: 50, subjectCharacters: 1000 });

export class EmailAdapterError extends Error {
  constructor(code, message, status = 502) { super(message); this.name = 'EmailAdapterError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => new EmailAdapterError(code, message, status);
const invalid = message => fail('invalid_arguments', message || '邮件参数无效。', 400);
const missing = () => fail('not_found', '邮件或附件已不存在，请重新查询。', 404);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value, allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
}
function line(value, maximum = 1000, required = false) {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f\x7f]/.test(value) || required && !value.trim()) throw invalid();
  return value;
}
function address(value) {
  line(value, 320, true);
  if (!/^[^\s<>@,;"\\]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) || value.includes('..')) throw invalid('请使用有效的邮箱地址，不要包含显示名或多个地址。');
  return value;
}
function host(value) {
  line(value, 253, true);
  if (!isIP(value) && (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) || value.includes('..'))) throw invalid('邮件服务器地址无效。');
  return value;
}
function endpoint(value, defaultPort) {
  if (!plain(value)) throw invalid('请配置邮件服务器。');
  const port = value.port ?? defaultPort;
  const tls = value.tls ?? (port === 587 || port === 143 ? 'starttls' : 'implicit');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['implicit', 'starttls'].includes(tls)
    || port === 465 && tls !== 'implicit' || port === 587 && tls !== 'starttls' || port === 993 && tls !== 'implicit') throw invalid('邮件端口与加密方式不匹配；必须使用 TLS 或强制 STARTTLS。');
  return { host: host(value.host), port, tls, username: line(value.username, 320, true) };
}
function configuration(config) {
  if (!plain(config)) throw invalid();
  return { email: address(config.email), fromName: config.fromName ? line(config.fromName, 200) : '', allowSend: config.allowSend === true,
    imap: endpoint(config.imap, 993), smtp: config.smtp ? endpoint(config.smtp, 465) : null };
}
function password(credentials, protocol) {
  const value = credentials?.[`${protocol}Password`];
  if (typeof value !== 'string' || !value || value.length > 16_000 || /[\0\r\n]/.test(value)) throw fail('credentials_required', '请先由管理员配置邮箱授权密码。', 401);
  return value;
}
function safeError(error, signal, submitted = false) {
  if (submitted && !(error instanceof EmailAdapterError && error.code === 'send_rejected')) return fail('send_unknown', '邮件发送结果尚未确认，可能已被服务器接受。请检查已发送记录，勿自动重试。', 502);
  if (signal?.aborted) return signal.reason?.name === 'TimeoutError' ? fail('timeout', '邮件服务响应超时，请稍后重试。', 504) : new DOMException('邮件操作已取消。', 'AbortError');
  if (error instanceof EmailAdapterError) return error;
  if (error?.name === 'AbortError') return new DOMException('邮件操作已取消。', 'AbortError');
  if (error?.authenticationFailed || error?.code === 'EAUTH' || error?.responseCode === 535 || error?.responseStatus === 'NO' && error?.serverResponseCode === 'AUTHENTICATIONFAILED') return fail('credentials_required', '邮箱认证失败，请管理员检查账号、授权密码及 IMAP/SMTP 开关。', 401);
  if (['ETIMEDOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'ETIMEOUT', 'LockTimeout'].includes(error?.code)) return fail('timeout', '邮件服务响应超时，请稍后重试。', 504);
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String(error?.code || ''))) return fail('tls_error', '邮件服务器的 TLS 证书或加密连接验证失败。', 502);
  if (['LiteralTooLarge', 'ResponseTooLarge', 'LineTooLarge'].includes(error?.code)) return fail('output_limit', '邮箱返回内容过大，请缩小查询范围。', 413);
  return fail('provider_error', '邮件服务调用失败，请检查服务器配置、邮箱权限或稍后重试。', 502);
}
function folderName(value = 'INBOX') { return line(value, 1000, true); }
function uid(value) {
  if (typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value)) value = Number(value);
  if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) throw invalid('邮件 UID 无效。'); return value;
}
function validity(value) {
  const output = String(value ?? '');
  if (!/^[1-9]\d{0,9}$/.test(output) || Number(output) > 0xffffffff) throw fail('provider_error', '邮箱未返回有效的 UIDVALIDITY，无法稳定定位邮件。', 502);
  return output;
}
function assertValidity(client, expected) {
  const current = validity(client.mailbox?.uidValidity);
  if (expected !== undefined && String(expected) !== current) throw fail('stale_mailbox', '邮箱的邮件编号已重置，请重新查询后再打开。', 409);
  return current;
}
const clipped = (value, max = 1000) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max);
function addresses(values) {
  return (Array.isArray(values) ? values : []).slice(0, EMAIL_LIMITS.recipients).flatMap(value => value?.address ? [{ name: clipped(value.name, 200), address: clipped(value.address, 320) }] : value?.group ? addresses(value.group) : []).slice(0, EMAIL_LIMITS.recipients);
}
function iso(value) { const date = value instanceof Date ? value : new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function structure(root) {
  const attachments = [], plainParts = [], htmlParts = []; let count = 0;
  function visit(node, fallback = '1', depth = 0, attached = false) {
    if (!node || typeof node !== 'object') return;
    if (++count > 300 || depth > 20) throw fail('output_limit', '邮件 MIME 结构过于复杂。', 413);
    const type = String(node.type || 'application/octet-stream').toLowerCase();
    const disposition = String(node.disposition || '').toLowerCase();
    const name = node.dispositionParameters?.filename || node.parameters?.name;
    const isAttachment = attached || disposition === 'attachment' || Boolean(name) || type === 'message/rfc822';
    const part = typeof node.part === 'string' && /^\d+(?:\.\d+)*$/.test(node.part) ? node.part : fallback;
    if (isAttachment && !attached) {
      attachments.push({ part, name: clipped(name || `attachment-${part}`, 255).replace(/[\\/]/g, '_'), mimeType: clipped(type, 200),
        size: Number.isSafeInteger(node.size) && node.size >= 0 ? node.size : null, inline: disposition === 'inline', sizeIsEncoded: true });
      if (attachments.length > EMAIL_LIMITS.attachmentCount) throw fail('output_limit', '邮件附件数量超过单次处理上限。', 413);
      return;
    }
    if (Array.isArray(node.childNodes)) node.childNodes.forEach((child, index) => visit(child, node.part ? `${node.part}.${index + 1}` : `${index + 1}`, depth + 1, isAttachment));
    else if (!isAttachment && type === 'text/plain') plainParts.push({ part, size: node.size });
    else if (!isAttachment && type === 'text/html') htmlParts.push({ part, size: node.size });
  }
  visit(root);
  return { attachments, bodies: plainParts.length ? plainParts : htmlParts, bodyType: plainParts.length ? 'text/plain' : 'text/html' };
}
function summary(message) {
  const envelope = message.envelope || {}, flags = message.flags instanceof Set ? message.flags : new Set(message.flags || []);
  return { uid: uid(message.uid), subject: clipped(envelope.subject, EMAIL_LIMITS.subjectCharacters), from: addresses(envelope.from), to: addresses(envelope.to), cc: addresses(envelope.cc),
    date: iso(envelope.date || message.internalDate), messageId: clipped(envelope.messageId, 1000), size: Number.isSafeInteger(message.size) ? message.size : null,
    seen: flags.has('\\Seen'), hasAttachments: structure(message.bodyStructure).attachments.length > 0 };
}
function queryObject(value = {}) {
  keys(value, ['from', 'to', 'subject', 'text', 'since', 'before', 'unseen']);
  const query = { deleted: false };
  for (const key of ['from', 'to', 'subject', 'text']) if (value[key] !== undefined) query[key] = line(value[key], 1000, true);
  for (const key of ['since', 'before']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value[key]) || iso(`${value[key]}T00:00:00Z`)?.slice(0, 10) !== value[key]) throw invalid('日期格式应为 YYYY-MM-DD。');
    query[key] = value[key];
  }
  if (value.unseen !== undefined) { if (typeof value.unseen !== 'boolean') throw invalid(); query.seen = !value.unseen; }
  if (query.since && query.before && query.since >= query.before) throw invalid('开始日期必须早于结束日期。');
  return query;
}
function cursorData(cursor, fingerprint) {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1500}$/.test(cursor)) throw invalid('邮件分页游标无效。');
  let value; try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw invalid('邮件分页游标无效。'); }
  keys(value, ['v', 'fingerprint', 'uidValidity', 'snapshotUid', 'beforeUid']);
  if (value.v !== 1 || value.fingerprint !== fingerprint) throw invalid('分页条件已变化，请重新查询。');
  uid(value.snapshotUid); uid(value.beforeUid); validity(value.uidValidity);
  if (value.beforeUid > value.snapshotUid) throw invalid('邮件分页游标无效。');
  return value;
}
function draftMessage(config, draft) {
  keys(draft, ['to', 'cc', 'bcc', 'subject', 'text', 'attachments', 'inReplyTo', 'references']);
  const output = { from: { address: config.email, name: config.fromName }, disableFileAccess: true, disableUrlAccess: true };
  let recipients = 0;
  for (const key of ['to', 'cc', 'bcc']) {
    if (draft[key] === undefined && key !== 'to') continue;
    if (!Array.isArray(draft[key]) || draft[key].length === 0 && key === 'to') throw invalid('请填写收件人邮箱。');
    recipients += draft[key].length; output[key] = draft[key].map(value => ({ address: address(value) }));
  }
  if (recipients > EMAIL_LIMITS.recipients) throw invalid('单封邮件收件人不能超过 50 个。');
  output.subject = line(draft.subject, EMAIL_LIMITS.subjectCharacters, true);
  if (typeof draft.text !== 'string' || !draft.text.trim() || draft.text.length > EMAIL_LIMITS.bodyCharacters || draft.text.includes('\0')) throw invalid('邮件正文为空或超过 120000 字符。');
  output.text = draft.text;
  for (const key of ['inReplyTo', 'references']) if (draft[key] !== undefined) {
    const values = key === 'references' ? draft[key] : [draft[key]];
    if (!Array.isArray(values) || values.length > 50 || values.some(value => typeof value !== 'string' || !/^<[^<>\s\x00-\x1f]{1,990}>$/.test(value))) throw invalid('邮件引用标识无效。');
    output[key] = draft[key];
  }
  if (draft.attachments !== undefined) {
    if (!Array.isArray(draft.attachments) || draft.attachments.length > EMAIL_LIMITS.attachmentCount) throw invalid('邮件附件数量过多。');
    let total = 0;
    output.attachments = draft.attachments.map(value => {
      keys(value, ['name', 'mimeType', 'content']); line(value.name, 255, true);
      if (/[\\/]/.test(value.name) || !(value.content instanceof Uint8Array)) throw invalid('邮件附件只能使用已授权的文件内容，不接受路径或 URL。');
      total += value.content.byteLength;
      if (total > EMAIL_LIMITS.attachmentBytes) throw fail('output_limit', '邮件附件总大小不能超过 20 MiB。', 413);
      const type = value.mimeType ?? 'application/octet-stream';
      if (typeof type !== 'string' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(type)) throw invalid('附件类型无效。');
      return { filename: value.name, contentType: type, content: Buffer.from(value.content), contentDisposition: 'attachment' };
    });
  }
  return output;
}

export function createEmailAdapter({ deps = {} } = {}) {
  let loaded;
  async function dependencies() {
    if (!loaded) loaded = (async () => ({ ImapFlow: deps.ImapFlow || (await import('imapflow')).ImapFlow,
      createTransport: deps.createTransport || (await import('nodemailer')).default.createTransport,
      simpleParser: deps.simpleParser || (await import('mailparser')).simpleParser }))();
    return loaded;
  }
  async function operation(configValue, credentials, options, work, sending = false) {
    const config = configuration(configValue);
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(new DOMException('Timeout', 'TimeoutError')), deps.timeoutMs ?? EMAIL_LIMITS.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    const close = new Set(); let submitted = false;
    const stop = () => { for (const fn of close) try { fn(); } catch {} };
    signal.addEventListener('abort', stop, { once: true });
    const guard = async () => {
      signal.throwIfAborted();
      if (options.authorize || options.guard) {
        try { if (await (options.authorize || options.guard)() === false) throw new Error('denied'); }
        catch (error) { if (signal.aborted) signal.throwIfAborted(); throw fail('permission_denied', '当前账号已无权访问此邮箱。', 403); }
      }
      signal.throwIfAborted();
    };
    const race = promise => new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    try {
      await guard();
      const libraries = await race(dependencies());
      const result = await race(work({ config, credentials, signal, guard, race, close, libraries, markSubmitted: () => { submitted = true; } }));
      await guard(); return result;
    } catch (error) {
      const definiteFailure = !submitted || ['EAUTH', 'EENVELOPE', 'EDNS', 'ETLS'].includes(error?.code)
        || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String(error?.code || '')) || error?.code === 'send_rejected';
      const safe = safeError(error, signal, submitted && !definiteFailure);
      if (sending && definiteFailure) safe.delivery = 'not_sent';
      throw safe;
    }
    finally { clearTimeout(timer); signal.removeEventListener('abort', stop); stop(); }
  }
  async function imap(context, work, folder, expected) {
    const { config, credentials, guard, race, close, libraries } = context, settings = config.imap;
    const client = new libraries.ImapFlow({ host: settings.host, port: settings.port, secure: settings.tls === 'implicit',
      ...(settings.tls === 'starttls' ? { doSTARTTLS: true } : {}), auth: { user: settings.username, pass: password(credentials, 'imap') },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, logger: false, logRaw: false, emitLogs: false,
      disableAutoIdle: true, disableCompression: true, connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      maxLineLength: 1024 * 1024, maxLiteralSize: EMAIL_LIMITS.attachmentBytes + 1024 * 1024, maxResponseSize: EMAIL_LIMITS.attachmentBytes + 2 * 1024 * 1024 });
    const closeClient = () => client.close(); close.add(closeClient); client.on?.('error', () => {});
    let lock;
    try {
      await guard(); await race(client.connect()); await guard();
      if (client.secureConnection === false) throw fail('tls_error', '邮箱连接未受到 TLS 保护，已停止操作。', 502);
      if (folder !== undefined) { lock = await race(client.getMailboxLock(folder, { readOnly: true, acquireTimeout: 5000 })); assertValidity(client, expected); await guard(); }
      return await work(client);
    } finally {
      try { lock?.release(); } catch {} closeClient(); close.delete(closeClient);
    }
  }
  function smtp(context) {
    const settings = context.config.smtp;
    if (!settings) throw fail('not_configured', '此邮箱尚未配置 SMTP 发信服务。', 409);
    const transport = context.libraries.createTransport({ host: settings.host, port: settings.port, secure: settings.tls === 'implicit',
      requireTLS: settings.tls === 'starttls', ignoreTLS: false, opportunisticTLS: false, auth: { user: settings.username, pass: password(context.credentials, 'smtp') },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, pool: false, connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 20_000, dnsTimeout: 10_000,
      logger: false, debug: false, transactionLog: false, disableFileAccess: true, disableUrlAccess: true,
      getSocket(_options, callback) {
        // SMTPTransport.close() does not abort an active send. Own the underlying
        // fixed-endpoint socket so cancellation also stops connection/auth/DATA.
        let finished = false;
        const socket = (deps.createConnection || createConnection)({ host: settings.host, port: settings.port, signal: context.signal });
        const stop = () => socket.destroy(); context.close.add(stop);
        const finish = (error, value) => { if (finished) return; finished = true; callback(error, value); };
        socket.once('error', error => finish(error));
        socket.once('connect', () => {
          if (context.signal.aborted) { stop(); finish(context.signal.reason); }
          else finish(null, { connection: socket });
        });
        socket.once('close', () => { context.close.delete(stop); if (!finished) finish(new Error('connection_closed')); });
      } });
    context.close.add(() => transport.close()); return transport;
  }
  async function collect(context, stream, maximum, allowTruncate = false) {
    const chunks = []; let length = 0, truncated = false;
    const stop = () => stream.destroy?.(); context.close.add(stop);
    try {
      for await (const chunk of stream) {
        await context.guard(); const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += bytes.length;
        if (length > maximum) {
          if (!allowTruncate) throw fail('output_limit', '邮件附件超过 20 MiB 下载上限。', 413);
          chunks.push(bytes.subarray(0, bytes.length - (length - maximum))); truncated = true; break;
        }
        chunks.push(bytes);
      }
      await context.guard(); return { content: Buffer.concat(chunks), truncated };
    } finally { stop(); context.close.delete(stop); }
  }
  return {
    async check(config, credentials, options = {}) {
      return operation(config, credentials, options, async context => {
        await imap(context, async client => { if (client.authenticated === false) throw fail('credentials_required', '邮箱认证失败。', 401); });
        if (!context.config.smtp) return { imapReady: true, smtpReady: false, message: 'IMAP 收件验证通过；尚未配置 SMTP 发信服务。' };
        await context.guard(); const transport = smtp(context);
        if (await context.race(transport.verify()) !== true) throw fail('provider_error', 'SMTP 服务验证未通过。', 502);
        return { imapReady: true, smtpReady: true, message: 'IMAP 收件与 SMTP 身份验证通过；未发送测试邮件。' };
      });
    },
    async folders(config, credentials, options = {}) {
      return operation(config, credentials, options, context => imap(context, async client => {
        await context.guard(); const values = await context.race(client.list({ statusQuery: { messages: true, unseen: true, uidValidity: true } }));
        if (!Array.isArray(values)) throw fail('provider_error', '邮箱未返回有效的文件夹列表。', 502);
        return { folders: values.slice(0, EMAIL_LIMITS.folders).map(value => ({ path: clipped(value.path, 1000), name: clipped(value.name, 255), delimiter: clipped(value.delimiter, 10),
          specialUse: clipped(value.specialUse, 50), selectable: !new Set(value.flags || []).has('\\Noselect'),
          messages: Number.isSafeInteger(value.status?.messages) ? value.status.messages : null, unseen: Number.isSafeInteger(value.status?.unseen) ? value.status.unseen : null,
          uidValidity: value.status?.uidValidity ? String(value.status.uidValidity) : null })), truncated: values.length > EMAIL_LIMITS.folders };
      }));
    },
    async search(config, credentials, options = {}) {
      const folder = folderName(options.folder), query = queryObject(options.query), limit = options.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1 || limit > EMAIL_LIMITS.pageSize) return Promise.reject(invalid('每页邮件数应为 1 至 50。'));
      return operation(config, credentials, options, context => imap(context, async client => {
        const uidValidity = assertValidity(client), fingerprint = createHash('sha256').update(JSON.stringify([context.config.email, context.config.imap.host, context.config.imap.username, folder, query])).digest('hex');
        const cursor = options.cursor ? cursorData(options.cursor, fingerprint) : null;
        if (cursor && cursor.uidValidity !== uidValidity) throw fail('stale_mailbox', '邮箱编号已重置，请重新查询。', 409);
        const snapshotUid = cursor?.snapshotUid ?? Math.max(0, Number(client.mailbox?.uidNext || 1) - 1), upper = cursor ? cursor.beforeUid - 1 : snapshotUid;
        if (!Number.isSafeInteger(snapshotUid) || snapshotUid > 0xffffffff) throw fail('provider_error', '邮箱邮件编号无效。', 502);
        if (upper <= 0) return { folder, uidValidity, messages: [], nextCursor: null, truncated: false };
        await context.guard(); const matches = await context.race(client.search({ ...query, uid: `1:${upper}` }, { uid: true }));
        if (!Array.isArray(matches) || matches.some(value => !Number.isInteger(value) || value < 1 || value > upper)) throw fail('provider_error', '邮箱未返回有效的查询结果。', 502);
        if (matches.length > EMAIL_LIMITS.searchMatches) throw fail('output_limit', '匹配邮件超过 10000 封，请缩小日期或关键词范围。', 413);
        const ordered = [...new Set(matches)].sort((a, b) => b - a), selected = ordered.slice(0, limit), messages = [];
        if (selected.length) {
          await context.guard(); const result = await context.race(client.fetchAll(selected, { uid: true, envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true }, { uid: true }));
          if (!Array.isArray(result)) throw fail('provider_error', '邮箱未返回邮件摘要。', 502);
          const selectedSet = new Set(selected);
          for (const value of result) if (selectedSet.has(value.uid)) messages.push(summary(value));
          messages.sort((a, b) => b.uid - a.uid);
        }
        const nextCursor = ordered.length > limit ? Buffer.from(JSON.stringify({ v: 1, fingerprint, uidValidity, snapshotUid, beforeUid: selected.at(-1) })).toString('base64url') : null;
        return { folder, uidValidity, messages, nextCursor, truncated: false };
      }, folder));
    },
    async read(config, credentials, options = {}) {
      const folder = folderName(options.folder), messageUid = uid(options.uid);
      return operation(config, credentials, options, context => imap(context, async client => {
        await context.guard(); const message = await context.race(client.fetchOne(messageUid, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true }, { uid: true }));
        if (!message || message.uid !== messageUid) throw missing();
        const mime = structure(message.bodyStructure), warnings = [], text = []; let truncated = mime.bodies.length > 4;
        for (const body of mime.bodies.slice(0, 4)) {
          await context.guard(); const downloaded = await context.race(client.download(messageUid, body.part, { uid: true, maxBytes: EMAIL_LIMITS.bodyBytes + 1 }));
          if (!downloaded?.content) throw missing();
          const collected = await collect(context, downloaded.content, EMAIL_LIMITS.bodyBytes, true);
          truncated ||= collected.truncated || Number(body.size) > EMAIL_LIMITS.bodyBytes;
          if (mime.bodyType === 'text/plain') text.push(collected.content.toString('utf8'));
          else {
            const source = Buffer.concat([Buffer.from('Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'), collected.content]);
            const parsed = await context.race(context.libraries.simpleParser(source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: EMAIL_LIMITS.bodyBytes }));
            text.push(parsed.text || ''); warnings.push('HTML 邮件已转换为纯文本；未加载远程图片或返回可执行 HTML。');
          }
        }
        const joined = text.join('\n\n'); truncated ||= joined.length > EMAIL_LIMITS.bodyCharacters;
        if (!mime.bodies.length) warnings.push('邮件没有可提取的文字正文，请按需查看附件。');
        if (truncated) warnings.push('邮件正文超过单次阅读上限，已截断。');
        return { ...summary(message), folder, uidValidity: assertValidity(client), text: clipped(joined, EMAIL_LIMITS.bodyCharacters), attachments: mime.attachments, truncated, warnings: [...new Set(warnings)] };
      }, folder, options.uidValidity));
    },
    async downloadAttachment(config, credentials, options = {}) {
      const folder = folderName(options.folder), messageUid = uid(options.uid);
      if (typeof options.part !== 'string' || !/^\d+(?:\.\d+){0,19}$/.test(options.part) || options.part.length > 100) return Promise.reject(invalid('附件标识无效。'));
      return operation(config, credentials, options, context => imap(context, async client => {
        await context.guard(); const message = await context.race(client.fetchOne(messageUid, { uid: true, bodyStructure: true }, { uid: true }));
        if (!message || message.uid !== messageUid) throw missing();
        const attachment = structure(message.bodyStructure).attachments.find(value => value.part === options.part);
        if (!attachment) throw missing();
        await context.guard(); const downloaded = await context.race(client.download(messageUid, attachment.part, { uid: true, maxBytes: EMAIL_LIMITS.attachmentBytes + 1 }));
        if (!downloaded?.content) throw missing();
        const result = await collect(context, downloaded.content, EMAIL_LIMITS.attachmentBytes);
        return { ...attachment, folder, uid: messageUid, uidValidity: assertValidity(client), size: result.content.length, sizeIsEncoded: false, content: result.content };
      }, folder, options.uidValidity));
    },
    async send(config, credentials, options = {}) {
      return operation(config, credentials, options, async context => {
        if (!context.config.allowSend) throw fail('permission_denied', '管理员尚未开启此邮箱的发信权限。', 403);
        const draft = draftMessage(context.config, options.draft), transport = smtp(context);
        await context.guard(); context.markSubmitted();
        const result = await context.race(transport.sendMail(draft));
        const accepted = (result?.accepted || []).map(value => clipped(typeof value === 'string' ? value : value.address, 320));
        const rejected = (result?.rejected || []).map(value => clipped(typeof value === 'string' ? value : value.address, 320));
        if (!accepted.length) throw fail('send_rejected', 'SMTP 服务器未接受任何收件人，邮件未提交成功。', 502);
        return { status: rejected.length ? 'partially_accepted' : 'accepted', messageId: clipped(result.messageId, 1000), accepted, rejected,
          message: rejected.length ? '部分收件人已被 SMTP 接受，其余被拒收；请勿整封重复发送。' : '邮件已被 SMTP 服务器接受；最终送达情况以收件方或退信为准。' };
      }, true);
    },
  };
}
