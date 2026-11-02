#!/usr/bin/env node
/** Offline regression checks; these do not establish that an answer is factually true. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultCasesPath = fileURLToPath(new URL('../qa/response-quality-20261029/cases.json', import.meta.url));
const maxInputBytes = 16 * 1024 * 1024;
const maxReplyChars = 50_000;

// Tokens describe execution internals. A technical request may explicitly allow them.
const technicalTokens = [
  'checksum_mismatch', 'checksum', 'provenance', 'trackingActions',
  'toolCall', 'toolResult', 'stdout', 'stderr', 'powershell', 'SKILL.md',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'ocean-freight-tools', 'ego-browser',
  'attach_file', 'writeFile', 'exitCode', 'taskStatus', 'stack trace',
  'ETIMEDOUT', 'JSONL', 'JSON', 'HTTP',
];

function pattern(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('检查规则必须使用非空正则字符串');
  return new RegExp(value, 'iu');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeCheck(id, label, pass, severity = 'error', details = undefined) {
  return { id, label, pass: Boolean(pass), severity, ...(details ? { details } : {}) };
}

function normalizedPassage(value) {
  return value.normalize('NFKC').replace(/\\(?=[\\`*_{}[\]()#+.!|>-])/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase('en');
}

export function findRepeatedPassages(reply) {
  const passages = String(reply).split(/(?:\n\s*\n|[。！？!?]\s*|\r?\n)/u);
  const seen = new Set();
  const repeated = new Set();
  for (const passage of passages) {
    const normalized = normalizedPassage(passage);
    if ([...normalized].length < 32) continue;
    if (seen.has(normalized)) repeated.add(normalized.slice(0, 100));
    seen.add(normalized);
  }
  return [...repeated];
}

function technicalNoise(reply, scenario) {
  const allowed = new Set((scenario.allowedTechnicalTerms ?? []).map(term => term.toLocaleLowerCase('en')));
  const found = technicalTokens.filter(token => !allowed.has(token.toLocaleLowerCase('en')) &&
    new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(token)}(?![A-Za-z0-9_])`, 'iu').test(reply));
  if (!allowed.has('local-paths') && /\b[A-Z]:[\\/](?:[^\s<>"|]+[\\/])+/iu.test(reply)) found.push('本机文件路径');
  if (!allowed.has('sql') && /\bSELECT\s+.{0,80}\s+FROM\s+\w+/iu.test(reply)) found.push('SQL 查询');
  if (!scenario.allowCodeBlocks && /^\s*```/mu.test(reply)) found.push('未请求的代码块');
  if (!scenario.allowCodeBlocks && /^\s*\{\s*"(?:status|results|provenance|toolCall|success)"\s*:/u.test(reply)) found.push('原始结果 JSON');
  return [...new Set(found)];
}

// Check a claim inside one sentence, so “文件已生成。当前没有安排重试” is not
// accidentally read as “已安排重试”. Immediate negation is kept meaningful.
// This is intentionally narrow; indirect language still requires human review.
function matchedForbiddenRules(reply, rules) {
  const clauses = reply.split(/[。！？!?；;\r\n]/u);
  return rules.filter(value => clauses.some(clause => {
    const expression = new RegExp(value, 'giu');
    for (const match of clause.matchAll(expression)) {
      const before = clause.slice(Math.max(0, match.index - 24), match.index);
      const negated = /(?:尚未|还没|未能|不能|无法|没有|不曾|不代表|不等于|不表示|未经|未|不)(?:据此|直接|自动|实际|正式|完全|仅凭|替你|帮你|已经|全部|确认|安排|已|的|\s)*$/u.test(before);
      if (!negated) return true;
    }
    return false;
  }));
}

export function validateCases(document) {
  const cases = Array.isArray(document) ? document : document?.cases;
  if (!Array.isArray(cases) || cases.length === 0) throw new TypeError('场景文件必须包含非空 cases 数组');
  const ids = new Set();
  for (const scenario of cases) {
    if (!scenario || typeof scenario.id !== 'string' || !scenario.id.trim()) throw new TypeError('场景缺少 id');
    if (ids.has(scenario.id)) throw new TypeError(`重复场景 id：${scenario.id}`);
    ids.add(scenario.id);
    if (typeof scenario.prompt !== 'string' || !scenario.evidence || !scenario.rules) throw new TypeError(`场景 ${scenario.id} 缺少 prompt/evidence/rules`);
    if (!Array.isArray(scenario.allowedTechnicalTerms)) throw new TypeError(`场景 ${scenario.id} 必须显式列出 allowedTechnicalTerms`);
    for (const fact of scenario.rules.requiredFacts ?? []) {
      if (!fact.label || !Array.isArray(fact.anyOf) || !fact.anyOf.length) throw new TypeError(`场景 ${scenario.id} 的事实规则无效`);
      fact.anyOf.forEach(pattern);
    }
    for (const claim of scenario.rules.forbiddenClaims ?? []) {
      if (!claim.label || !Array.isArray(claim.patterns) || !claim.patterns.length) throw new TypeError(`场景 ${scenario.id} 的禁止结论规则无效`);
      claim.patterns.forEach(pattern);
    }
    (scenario.rules.openingAnyOf ?? []).forEach(pattern);
  }
  return cases;
}

/**
 * @param {{caseId:string, reply:string, runId?:string, model?:string}} record
 * @param {object} scenario a validated item from cases.json
 * @returns {{automaticPass:boolean, status:string, checks:object[], reviewRequired:true}}
 */
