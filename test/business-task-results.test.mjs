import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BusinessTaskService } from '../lib/business-tasks.mjs';
import { Store } from '../lib/store.mjs';

const fixtures = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    const relative = path.relative(os.tmpdir(), fixture.directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

async function fixture(configuration = {}, taskOverrides = {}, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-business-result-'));
  const cwd = path.join(directory, 'fixed-project');
  const resultDirectory = path.join(directory, 'private-results');
  await fs.mkdir(cwd);
  await fs.mkdir(resultDirectory);
  const scriptPath = path.join(cwd, 'entry.mjs');
  const registrationPath = path.join(cwd, 'registration.json');
  const executions = path.join(cwd, 'executions.jsonl');
  await fs.writeFile(registrationPath, JSON.stringify({ resultDirectory, executions, ...configuration }));
  await fs.writeFile(scriptPath, `
    import fs from 'node:fs';
    import path from 'node:path';
    const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const runId = process.env.PI_BUSINESS_RUN_ID;
    fs.appendFileSync(config.executions, JSON.stringify({runId, legacyRunId:process.env.RPAC_EXECUTION_ID})+'\\n');
    console.log('PRIVATE-DIAGNOSTIC-OUTPUT');
    const file = path.join(config.resultDirectory, runId+'.json');
    const result = {schemaVersion:1,runId,status:'completed',summary:'已完成全部账号检查，发现 2 条 UnitCount 为 0 的预约。',counts:{checked:8,anomalies:2},findings:[{privateDiagnostic:'PRIVATE-RAW-REPORT'}],...config.resultOverrides};
    if (config.mode === 'directory') fs.mkdirSync(file);
    else if (config.mode === 'symlink') {
      const target = path.join(config.resultDirectory, 'linked-target.json');
      fs.writeFileSync(target, JSON.stringify(result));
      fs.symlinkSync(target,file,'file');
    } else if (config.mode === 'raw') fs.writeFileSync(file, config.raw);
    else if (config.mode === 'invalid-utf8') fs.writeFileSync(file, Buffer.concat([Buffer.from(JSON.stringify(result).slice(0,-1)+',"extra":"'),Buffer.from([255]),Buffer.from('"}')]));
    else if (config.mode === 'oversize') fs.writeFileSync(file, JSON.stringify({...result,unused:'x'.repeat(1024*1024)}));
    else if (config.mode !== 'missing') {
      fs.writeFileSync(file+'.tmp', JSON.stringify(result));
      fs.renameSync(file+'.tmp',file);
    }
    process.exitCode=config.exitCode??0;
  `);
  const store = new Store(path.join(directory, '.data'), cwd);
  const task = { id: 'unit-count-fixture', name: 'UnitCount 检查', source: 'local', pythonPath: process.execPath, scriptPath, registrationPath, cwd, resultDirectory, claimScope: 'occurrence', timeoutSeconds: 10, ...taskOverrides };
  const service = new BusinessTaskService(store, { tasks: [task], ...options });
  const result = { directory, cwd, resultDirectory, scriptPath, registrationPath, executions, store, task, service };
  fixtures.push(result);
  return result;
}

test('opt-in completed reports deliver only the business summary, including real anomalies', async () => {
  const f = await fixture();
  const result = await f.service.run(f.task.id, { runId: 'abnormal-complete' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.logId, 'abnormal-complete');
  assert.match(result.reply, /发现 2 条 UnitCount 为 0/);
  assert.doesNotMatch(result.reply, /执行成功|PRIVATE-|schemaVersion|findings|private-results|fixed-project/);
  const execution = JSON.parse((await fs.readFile(f.executions, 'utf8')).trim());
  assert.deepEqual(execution, { runId: 'abnormal-complete', legacyRunId: 'abnormal-complete' });
  assert.equal(f.store.db.prepare('SELECT status FROM business_execution_claims WHERE run_id=?').get(result.logId).status, 'succeeded');
  assert.match((await f.service.readLog(result.logId)).content, /PRIVATE-DIAGNOSTIC-OUTPUT/);
});

test('shareable summaries use configured credential redaction and hide local diagnostic paths', async () => {
  const f = await fixture({ resultOverrides: { summary: '检查完成。token=PRIVATE-SECRET\n诊断 D:\\private\\cookie.json\n文件 /home/private/registration.json\n共享 \\\\fileserver\\private\\cookie.json' } }, {}, {
    redact: value => String(value).replaceAll('PRIVATE-SECRET', '[redacted]'),
  });
  const result = await f.service.run(f.task.id, { runId: 'redacted-report' });
  assert.match(result.reply, /检查完成/);
  assert.match(result.reply, /\[redacted\]/);
  assert.match(result.reply, /\[内部路径\]/);
  assert.doesNotMatch(result.reply, /PRIVATE-SECRET|cookie\.json|fileserver|registration\.json|D:\\private|\/home\/private/);
});

for (const [label, status, exitCode] of [['partial with nonzero exit', 'partial', 2], ['failed with nonzero exit', 'failed', 2], ['partial despite zero exit', 'partial', 0], ['completed despite nonzero exit', 'completed', 7]]) {
  test(`${label} cannot appear as a successful business check`, async () => {
    const f = await fixture({ resultOverrides: { status, summary: '8 个账号中 2 个登录失败，其余账号已检查。' }, exitCode });
    await assert.rejects(f.service.run(f.task.id, { runId: 'incomplete-result' }), error => {
      assert.equal(error.logId, 'incomplete-result');
      assert.equal(error.exitCode, exitCode);
      assert.match(error.message, /2 个登录失败/);
      assert.match(error.message, /未完整完成/);
      assert.doesNotMatch(error.message, /PRIVATE-|private-results|fixed-project/);
      return true;
    });
    assert.equal(f.store.db.prepare('SELECT status FROM business_execution_claims WHERE run_id=?').get('incomplete-result').status, 'failed');
    assert.match((await f.service.readLog('incomplete-result')).content, /PRIVATE-DIAGNOSTIC-OUTPUT/);
  });
}

for (const [label, configuration] of [
  ['missing', { mode: 'missing' }],
  ['malformed JSON', { mode: 'raw', raw: '{PRIVATE-RAW-REPORT' }],
  ['invalid UTF-8', { mode: 'invalid-utf8' }],
  ['wrong schema version', { resultOverrides: { schemaVersion: 2 } }],
  ['another run identity', { resultOverrides: { runId: 'previous-run' } }],
  ['unknown status', { resultOverrides: { status: 'success' } }],
  ['empty summary', { resultOverrides: { summary: ' \n\t' } }],
  ['non-string summary', { resultOverrides: { summary: { token: 'PRIVATE-SECRET' } } }],
  ['summary larger than 16 KiB', { resultOverrides: { summary: '中'.repeat(6000) } }],
  ['file larger than 1 MiB', { mode: 'oversize' }],
  ['nonregular result file', { mode: 'directory' }],
]) {
  test(`${label} result fails closed without sharing raw data or a false normal result`, async () => {
    const f = await fixture(configuration);
    await assert.rejects(f.service.run(f.task.id, { runId: 'untrusted-result' }), error => {
      assert.equal(error.logId, 'untrusted-result');
      assert.match(error.message, /不能判定为成功/);
      assert.doesNotMatch(error.message, /PRIVATE-|private-results|fixed-project|previous-run|schemaVersion/);
      return true;
    });
    assert.equal(f.store.db.prepare('SELECT status FROM business_execution_claims WHERE run_id=?').get('untrusted-result').status, 'failed');
    assert.match((await f.service.readLog('untrusted-result')).content, /PRIVATE-DIAGNOSTIC-OUTPUT/);
  });
}

test('a preexisting per-run report is rejected before launching and is never mistaken for fresh output', async () => {
  const f = await fixture({ mode: 'missing' });
  const file = path.join(f.resultDirectory, 'stale-output.json');
  const stale = JSON.stringify({ schemaVersion: 1, runId: 'stale-output', status: 'completed', summary: 'OLD FALSE NORMAL RESULT' });
  await fs.writeFile(file, stale);
  await assert.rejects(f.service.run(f.task.id, { runId: 'stale-output' }), error => {
    assert.equal(error.logId, 'stale-output');
    assert.match(error.message, /拒绝使用旧结果/);
    assert.doesNotMatch(error.message, /OLD FALSE|private-results/);
    return true;
  });
  await assert.rejects(fs.stat(f.executions), { code: 'ENOENT' });
  assert.equal(await fs.readFile(file, 'utf8'), stale);
});

test('a summary at the 16 KiB byte limit is preserved without reading or sending report metadata', async () => {
  const summary = 'A'.repeat(16 * 1024);
  const f = await fixture({ resultOverrides: { summary } });
  const result = await f.service.run(f.task.id, { runId: 'maximum-summary' });
  assert.equal(result.reply, `业务任务：${f.task.name}\n${summary}`);
  assert.equal(result.exitCode, 0);
});

test('symbolic result files cannot expose another file as a business summary', async t => {
  const f = await fixture({ mode: 'symlink' });
  const probe = path.join(f.directory, 'symlink-probe');
  try { await fs.symlink(f.registrationPath, probe, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This Windows account cannot create file symlinks.'); return; } throw error; }
  await fs.unlink(probe);
  await assert.rejects(f.service.run(f.task.id, { runId: 'linked-result' }), error => error.logId === 'linked-result' && /不能判定为成功/.test(error.message));
});

test('four scheduled occurrences and manual rechecks can run on one day while repeats stay claimed after restart', async () => {
  const f = await fixture({}, {}, { now: () => new Date('2026-10-29T12:00:00Z') });
  const times = ['2026-10-29T04:00:00+08:00', '2026-10-29T09:30:00+08:00', '2026-10-29T14:00:00+08:00', '2026-10-29T18:00:00+08:00'];
  for (const [index, scheduledFor] of times.entries()) assert.equal((await f.service.run(f.task.id, { runId: `scheduled-${index}`, scheduledFor })).exitCode, 0);
  const restarted = new BusinessTaskService(f.store, { tasks: [f.task] });
  for (const [index, scheduledFor] of times.entries()) assert.equal((await restarted.run(f.task.id, { runId: `duplicate-${index}`, scheduledFor: new Date(scheduledFor).toISOString() })).skipped, true);
  assert.equal((await restarted.run(f.task.id, { runId: 'manual-first' })).exitCode, 0);
  assert.equal((await restarted.run(f.task.id, { runId: 'manual-second' })).exitCode, 0);
  const executions = (await fs.readFile(f.executions, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(executions.length, 6);
  assert.equal((await restarted.run(f.task.id, { runId: 'manual-second' })).skipped, true);
  await assert.rejects(restarted.run(f.task.id, { runId: 'invalid-occurrence', scheduledFor: '../registration.json' }), /定时执行时间无效/);
});

test('legacy tasks retain daily deduplication and generic summaries unless explicitly opted in', async () => {
  const f = await fixture({ mode: 'missing' }, { resultDirectory: undefined, claimScope: undefined }, { now: () => new Date('2026-10-29T04:00:00Z') });
  const first = await f.service.run(f.task.id, { runId: 'legacy-first', scheduledFor: '2026-10-29T01:00:00Z' });
  assert.equal(first.exitCode, 0);
  assert.match(first.reply, /执行成功/);
  assert.doesNotMatch(first.reply, /UnitCount 为 0|PRIVATE-/);
  assert.equal((await f.service.run(f.task.id, { runId: 'legacy-second', scheduledFor: '2026-10-29T10:00:00Z' })).skipped, true);
  assert.equal((await f.service.run(f.task.id, { runId: 'legacy-manual' })).skipped, true);
  assert.equal(f.store.db.prepare('SELECT business_day FROM business_execution_claims WHERE run_id=?').get('legacy-first').business_day, '2026-10-29');
});

test('result locations and claim scopes are trusted server configuration, absent directories are not ready', async () => {
  const f = await fixture();
  assert.deepEqual(f.service.list(), [{ id: f.task.id, name: f.task.name, source: 'local', projectVersion: null, timeoutSeconds: 10, ready: true }]);
  assert.throws(() => new BusinessTaskService(f.store, { tasks: [{ ...f.task, resultDirectory: 'relative/results' }] }), /固定绝对路径/);
  assert.throws(() => new BusinessTaskService(f.store, { tasks: [{ ...f.task, claimScope: 'unrestricted' }] }), /去重范围配置无效/);
  await fs.rmdir(f.resultDirectory);
  assert.equal(f.service.list()[0].ready, false);
  await assert.rejects(f.service.run(f.task.id, { runId: 'missing-environment' }), { status: 409 });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM business_execution_claims').get().count, 0);
});
