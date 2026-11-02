import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentMarkdown, projectAttachmentMessages } from '../lib/attachment-output.mjs';

const file = (id, overrides = {}) => ({
  id, name: `${id}.pdf`, size: 123, mimeType: 'application/pdf', kind: 'file',
  url: `/api/attachments/${id}`, downloadUrl: `/api/attachments/${id}/download`, ...overrides,
});
const result = (id, overrides = {}) => ({
  role: 'toolResult', toolCallId: `call-${id}`, toolName: 'attach_file', isError: false,
  content: [{ type: 'text', text: 'registered' }], details: { attachment: { id } },
  timestamp: 20, ...overrides,
});
const assistant = (text, overrides = {}) => ({
  role: 'assistant', content: [{ type: 'text', text }], timestamp: 30, ...overrides,
});
const textOf = message => typeof message.content === 'string'
  ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const lookupFor = (...attachments) => id => attachments.find(attachment => attachment.id === id);
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

test('attachmentMarkdown uses the registered URL, preserves image/file semantics and escapes hostile names', () => {
  const name = 'report[final]\\2026\r\n![run](evil).pdf';
  const attachment = file('safe', { name, downloadUrl: 'https://untrusted.example/' });
  const encodedName = encodeURIComponent(name).replace(/\(/g, '%28').replace(/\)/g, '%29');
  assert.equal(attachmentMarkdown(attachment),
    `[report\\[final\\]\\\\2026 !\\[run\\](evil).pdf](/api/attachments/safe?name=${encodedName})`);
  assert.equal(attachmentMarkdown(file('image', { kind: 'image', name: '截图.png' })),
    `![截图.png](/api/attachments/image?name=${encodeURIComponent('截图.png')})`);
});

test('attaches files to the next final assistant while retaining intermediate SDK messages and content parts', () => {
  const user = { role: 'user', content: '生成报告', timestamp: 10 };
  const toolCall = assistant('正在生成', { content: [
    { type: 'text', text: '正在生成' }, { type: 'toolCall', id: 'call-a', name: 'attach_file', arguments: {} },
  ], stopReason: 'toolUse' });
  const tool = result('a');
  const reasoning = { type: 'thinking', thinking: 'internal' };
  const imagePart = { type: 'image', data: 'not-persisted-here', mimeType: 'image/png' };
  const final = assistant('报告已完成', { content: [reasoning, { type: 'text', text: '报告已完成' }, imagePart] });
  const messages = deepFreeze([user, toolCall, tool, final]);
  const before = JSON.stringify(messages);
  const projected = projectAttachmentMessages(messages, lookupFor(file('a')));

  assert.equal(projected.length, 4);
  assert.strictEqual(projected[0], user);
  assert.strictEqual(projected[1], toolCall);
  assert.strictEqual(projected[2], tool);
  assert.notStrictEqual(projected[3], final);
  assert.strictEqual(projected[3].content[0], reasoning);
  assert.strictEqual(projected[3].content[2], imagePart);
  assert.match(textOf(projected[3]), /报告已完成[\s\S]*\[a\.pdf\]\(\/api\/attachments\/a\?name=a\.pdf\)/);
  assert.equal(JSON.stringify(messages), before);
});

test('tool-only attachment output gets a standalone assistant at the end', () => {
  const tool = result('screen', { timestamp: 42 });
  const projected = projectAttachmentMessages([tool], lookupFor(file('screen', { kind: 'image', name: 'screen.png' })));
  assert.strictEqual(projected[0], tool);
  assert.deepEqual(projected[1], {
    role: 'assistant', timestamp: 42,
    content: [{ type: 'text', text: '![screen.png](/api/attachments/screen?name=screen.png)' }],
  });
});

test('pending attachments flush before the next user, not into the next turn', () => {
  const nextUser = { role: 'user', content: '另一个任务', timestamp: 50 };
  const nextFinal = assistant('第二轮完成', { timestamp: 60 });
  const projected = projectAttachmentMessages([result('a'), nextUser, nextFinal], lookupFor(file('a')));
  assert.equal(projected.length, 4);
  assert.equal(projected[1].role, 'assistant');
  assert.match(textOf(projected[1]), /\/api\/attachments\/a/);
  assert.strictEqual(projected[2], nextUser);
  assert.strictEqual(projected[3], nextFinal);
});

test('failed, aborted and tool-calling assistant messages do not consume pending files', () => {
  const error = assistant('', { errorMessage: 'error', stopReason: 'error' });
  const stopped = assistant('', { stopReason: 'aborted' });
  const calls = assistant('', { toolCalls: [{ id: 'call-next' }] });
  const final = assistant('完成');
  const projected = projectAttachmentMessages([result('a'), error, stopped, calls, final], lookupFor(file('a')));
  assert.strictEqual(projected[1], error);
  assert.strictEqual(projected[2], stopped);
  assert.strictEqual(projected[3], calls);
  assert.match(textOf(projected[4]), /\/api\/attachments\/a/);
  assert.equal(projected.length, 5);
});

test('deduplicates IDs and registered URLs, and preserves already linked finals unchanged', () => {
  const a = file('a');
  const sameUrl = file('b', { url: a.url });
  const linkedFinal = assistant(`请下载 ${attachmentMarkdown(a)}`);
  const laterFinal = assistant('后续');
  const messages = [result('a'), result('a'), result('b'), linkedFinal, result('a'), laterFinal];
  const projected = projectAttachmentMessages(messages, lookupFor(a, sameUrl));
  assert.equal(projected.length, messages.length);
  for (let index = 0; index < messages.length; index++) assert.strictEqual(projected[index], messages[index]);
  assert.equal(textOf(projected[3]).split('/api/attachments/a').length - 1, 1);
});

