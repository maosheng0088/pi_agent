import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  evaluateReply, evaluateReplies, findRepeatedPassages, parseReplyRecords, validateCases,
} from '../scripts/evaluate-business-replies.mjs';

const cases = validateCases(JSON.parse(await readFile(new URL('../qa/response-quality-20261029/cases.json', import.meta.url), 'utf8')));
const byId = new Map(cases.map(item => [item.id, item]));
const cli = fileURLToPath(new URL('../scripts/evaluate-business-replies.mjs', import.meta.url));

function result(caseId, reply) {
  return evaluateReply({ caseId, reply }, byId.get(caseId));
}

test('20 个场景的合格与不合格示例都被正确区分，示例不冒充真实模型运行', async t => {
  assert.equal(cases.length, 20);
  for (const scenario of cases) {
    await t.test(scenario.id, () => {
      const good = result(scenario.id, scenario.fixtures.good);
      assert.equal(good.automaticPass, true, JSON.stringify(good.checks.filter(check => !check.pass)));
      assert.equal(good.reviewRequired, true);
      assert.equal(result(scenario.id, scenario.fixtures.bad).automaticPass, false);
    });
  }
});

test('即使包含全部必需事实，额外虚构全部成功仍会失败', () => {
  const scenario = byId.get('partial-batch');
  const reply = `${scenario.fixtures.good} 全部成功。`;
  const scored = result(scenario.id, reply);
  assert.equal(scored.checks.filter(check => check.id.startsWith('fact-')).every(check => check.pass), true);
  assert.equal(scored.checks.find(check => check.id === 'claim-1').pass, false);
  assert.equal(scored.automaticPass, false);
});

test('部分完成的自然字序不会误判全部完成，10/8/2三个数量仍分别检查', () => {
  const caseId = 'partial-batch';
  const reply = '还没全部处理完，10 条里只完成了 8 条。剩下 2 条失败的原因是缺少提柜日期，需要补上提柜日期后重跑。';
  assert.equal(result(caseId, reply).automaticPass, true);
  for (const [from, to] of [['10 条', '总共'], ['8 条', '18 条'], ['2 条', '12 条']]) {
    const scored = result(caseId, reply.replace(from, to));
    assert.equal(scored.automaticPass, false, `${from} 不应遗漏或改数后通过`);
  }
  assert.equal(result(caseId, `${reply} 10 条全部完成。`).automaticPass, false);
});

test('管理员任务数接受没完成、正在跑、受阻等业务用语，但不放宽数量或允许内部字段', () => {
  const caseId = 'admin-business-still-plain';
  const reply = '今天有 3 个任务没完成：其中 1 个是受阻，另外还有 2 个正在跑，不算完成。';
  assert.equal(result(caseId, reply).automaticPass, true);
  for (const [from, to] of [['3 个', '13 个'], ['1 个', '11 个'], ['2 个', '12 个']]) {
    assert.equal(result(caseId, reply.replace(from, to)).automaticPass, false);
  }
  assert.equal(result(caseId, `${reply} 来源 evidence.json。`).checks.find(check => check.id === 'technical-context').pass, false);
});

test('HTTP错误检查允许常见JS变量名和布尔分支，单纯提到.ok不等于处理错误', () => {
  const caseId = 'explicit-programming-exception';
  for (const condition of ['!res.ok', '!httpResponse.ok', '!r.ok', 'res.ok === false', 'resp.ok !== true']) {
    const reply = `Node.js 示例：if (${condition}) throw new Error('HTTP'); HTTP 401 时检查凭据。`;
    assert.equal(result(caseId, reply).automaticPass, true, condition);
  }
  assert.equal(result(caseId, 'HTTP 401 时检查凭据。响应对象有 res.ok 属性。').checks.find(check => check.id === 'fact-1').pass, false);
});

test('生成文件和发送文件分别验收，上传失败不能说已经交付', () => {
  const scenario = byId.get('attachment-delivery-failed');
  const scored = result(scenario.id, `${scenario.fixtures.good} 已发送到群，投递成功。`);
  assert.equal(scored.checks.find(check => check.id === 'claim-1').pass, false);
});

test('保留校验不等于确认存在，以及未安排重试等否定事实', () => {
  assert.equal(result('valid-container-not-live', 'MSKU1234565 校验通过，尚未查询运输进度，不能据此确认箱子真实存在。').automaticPass, true);
  assert.equal(result('network-timeout', '这次查询超时，没有查到结果。可以稍后重试，但尚未安排自动重试。').automaticPass, true);
  assert.equal(result('network-timeout', '这次查询超时，没有查到结果。但已安排自动重试。').automaticPass, false);
});

test('金额、币种、有效期和原输入不能因表达简洁被丢掉', () => {
  const scenario = byId.get('quote-preserve-money-date');
  const changedMoney = result(scenario.id, scenario.fixtures.good.replace('USD 1,280', 'USD 1,820'));
  assert.equal(changedMoney.checks.find(check => check.id === 'fact-1').pass, false);
  assert.equal(changedMoney.checks.find(check => check.id === 'claim-1').pass, false);
  const lostDate = result(scenario.id, scenario.fixtures.good.replace('2026-10-31', '下周'));
  assert.equal(lostDate.checks.find(check => check.id === 'fact-2').pass, false);
  const lostInput = result('invalid-container-digit', byId.get('invalid-container-digit').fixtures.good.replace('MSKU1234560', '原箱号'));
  assert.equal(lostInput.checks.find(check => check.id === 'fact-1').pass, false);
});

