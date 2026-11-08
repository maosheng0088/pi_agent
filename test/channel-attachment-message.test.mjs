import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentMarkdown, channelAttachmentMessage } from '../lib/attachment-output.mjs';

const id = 'be50a803-8ef1-4e87-a444-6d0976ab99b4';
const imageId = '85e204d4-d6dd-49f2-841f-b45b17b8aafe';
const metadata = (key = id) => ({ id: key, name: key === id ? '报价[最终版].pdf' : '截图.png',
  size: 123, kind: key === id ? 'file' : 'image', mimeType: key === id ? 'application/pdf' : 'image/png',
  url: `/api/sessions/group-a/attachments/${key}` });
const lookup = key => { if (![id, imageId].includes(key)) throw new Error('not found'); return metadata(key); };

test('Webhook attachment preparation resolves same-group files and strips only their rendered links', () => {
  const file = metadata(), image = metadata(imageId);
  const link = attachmentMarkdown(file), picture = attachmentMarkdown(image);
  const code = `\`\`\`md\n${link}\n\`\`\`\n\n`;
  const original = { text: `${code}报告完成。\n\n${link}\n\n${picture}`, messageId: 'answer' };
  const prepared = channelAttachmentMessage('group-a', original, lookup);
  assert.equal(prepared.text, original.text, 'other transports keep their existing text');
  assert.equal(prepared.webhookText, `${code}报告完成。`);
  assert.deepEqual(prepared.attachments, [{ id }, { id: imageId }]);
  assert.ok(!('attachments' in original));
});

test('code, forged paths, remote URLs, other groups and missing attachments never become Webhook files', () => {
  for (const text of [
    `\`${attachmentMarkdown(metadata())}\``,
    `\`\`\`\n${attachmentMarkdown(metadata())}\n\`\`\``,
    `[f](https://example.com/api/sessions/group-a/attachments/${id})`,
    `[f](/api/sessions/group-b/attachments/${id})`,
    `[f](/api/sessions/group-a/attachments/${id}/download)`,
    `[f](/api/sessions/group-a/attachments/${id}?unexpected=1)`,
    `[f](/api/sessions/group-a/attachments/928b66dc-e658-4bcd-9a75-7b05f92e750b)`,
  ]) {
    const original = { text };
    assert.strictEqual(channelAttachmentMessage('group-a', original, lookup), original);
  }
});

test('explicit attachment-only messages use canonical IDs and are deduplicated against text links', () => {
  const result = channelAttachmentMessage('group-a', { text: attachmentMarkdown(metadata()),
    attachments: [{ id, url: 'https://untrusted.example/private', path: 'C:/private.txt' }, { id }, { id: '../private' }] }, lookup);
  assert.deepEqual(result.attachments, [{ id }]);
  assert.equal(result.webhookText, '');
  const only = channelAttachmentMessage('group-a', { text: '', attachments: [{ id: imageId }] }, lookup);
  assert.equal(only.webhookText, ''); assert.deepEqual(only.attachments, [{ id: imageId }]);
});