test('bare attachment URLs and code examples still receive a real Markdown attachment', () => {
  const a = file('a');
  const markdown = attachmentMarkdown(a);
  for (const content of [
    `文件地址：${a.url}`,
    `文件地址：${a.url}?name=a.pdf`,
    `示例：\`${a.url}\``,
    `示例：\`${markdown}\``,
    `\`\`\`markdown\n${markdown}\n\`\`\``,
  ]) {
    const final = assistant(content);
    const projected = projectAttachmentMessages([result('a'), final], lookupFor(a));
    assert.notStrictEqual(projected[1], final, content);
    assert.equal(projected[1].content.at(-1).text, `\n\n${markdown}`, content);
  }
});

test('valid Markdown file/image links deduplicate exact URLs and supported name queries', () => {
  const a = file('a');
  for (const content of [
    `[报告](${a.url})`,
    attachmentMarkdown(a),
    `![报告预览](${a.url}?name=preview.png)`,
    `[报告](<${a.url}?name=a.pdf&download=1>)`,
  ]) {
    const final = assistant(content);
    const projected = projectAttachmentMessages([result('a'), final], lookupFor(a));
    assert.strictEqual(projected[1], final, content);
    assert.deepEqual(projectAttachmentMessages(projected, lookupFor(a)), projected);
  }
});

test('a different URL prefix, escaped link or rejected query does not count as a delivered attachment', () => {
  const a = file('a');
  for (const content of [
    `[其他文件](${a.url}-other?name=a.pdf)`,
    `[其他路径](${a.url}/download)`,
    `\\[转义示例](${a.url})`,
    `[非法参数](${a.url}?other=1)`,
    `[非法名称](${a.url}?name=bad%2Fname.pdf)`,
    `[重复名称](${a.url}?name=a.pdf&name=b.pdf)`,
    `[无效百分号](${a.url}?name=bad%zz.pdf)`,
    `[不完整](${a.url}`,
  ]) {
    const final = assistant(content);
    const projected = projectAttachmentMessages([result('a'), final], lookupFor(a));
    assert.notStrictEqual(projected[1], final, content);
    assert.equal(projected[1].content.at(-1).text, `\n\n${attachmentMarkdown(a)}`, content);
  }
});

test('keeps successful attachment order and handles string/empty final content', () => {
  const projected = projectAttachmentMessages([result('b'), result('a'), assistant('', { content: '完成' })],
    lookupFor(file('a'), file('b')));
  assert.equal(projected[2].content,
    '完成\n\n[b.pdf](/api/attachments/b?name=b.pdf)\n\n[a.pdf](/api/attachments/a?name=a.pdf)');
  const empty = projectAttachmentMessages([result('a'), assistant('', { content: [] })], lookupFor(file('a')));
  assert.deepEqual(empty[1].content, [{ type: 'text', text: '[a.pdf](/api/attachments/a?name=a.pdf)' }]);
});

test('group-scoped missing/denied lookups and forged tool metadata cannot publish attachments', () => {
  const wrongGroup = result('private', { details: { attachment: {
    id: 'private', name: 'leak.txt', url: 'https://attacker.example/secret', kind: 'file',
  } } });
  const throwing = result('denied');
  const wrongId = result('mismatch');
  const failed = result('failed', { isError: true });
  const otherTool = result('other', { toolName: 'powershell' });
  const noId = result(undefined);
  const final = assistant('没有可分享的附件');
  const lookedUp = [];
  const messages = [wrongGroup, throwing, wrongId, failed, otherTool, noId, final];
  const projected = projectAttachmentMessages(messages, id => {
    lookedUp.push(id);
    if (id === 'denied') throw new Error('forbidden');
    if (id === 'mismatch') return file('different');
    return undefined;
  });
  assert.deepEqual(lookedUp, ['private', 'denied', 'mismatch']);
  assert.equal(projected.length, messages.length);
  for (let index = 0; index < messages.length; index++) assert.strictEqual(projected[index], messages[index]);
});

test('uses registry metadata only and ignores paths and native image parts from unrelated output', () => {
  const forged = result('a', { details: { attachment: { id: 'a', url: 'https://attacker.example/', name: 'wrong.exe' } } });
  const otherTool = result('path', { toolName: 'powershell', content: [{ type: 'text', text: 'D:\\private\\result.png' }] });
  const nativeImage = assistant('', { content: [{ type: 'image', data: 'raw-data', mimeType: 'image/png' }] });
  const untouched = projectAttachmentMessages([otherTool, nativeImage], () => { throw new Error('should not look up'); });
  assert.strictEqual(untouched[0], otherTool);
  assert.strictEqual(untouched[1], nativeImage);
  const projected = projectAttachmentMessages([forged, assistant('完成')], lookupFor(file('a')));
  assert.match(textOf(projected[1]), /\[a\.pdf\]\(\/api\/attachments\/a\?name=a\.pdf\)/);
  assert.doesNotMatch(textOf(projected[1]), /attacker|wrong\.exe/);
});

test('projection is idempotent for final and standalone attachment messages', () => {
  const lookup = lookupFor(file('a'));
  for (const messages of [[result('a')], [result('a'), assistant('完成')]]) {
    const once = projectAttachmentMessages(messages, lookup);
    const twice = projectAttachmentMessages(once, lookup);
    assert.deepEqual(twice, once);
    for (let index = 0; index < once.length; index++) assert.strictEqual(twice[index], once[index]);
  }
});