test('技术表达按问题语境决定，管理员身份本身不启用技术噪音', () => {
  const business = byId.get('admin-business-still-plain');
  const businessReply = result(business.id, `${business.fixtures.good} stdout 有记录。`);
  assert.equal(businessReply.checks.find(check => check.id === 'technical-context').pass, false);
  assert.equal(result('admin-explicit-program-logs', byId.get('admin-explicit-program-logs').fixtures.good).automaticPass, true);
  assert.equal(result('explicit-programming-exception', byId.get('explicit-programming-exception').fixtures.good).automaticPass, true);
});

test('明确请求技术示例也不能编造已实际调用接口', () => {
  const scenario = byId.get('explicit-programming-exception');
  const scored = result(scenario.id, `${scenario.fixtures.good}\n我已调用真实接口。`);
  assert.equal(scored.checks.find(check => check.id === 'claim-1').pass, false);
});

test('检测重复摘要，包括转义 Markdown 与展开后原文', () => {
  const passage = '找到三个匹配的港口记录，当前结果来自本地参考目录，需要你按国家和代码确认具体港口';
  assert.equal(findRepeatedPassages(`**${passage}**。\n\n\\*\\*${passage}\\*\\*。`).length, 1);
  const short = '同意。\n同意。';
  assert.equal(findRepeatedPassages(short).length, 0, '普通短句重复不应该误判成长摘要重复');
});

test('篇幅只产生人工复核提示，不裁剪或强制判错', () => {
  const scenario = byId.get('quote-preserve-money-date');
  const reply = `${scenario.fixtures.good}\n${'补充说明：'.repeat(100)}`;
  const scored = result(scenario.id, reply);
  assert.equal(scored.automaticPass, true);
  assert.equal(scored.reviewFlags, 1);
  assert.equal(scored.characterCount, [...reply].length);
});

test('明显密钥即使放在技术回答里也不应公开', () => {
  const scenario = byId.get('explicit-programming-exception');
  const scored = result(scenario.id, `${scenario.fixtures.good}\nsk-test-not-a-real-credential-1234567890`);
  assert.equal(scored.checks.find(check => check.id === 'no-credential-value').pass, false);
});

test('空回复、未知场景、过长输入不被当作通过', () => {
  assert.equal(result('capabilities-brief', '').automaticPass, false);
  assert.equal(result('capabilities-brief', 'a'.repeat(50_001)).automaticPass, false);
  const report = evaluateReplies([{ caseId: 'not-a-case', reply: '完成' }], cases);
  assert.equal(report.results[0].status, 'unknown_case');
  assert.equal(report.summary.failed, 1);
  assert.throws(() => evaluateReplies([], cases), /1–1000/u);
});

test('JSON 与 JSONL 输入格式保留换行且兼容 BOM', () => {
  const row = { caseId: 'capabilities-brief', reply: '第一行\n第二行' };
  assert.deepEqual(parseReplyRecords(`\uFEFF${JSON.stringify([row])}`), [row]);
  assert.deepEqual(parseReplyRecords(JSON.stringify({ replies: [row] })), [row]);
  assert.deepEqual(parseReplyRecords(JSON.stringify(row)), [row]);
  assert.deepEqual(parseReplyRecords(`${JSON.stringify(row)}\n${JSON.stringify(row)}\n`), [row, row]);
  assert.throws(() => parseReplyRecords(''), /为空/u);
  assert.throws(() => parseReplyRecords('{"caseId": "a"}\n{bad}'), /第 2 行/u);
  assert.throws(() => parseReplyRecords('{"unknown": []}'), /replies/u);
});

test('场景无证据、缺少技术语境或重复 ID 会阻止验收', () => {
  assert.throws(() => validateCases([{ id: 'a', prompt: 'p', rules: {} }]), /evidence/u);
  assert.throws(() => validateCases([{ id: 'a', prompt: 'p', evidence: {}, rules: {} }]), /allowedTechnicalTerms/u);
  assert.throws(() => validateCases([cases[0], cases[0]]), /重复/u);
});

test('CLI 从真实输入生成报告，失败退出 1，不允许覆盖输入', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-reply-quality-'));
  try {
    const input = join(folder, 'replies.jsonl');
    const output = join(folder, 'report.json');
    const scenario = cases[0];
    await writeFile(input, JSON.stringify({ caseId: scenario.id, reply: scenario.fixtures.bad }), 'utf8');
    const child = spawnSync(process.execPath, [cli, '--input', input, '--output', output], { encoding: 'utf8' });
    assert.equal(child.status, 1, child.stderr);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.summary.failed, 1);
    assert.equal(report.summary.needsHumanReview, 1);
    assert.match(report.warning, /不代表真实执行成功/u);

    const original = await readFile(input, 'utf8');
    const overwrite = spawnSync(process.execPath, [cli, '--input', input, '--output', input], { encoding: 'utf8' });
    assert.equal(overwrite.status, 2);
    assert.equal(await readFile(input, 'utf8'), original);

    const missing = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /不会自动把示例当作模型运行结果/u);
    const unknown = spawnSync(process.execPath, [cli, '--send-live'], { encoding: 'utf8' });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /未知参数/u);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
