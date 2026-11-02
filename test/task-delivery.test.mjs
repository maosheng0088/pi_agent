import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../lib/store.mjs';
import { TaskDeliveryService } from '../lib/task-delivery.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pi-task-delivery-'));
  const store = new Store(directory, directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const sent = [], posted = [];
  const service = new TaskDeliveryService(store, { publish: (id, message) => sent.push({ id, ...message }),
    onPosted: id => posted.push(id), ...options });
  return { store, service, sent, posted };
}
const input = (overrides = {}) => ({ schedule: { name: '每日报价', targetSessionId: 'sales-group' },
  run: { id: 'run-1' }, result: '已完成报价，共 12 条。', ...overrides });

test('posts only the final result and makes repeated completed delivery a no-op', async t => {
  let validations = 0;
  const { service, sent, posted } = fixture(t, { validateTarget: () => { validations++; } });
  const first = await service.deliver(input());
  assert.equal(first.status, 'delivered');
  assert.equal(first.targetSessionId, 'sales-group');
  assert.deepEqual(posted, ['sales-group']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].messageId, 'task:run-1');
  assert.equal(sent[0].authorName, 'Pi · 定时任务');
  assert.match(sent[0].text, /^定时任务：每日报价\n\n已完成报价/);
  assert.deepEqual(await service.retry(input({ schedule: { name: 'Changed', targetSessionId: 'wrong-group' } })), first);
  assert.equal(validations, 1);
  assert.equal(sent.length, 1);
  assert.equal(service.history('sales-group').length, 1);
  assert.equal(service.history('sales-group')[0].timestamp > 0, true);
  assert.deepEqual(service.context('sales-group'), service.history('sales-group'));
  assert.deepEqual(service.history('wrong-group'), []);
  assert.deepEqual(service.pending(), []);
});

test('keeps a durable group result when publishing fails and retries the original result only', async t => {
  let fail = true;
  const sent = [];
  const { service, posted } = fixture(t, { redact: value => String(value).replaceAll('secret', '[redacted]'),
    publish: (id, message) => { sent.push({ id, ...message }); if (fail) throw new Error('secret transport failure'); } });
  const failed = await service.deliver(input({ result: 'secret final result' }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, '[redacted] transport failure');
  assert.equal(service.history('sales-group').length, 1);
  assert.match(service.history('sales-group')[0].content, /\[redacted\] final result/);
  fail = false;
  const delivered = await service.retry(input({ result: 'unexpected replacement text' }));
  assert.equal(delivered.status, 'delivered');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual(posted, ['sales-group']);
  assert.equal(service.history('sales-group').length, 1);
});

test('never posts an unauthorized result and revalidates failed delivery before retry', async t => {
  let authorized = false;
  const { service, sent } = fixture(t, { validateTarget: (schedule, context) => {
    assert.equal(schedule.targetSessionId, 'sales-group');
    assert.equal(context.phase, 'delivery');
    if (!authorized) throw new Error('任务创建者已被移出业务群。');
  } });
  assert.equal((await service.deliver(input())).status, 'failed');
  assert.equal(sent.length, 0);
  assert.deepEqual(service.history('sales-group'), []);
  assert.equal((await service.retry(input())).status, 'failed');
  authorized = true;
  assert.equal((await service.retry(input())).status, 'delivered');
  assert.equal(sent.length, 1);
});

test('locks a pending or failed delivery to its first target group', async t => {
  let attempts = 0;
  const { service, sent } = fixture(t, { publish: () => { attempts++; throw new Error('offline'); } });
  await service.deliver(input());
  const changed = await service.retry(input({ schedule: { name: 'New name', targetSessionId: 'other-group' } }));
  assert.equal(changed.status, 'failed');
  assert.equal(changed.targetSessionId, 'sales-group');
  assert.match(changed.error, /不能变更/);
  assert.equal(attempts, 1);
  assert.deepEqual(service.history('other-group'), []);
  assert.equal(service.history('sales-group').length, 1);
  assert.deepEqual(sent, []);
});

test('does not require delivery for a legacy run without a business group', async t => {
  const { service, sent } = fixture(t, { validateTarget: () => assert.fail('No target should not be validated') });
  assert.equal((await service.deliver(input({ schedule: { name: 'Legacy' } }))).status, 'not_required');
  assert.equal(sent.length, 0);
  assert.deepEqual(service.pending(), []);
  assert.equal(service.get('unknown').status, 'not_required');
});

test('coalesces concurrent sends and exposes pending rows for crash recovery', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let sends = 0;
  const { service } = fixture(t, { publish: async () => { sends++; await blocked; } });
  const first = service.deliver(input());
  const second = service.deliver(input());
  assert.equal(first, second);
  assert.equal(sends, 1);
  assert.equal(service.pending()[0].runId, 'run-1');
  assert.equal(service.pending()[0].targetSessionId, 'sales-group');
  assert.equal(service.history('sales-group').length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(service.get('run-1').status, 'delivered');
  assert.deepEqual(service.pending(), []);
});
