// Project explicitly registered tool attachments into ordinary assistant text.
// Keeping this separate from SDK messages preserves durable authorship identity.
export function attachmentMarkdown(attachment) {
  const name = String(attachment.name ?? '附件');
  const label = name.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ')
    .replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
  // encodeURIComponent leaves parentheses intact, but they delimit Markdown URLs.
  const encodedName = encodeURIComponent(name.toWellFormed())
    .replace(/\(/g, '%28').replace(/\)/g, '%29');
  const url = `${attachment.url}?name=${encodedName}`;
  return `${attachment.kind === 'image' ? '!' : ''}[${label}](${url})`;
}

function messageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.filter(part => part?.type === 'text')
    .map(part => typeof part.text === 'string' ? part.text : '').join('\n');
}

function renderedLinkTargets(text) {
  // These are the same code/link boundaries used by the small chat renderer.
  // A path in prose or code is not a delivered, clickable attachment card.
  const prose = text.replace(/(^```[^\n]*\n[\s\S]*?(?:\n```\s*(?:\n|$)|$))/gm, '');
  const markers = /`[^`\n]+`|\*\*[^*\n]+\*\*|!?\[(?:\\[^\r\n]|[^\]\\\r\n]){0,512}\]\(/g;
  const targets = [];
  let match;
  while ((match = markers.exec(prose))) {
    if (match[0].startsWith('`') || match[0].startsWith('**')) continue;
    const start = markers.lastIndex;
    let end = start;
    let depth = 1;
    const limit = Math.min(prose.length, start + 8192);
    for (; end < limit; end++) {
      if (prose[end] === '\n') break;
      if (prose[end] === '(') depth++;
      if (prose[end] === ')' && --depth === 0) break;
    }
    if (depth !== 0 || end === limit) continue;
    markers.lastIndex = end + 1;
    if ((prose.slice(0, match.index).match(/\\+$/)?.[0].length || 0) % 2) continue;
    const raw = prose.slice(start, end);
    const target = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
    if (!/[\u0000-\u0020\u007f<>\\#]/.test(target) && !/%(?![A-Fa-f0-9]{2})/.test(target)) targets.push(target);
  }
  return targets;
}

function isAttachmentTarget(target, baseUrl) {
  if (target === baseUrl) return true;
  // The '?' boundary prevents attachment a from matching a-longer-id or /download.
  if (!target.startsWith(`${baseUrl}?`)) return false;
  const query = new URLSearchParams(target.slice(baseUrl.length + 1));
  for (const key of query.keys()) {
    if (!['name', 'download'].includes(key) || query.getAll(key).length !== 1) return false;
  }
  if (query.has('download') && query.get('download') !== '1') return false;
  if (query.has('name')) {
    const name = query.get('name');
    if (!name.trim() || name.length > 512 || /[\u0000-\u001f\u007f/\\\u2028\u2029\u202a-\u202e\u2066-\u2069\ufffd]/.test(name)) return false;
  }
  return true;
}

function isFinalAssistant(message) {
  return message.role === 'assistant' && !message.errorMessage
    && !['error', 'aborted', 'toolUse'].includes(message.stopReason)
    && !(Array.isArray(message.content) && message.content.some(part => part?.type === 'toolCall'))
    && !(Array.isArray(message.toolCalls) && message.toolCalls.length);
}

function appendText(message, text) {
  if (typeof message.content === 'string') {
    return { ...message, content: message.content ? `${message.content}\n\n${text}` : text };
  }
  const parts = Array.isArray(message.content) ? message.content : [];
  return { ...message, content: [...parts, { type: 'text', text: `${messageText(message) ? '\n\n' : ''}${text}` }] };
}

/**
 * Return a public-text projection without mutating SDK messages. lookup must be
 * scoped by the caller to the authenticated business group; tool metadata alone
 * is never sufficient proof that an attachment belongs to this conversation.
 */
export function projectAttachmentMessages(messages, lookup) {
  const projected = [];
  const seenIds = new Set();
  const seenUrls = new Set();
  let pending = [];

  const flush = () => {
    if (!pending.length) return;
    const timestamp = pending.at(-1).timestamp;
    projected.push({
      role: 'assistant',
      content: [{ type: 'text', text: pending.map(item => attachmentMarkdown(item.attachment)).join('\n\n') }],
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
    pending = [];
  };

  for (const message of messages) {
    // Never allow an unfinished previous turn's attachments to land on a later
    // user's response. User objects themselves must remain Map-key identical.
    if (message.role === 'user') flush();

    if (message.role === 'toolResult' && message.toolName === 'attach_file' && !message.isError) {
      const id = message.details?.attachment?.id;
      if (typeof id === 'string' && id && !seenIds.has(id)) {
        let attachment;
        try { attachment = lookup(id); } catch { /* A denied/missing record stays private. */ }
        if (attachment?.id === id && typeof attachment.url === 'string' && attachment.url) {
          seenIds.add(id);
          if (!seenUrls.has(attachment.url)) {
            seenUrls.add(attachment.url);
            pending.push({ attachment, timestamp: message.timestamp });
          }
        }
      }
    }

    if (pending.length && isFinalAssistant(message)) {
      const targets = renderedLinkTargets(messageText(message));
      const missing = pending.filter(item => !targets.some(target => isAttachmentTarget(target, item.attachment.url)));
      projected.push(missing.length
        ? appendText(message, missing.map(item => attachmentMarkdown(item.attachment)).join('\n\n'))
        : message);
      pending = [];
    } else {
      projected.push(message);
    }
  }
  flush();
  return projected;
}