export function evaluateReply(record, scenario) {
  const checks = [];
  const replyValid = typeof record?.reply === 'string' && Boolean(record.reply.trim()) && record.reply.length <= maxReplyChars;
  checks.push(makeCheck('reply-present', '回复为非空文本且不超过离线检查上限', replyValid));
  if (!replyValid) return finish(record, scenario, checks, 0);

  const reply = record.reply;
  const rules = scenario.rules;
  for (const [index, fact] of (rules.requiredFacts ?? []).entries()) {
    checks.push(makeCheck(`fact-${index + 1}`, fact.label, fact.anyOf.some(value => pattern(value).test(reply))));
  }
  for (const [index, claim] of (rules.forbiddenClaims ?? []).entries()) {
    const matched = matchedForbiddenRules(reply, claim.patterns);
    checks.push(makeCheck(`claim-${index + 1}`, claim.label, matched.length === 0, 'error', matched.length ? { matchedRules: matched } : undefined));
  }

  const noise = technicalNoise(reply, scenario);
  checks.push(makeCheck('technical-context', '技术字段符合当前提问语境', noise.length === 0, 'error', noise.length ? { terms: noise } : undefined));
  const repeated = scenario.rules.allowRepeatedText ? [] : findRepeatedPassages(reply);
  checks.push(makeCheck('no-repeated-passage', '没有重复整段摘要或说明', repeated.length === 0, 'error', repeated.length ? { repeatedPassages: repeated } : undefined));
  const credentialLike = /\bsk-[A-Za-z0-9_-]{12,}\b/u.test(reply);
  checks.push(makeCheck('no-credential-value', '回复没有明显的密钥值', !credentialLike));

  if (rules.openingAnyOf?.length) {
    checks.push(makeCheck('result-first', '开头直接说明业务结论', rules.openingAnyOf.some(value => pattern(value).test(reply.slice(0, 120))), 'review'));
  }
  if (rules.softMaxChars) {
    checks.push(makeCheck('length-review', '篇幅与当前任务相称（仅提示人工复核，不截断回答）', [...reply].length <= rules.softMaxChars, 'review', { softMaxChars: rules.softMaxChars }));
  }
  return finish(record, scenario, checks, [...reply].length);
}

function finish(record, scenario, checks, characters) {
  const errors = checks.filter(check => check.severity === 'error');
  const failed = errors.filter(check => !check.pass);
  const reviewFlags = checks.filter(check => check.severity === 'review' && !check.pass);
  return {
    caseId: scenario.id,
    title: scenario.title ?? scenario.id,
    ...(typeof record?.runId === 'string' ? { runId: record.runId } : {}),
    ...(typeof record?.model === 'string' ? { model: record.model } : {}),
    status: failed.length ? 'failed' : 'checks_passed',
    automaticPass: failed.length === 0,
    checkScore: errors.length ? Math.round(100 * (errors.length - failed.length) / errors.length) : 0,
    characterCount: characters,
    failedChecks: failed.length,
    reviewFlags: reviewFlags.length,
    reviewRequired: true,
    checks,
  };
}

