import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

async function fixture(overrides = {}, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-business-'));
  const cwd = path.join(directory, '项目 with spaces');
  await fs.mkdir(cwd);
  const scriptPath = path.join(cwd, 'entry.mjs');
  const registrationPath = path.join(cwd, 'registration.json');
  const executions = path.join(cwd, 'executions.jsonl');
  const lateMarker = path.join(cwd, 'late-child.txt');
  await fs.writeFile(registrationPath, JSON.stringify({ mode: 'success', executions, lateMarker }));
  await fs.writeFile(scriptPath, `
    import fs from 'node:fs';
    import {spawn} from 'node:child_process';
    const registration = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    fs.appendFileSync(registration.executions, JSON.stringify({id: process.env.RPAC_EXECUTION_ID, attempt: process.env.RPAC_ATTEMPT, unbuffered: process.env.PYTHONUNBUFFERED, utf8: process.env.PYTHONUTF8, encoding: process.env.PYTHONIOENCODING, args: process.argv.slice(3), cwd: process.cwd()})+'\\n');
    if(registration.mode === 'hang') {
      const nested = spawn(process.execPath, ['-e', 'setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"unexpected descendant survived"),1200);setInterval(()=>{},1000)', registration.lateMarker], {stdio:'ignore'});
      await new Promise(resolve=>nested.once('spawn',resolve));
      console.log('grandchild-ready');
      setInterval(()=>{},1000);
    } else if(registration.mode === 'noisy') {
      for(let index=0;index<40;index++) process.stdout.write('NOISY-OUTPUT-'+index+'x'.repeat(2048)+'\\n');
      fs.writeFileSync(registration.lateMarker, 'task continued after log cap');
    } else if(registration.mode === 'fail') {
      console.error('VERY-PRIVATE-REGISTRATION-SECRET'); process.exit(7);
    } else {
      process.stdout.write('Business secret: SPLIT-');
      setTimeout(()=>{process.stdout.write('SECRET\\n中文业务已完成\\n');},5);
    }
  `);
  const store = new Store(path.join(directory, '.data'), cwd);
  const task = { id: 'fixture-project', name: 'Fixture 业务项目', source: 'RPAC', projectId: 'project-fixture', projectVersion: 5, pythonPath: process.execPath, scriptPath, registrationPath, cwd, timeoutSeconds: 10, ...overrides };
  const service = new BusinessTaskService(store, { tasks: [task], ...options });
  const result = { directory, cwd, scriptPath, registrationPath, executions, lateMarker, store, task, service };
  fixtures.push(result);
  return result;
}

test('loads a fixed server whitelist, exposes only safe public metadata, and refuses arbitrary IDs', async () => {
  const f = await fixture();
  assert.deepEqual(f.service.list(), [{ id: f.task.id, name: f.task.name, source: 'RPAC', projectVersion: 5, timeoutSeconds: 10, ready: true }]);
  assert.ok(Object.isFrozen(f.service.get(f.task.id)));
  assert.throws(() => f.service.get('other-project'), { status: 404 });
  assert.throws(() => f.service.get('../entry.mjs'), { status: 400 });
  assert.throws(() => new BusinessTaskService(f.store, { tasks: [{ ...f.task, pythonPath: 'python' }] }), /固定绝对路径/);
  assert.throws(() => new BusinessTaskService(f.store, { tasks: [{ ...f.task, scriptPath: path.join(f.directory, 'outside.mjs') }] }), /入口必须位于/);
  assert.throws(() => new BusinessTaskService(f.store, { tasks: [f.task, f.task] }), /重复编号/);
  await fs.writeFile(path.join(f.store.directory, 'business-tasks.json'), JSON.stringify({ tasks: [f.task] }));
  assert.equal(new BusinessTaskService(f.store).get(f.task.id).projectVersion, 5);
  const empty = new BusinessTaskService(f.store, { configFile: path.join(f.directory, 'absent.json') });
  assert.deepEqual(empty.list(), []);
});

test('runs a real fixed entry with stable execution identity, private logs, and a safe final summary', async () => {
  const f = await fixture({}, { redact: (value) => String(value).replaceAll('SPLIT-SECRET', '[redacted]') });
  const notices = [];
  const result = await f.service.run(f.task.id, { runId: 'real-execution-1', onLog: (notice) => notices.push(notice) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.logId, 'real-execution-1');
  assert.match(result.reply, /执行成功/);
  assert.ok(!result.reply.includes('SECRET'));
  assert.ok(!result.reply.includes(f.cwd));
  const execution = JSON.parse((await fs.readFile(f.executions, 'utf8')).trim());
  assert.deepEqual(execution.args, ['--mode', 'manual']);
  assert.equal(execution.id, 'real-execution-1');
  assert.equal(execution.attempt, '1');
  assert.equal(execution.unbuffered, '1');
  assert.equal(execution.utf8, '1');
  assert.equal(execution.encoding, 'utf-8');
  assert.equal(execution.cwd, f.cwd);
  assert.ok(notices.length);
  assert.ok(notices.every((notice) => Object.keys(notice).sort().join() === 'bytes,logId,stream'));
  const log = await f.service.readLog(result.logId);
  assert.match(log.content, /\[redacted\]/);
  assert.match(log.content, /中文业务已完成/);
  assert.ok(!log.content.includes('SPLIT-SECRET'));
  assert.equal(log.truncated, false);
  await assert.rejects(f.service.readLog('../config'), { status: 400 });
  assert.deepEqual(await f.service.readLog('missing-execution'), { content: '本次尚无执行日志（未启动或已跳过）。', truncated: false });
});

test('ordinary Python print output is readable before exit, including stderr and Chinese, despite inherited buffering settings', { timeout: 20_000 }, async (t) => {
  let pythonPath;
  for (const candidate of [...new Set([process.env.PI_TEST_PYTHON, 'python', 'python3', 'py'].filter(Boolean))]) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const executable = probe.stdout?.trim();
    if (!probe.error && probe.status === 0 && executable && path.isAbsolute(executable)) { pythonPath = executable; break; }
  }
  if (!pythonPath) { t.skip('Python interpreter unavailable; fixed-entry subprocess coverage remains enabled.'); return; }

  const f = await fixture({ pythonPath });
  const scriptPath = path.join(f.cwd, 'print-output.py');
  const releasePath = path.join(f.cwd, 'release-execution');
  await fs.writeFile(scriptPath, `
import json, os, pathlib, sys, time
registration = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
record = {'unbuffered': os.environ.get('PYTHONUNBUFFERED'), 'args': sys.argv[2:]}
pathlib.Path(registration['executions']).write_text(json.dumps(record), encoding='utf-8')
print('stdout: 中文运行中')
print('stderr: 中文告警', file=sys.stderr)
deadline = time.monotonic() + 10
while not pathlib.Path(registration['release']).exists():
    if time.monotonic() > deadline:
        raise RuntimeError('isolated test release was not received')
    time.sleep(0.02)
print('stdout: 程序结束')
`, 'utf8');
  await fs.writeFile(f.registrationPath, JSON.stringify({ executions: f.executions, release: releasePath }));
  const service = new BusinessTaskService(f.store, { tasks: [{ ...f.task, scriptPath }] });
  const previous = process.env.PYTHONUNBUFFERED;
  process.env.PYTHONUNBUFFERED = '0';
  const notices = [];
  let settled = false;
  const execution = service.run(f.task.id, { runId: 'python-print-live', onLog: notice => notices.push(notice) });
  execution.then(() => { settled = true; }, () => { settled = true; });
  try {
    let log;
    const deadline = Date.now() + 6000;
    do {
      log = await service.readLog('python-print-live');
      if (log.content.includes('stdout: 中文运行中') && log.content.includes('stderr: 中文告警')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (!settled && Date.now() < deadline);
    assert.match(log.content, /stdout: 中文运行中/);
    assert.match(log.content, /stderr: 中文告警/);
    assert.doesNotMatch(log.content, /程序结束|结束状态/);
    assert.equal(log.truncated, false);
    assert.equal(settled, false, 'program output must be readable before the process completes');
    assert.equal(f.store.db.prepare('SELECT status FROM business_execution_claims WHERE run_id=?').get('python-print-live').status, 'running');
    const record = JSON.parse(await fs.readFile(f.executions, 'utf8'));
    assert.equal(record.unbuffered, '1');
    assert.deepEqual(record.args, ['--mode', 'manual']);
    assert.ok(notices.some(notice => notice.stream === 'stdout'));
    assert.ok(notices.some(notice => notice.stream === 'stderr'));
    assert.ok(notices.every(notice => Object.keys(notice).sort().join() === 'bytes,logId,stream'));
    await fs.writeFile(releasePath, 'release');
    const result = await execution;
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.reply, /stdout:|stderr:|中文运行中|中文告警/);
    assert.match((await service.readLog('python-print-live')).content, /stdout: 程序结束/);
  } finally {
    if (previous === undefined) delete process.env.PYTHONUNBUFFERED;
    else process.env.PYTHONUNBUFFERED = previous;
    await fs.writeFile(releasePath, 'release');
    await execution.catch(() => {});
  }
});

test('claims each Beijing business day once across scheduled/manual calls and service restarts', async () => {
  let now = new Date('2026-10-28T16:01:00Z');
  const f = await fixture({}, { now: () => new Date(now) });
  const [first, duplicate] = await Promise.all([
    f.service.run(f.task.id, { runId: 'daily-first', scheduledFor: '2026-10-28T00:00:00Z' }),
    f.service.run(f.task.id, { runId: 'daily-concurrent' }),
  ]);
  assert.equal(first.exitCode, 0);
  assert.equal(duplicate.skipped, true);
  assert.match(first.reply, /2026-10-29/);
  const restarted = new BusinessTaskService(f.store, { tasks: [f.task], now: () => new Date(now) });
  assert.equal((await restarted.run(f.task.id, { runId: 'daily-restart' })).skipped, true);
  assert.equal((await fs.readFile(f.executions, 'utf8')).trim().split('\n').length, 1);
  now = new Date('2026-10-29T16:01:00Z');
  assert.equal((await restarted.run(f.task.id, { runId: 'next-business-day' })).exitCode, 0);
  assert.equal((await fs.readFile(f.executions, 'utf8')).trim().split('\n').length, 2);
});

test('checks the environment before claiming and refuses real-path escapes', async () => {
  const f = await fixture();
  await fs.rename(f.registrationPath, `${f.registrationPath}.away`);
  assert.equal(f.service.list()[0].ready, false);
  await assert.rejects(f.service.run(f.task.id, { runId: 'not-ready' }), { status: 409 });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM business_execution_claims').get().count, 0);
  await fs.rename(`${f.registrationPath}.away`, f.registrationPath);
  assert.equal((await f.service.run(f.task.id, { runId: 'now-ready' })).exitCode, 0);
  const outside = path.join(f.directory, 'outside-entry.mjs');
  await fs.writeFile(outside, 'process.exit(0);');
  const symlink = path.join(f.cwd, 'linked-entry.mjs');
  try { await fs.symlink(outside, symlink, 'file'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  const escaped = new BusinessTaskService(f.store, { tasks: [{ ...f.task, id: 'escaped-entry', scriptPath: symlink }] });
  assert.equal(escaped.list()[0].ready, false);
  await assert.rejects(escaped.preflight('escaped-entry'), { status: 409 });
});

test('failed business work remains claimed and raw errors never enter the result', async () => {
  const f = await fixture();
  await fs.writeFile(f.registrationPath, JSON.stringify({ mode: 'fail', executions: f.executions }));
  await assert.rejects(f.service.run(f.task.id, { runId: 'failed-work' }), (error) => {
    assert.equal(error.exitCode, 7);
    assert.equal(error.logId, 'failed-work');
    assert.ok(!error.message.includes('VERY-PRIVATE'));
    return true;
  });
  assert.equal((await f.service.run(f.task.id, { runId: 'do-not-retry-side-effects' })).skipped, true);
  assert.equal(f.store.db.prepare('SELECT status FROM business_execution_claims WHERE run_id=?').get('failed-work').status, 'failed');
  assert.match((await f.service.readLog('failed-work')).content, /VERY-PRIVATE-REGISTRATION-SECRET/);
});

test('cancellation kills a real descendant process and does not reopen the business-day claim', { timeout: 12_000 }, async () => {
  const f = await fixture();
  await fs.writeFile(f.registrationPath, JSON.stringify({ mode: 'hang', executions: f.executions, lateMarker: f.lateMarker }));
  const controller = new AbortController();
  const execution = f.service.run(f.task.id, { runId: 'cancel-tree', signal: controller.signal, onLog: () => controller.abort() });
  await assert.rejects(execution, { name: 'AbortError', logId: 'cancel-tree' });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await assert.rejects(fs.stat(f.lateMarker), { code: 'ENOENT' });
  assert.equal((await f.service.run(f.task.id, { runId: 'cancel-must-not-replay' })).skipped, true);
  assert.equal(f.store.db.prepare('SELECT status FROM business_execution_claims WHERE run_id=?').get('cancel-tree').status, 'cancelled');
});

test('timeout terminates execution, retains the claim, and bounds admin log responses', { timeout: 12_000 }, async () => {
  const f = await fixture({ timeoutSeconds: 1 }, { maxLogBytes: 60 });
  await fs.writeFile(f.registrationPath, JSON.stringify({ mode: 'hang', executions: f.executions, lateMarker: f.lateMarker }));
  await assert.rejects(f.service.run(f.task.id, { runId: 'timed-out-work' }), (error) => error.logId === 'timed-out-work' && /超过执行时限/.test(error.message));
  assert.equal(f.store.db.prepare('SELECT status FROM business_execution_claims WHERE run_id=?').get('timed-out-work').status, 'timed_out');
  const log = await f.service.readLog('timed-out-work');
  assert.equal(log.truncated, true);
  assert.ok(Buffer.byteLength(log.content) <= 60);
  assert.equal((await f.service.run(f.task.id, { runId: 'timeout-must-not-replay' })).skipped, true);
});

test('caps noisy task logs, keeps execution running, and reports a single truncation notice', async () => {
  const f = await fixture({}, { maxLogFileBytes: 1024 });
  await fs.writeFile(f.registrationPath, JSON.stringify({ mode: 'noisy', executions: f.executions, lateMarker: f.lateMarker }));
  const result = await f.service.run(f.task.id, { runId: 'noisy-execution' });
  assert.equal(result.exitCode, 0);
  assert.match(result.reply, /执行成功/);
  assert.equal(await fs.readFile(f.lateMarker, 'utf8'), 'task continued after log cap');
  const raw = await fs.readFile(path.join(f.service.logDirectory, 'noisy-execution.log'), 'utf8');
  assert.ok(Buffer.byteLength(raw) <= 1024);
  assert.match(raw, /NOISY-OUTPUT-0/);
  assert.equal(raw.match(/Pi 日志已截断/g)?.length, 1);
  const log = await f.service.readLog('noisy-execution');
  assert.equal(log.truncated, true);
  assert.match(log.content, /超过单次日志保存上限，任务仍继续执行/);
  assert.equal(f.store.db.prepare('SELECT status FROM business_execution_claims WHERE run_id=?').get('noisy-execution').status, 'succeeded');

  // Existing logs from an older uncapped server are also read with a bound.
  await fs.writeFile(path.join(f.service.logDirectory, 'old-unbounded.log'), 'A'.repeat(1024 * 1024));
  const legacy = await f.service.readLog('old-unbounded');
  assert.equal(legacy.truncated, true);
  assert.ok(Buffer.byteLength(legacy.content) < 2048);
  assert.match(legacy.content, /Pi 日志已截断/);
});