export function evaluateReplies(records, cases) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 1000) throw new TypeError('回复文件应包含 1–1000 条记录');
  const byId = new Map(cases.map(scenario => [scenario.id, scenario]));
  const results = records.map((record, index) => {
    const scenario = byId.get(record?.caseId);
    if (scenario) return evaluateReply(record, scenario);
    return {
      caseId: typeof record?.caseId === 'string' ? record.caseId : null,
      recordIndex: index,
      status: 'unknown_case', automaticPass: false, checkScore: 0,
      failedChecks: 1, reviewFlags: 0, reviewRequired: true,
      checks: [makeCheck('known-case', '回复必须指定场景文件中存在的 caseId', false)],
    };
  });
  return {
    schemaVersion: 1,
    evaluatedAt: new Date().toISOString(),
    evaluator: 'business-replies-offline-rules-v1',
    warning: '离线规则只能发现部分问题。检查通过不代表真实执行成功、权限正确或业务事实已核实，必须对照工具证据人工抽检。',
    summary: {
      total: results.length,
      checksPassed: results.filter(result => result.automaticPass).length,
      failed: results.filter(result => !result.automaticPass).length,
      needsHumanReview: results.length,
      withReviewFlags: results.filter(result => result.reviewFlags > 0).length,
    },
    results,
  };
}

export function parseReplyRecords(contents) {
  if (Buffer.byteLength(contents, 'utf8') > maxInputBytes) throw new TypeError('回复文件超过 16 MiB 上限');
  const text = contents.replace(/^\uFEFF/u, '').trim();
  if (!text) throw new TypeError('回复文件为空');
  if (text.startsWith('[')) return JSON.parse(text);
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.replies)) return parsed.replies;
      if (typeof parsed.caseId === 'string') return [parsed];
      throw new TypeError('JSON 对象必须有 replies 数组或 caseId');
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A complete JSON document takes precedence; otherwise interpret one object per line.
    }
  }
  return text.split(/\r?\n/u).filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new TypeError(`JSONL 第 ${index + 1} 行不是合法 JSON`); }
  });
}

const help = `离线验收智能体的业务回复（不调用模型、不执行任务、不更改原回复）

用法：
  node scripts/evaluate-business-replies.mjs --input replies.jsonl [--cases cases.json] [--output report.json]

每条记录：{"caseId":"invalid-container-digit","reply":"箱号最后一位可能有误……","model":"可选"}
输入支持 JSON 数组、{"replies":[...]}、单条 JSON 对象或 JSONL。
结果逐项列出事实、虚假成功、技术字段和重复段落检查；篇幅仅提示复核。
退出码：0=所有离线错误检查通过（仍须人工核验），1=有不合格记录，2=文件或参数错误。
`;

export async function runCli(args) {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(help); return 0; }
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!['--input', '--cases', '--output'].includes(argument)) throw new TypeError(`未知参数：${argument}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new TypeError(`${argument} 缺少文件路径`);
    if (options[argument]) throw new TypeError(`重复参数：${argument}`);
    options[argument] = value;
  }
  if (!options['--input']) throw new TypeError('请使用 --input 指定真实回复或测试回复文件；工具不会自动把示例当作模型运行结果');
  const cases = validateCases(JSON.parse(await readFile(resolve(options['--cases'] ?? defaultCasesPath), 'utf8')));
  const records = parseReplyRecords(await readFile(resolve(options['--input']), 'utf8'));
  const report = evaluateReplies(records, cases);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options['--output']) {
    const target = resolve(options['--output']);
    if ([resolve(options['--input']), resolve(options['--cases'] ?? defaultCasesPath)].includes(target)) throw new TypeError('--output 不能覆盖输入或场景文件');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, serialized, 'utf8');
    process.stdout.write(`已验收 ${report.summary.total} 条：离线检查通过 ${report.summary.checksPassed} 条，未通过 ${report.summary.failed} 条。全部仍需人工核对工具证据。\n`);
  } else process.stdout.write(serialized);
  return report.summary.failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`验收未执行：${error.message}\n`); process.exitCode = 2; }
}
