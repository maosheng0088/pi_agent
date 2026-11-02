#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeQuery } from './engine.mjs';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_CATALOG_URL = new URL('./data/catalog.json', import.meta.url);
const COMMANDS = new Set(['track', 'carriers', 'ports', 'port', 'roro', 'types', 'vessel', 'stats']);
const OPTIONS = new Map([['--kind', 'kind'], ['--hint', 'kind'], ['--carrier', 'carrierId'], ['--country', 'country'], ['--continent', 'continent'], ['--lane', 'lane'], ['--offset', 'offset'], ['--limit', 'limit']]);
const HELP = `Independent offline ocean freight tools (Node built-ins only)

node cli.mjs track MSKU1234565 [OTHER_IDENTIFIERS]
node cli.mjs track --input batch.json --kind container
node cli.mjs --request request.json
node cli.mjs ports Rotterdam --country NL --limit 20
node cli.mjs port CNSHA
node cli.mjs carriers TRLU
node cli.mjs roro ww
node cli.mjs types 45G1
node cli.mjs vessel "BYD SHENZHEN"
node cli.mjs stats

--request PATH|-  JSON command: {"command":"ports","query":"上海"}
--input PATH|-    Track batch: ["MSKU1234565"] or {"identifiers":[...]}
--kind KIND       auto | container | bill_of_lading | bol | booking
--carrier ID      Manual carrier selection; does not confirm a real shipment
--country CODE    Filter ports by country code or name
--continent CODE  Filter ports by continent code or name
--lane ID         Filter the geographic browsing lane
--offset N        Result offset
--limit N         At most 100 for directory commands; 10000 for track
--pretty          Accepted; JSON is already formatted by default
--                Treat the remaining arguments as literal query text

No external page, API, form or business system is accessed automatically.
GET/POST tracking actions are declarative navigation instructions, not live results.
`;

export async function loadCatalog(filename = DEFAULT_CATALOG_URL) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function readJSON(filename, stdin) {
  let buffer;
  if (filename === '-') {
    const chunks = []; let bytes = 0;
    for await (const part of stdin) { const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length; if (bytes > MAX_INPUT_BYTES) throw new RangeError('Input JSON exceeds 2 MiB.'); chunks.push(chunk); }
    buffer = Buffer.concat(chunks);
  } else {
    const metadata = await fs.stat(filename);
    if (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES) throw new RangeError('Input must be a regular JSON file of at most 2 MiB.');
    buffer = await fs.readFile(filename);
    if (buffer.length > MAX_INPUT_BYTES) throw new RangeError('Input JSON exceeds 2 MiB.');
  }
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/u, ''); }
  catch { throw new TypeError('Input JSON must be UTF-8 text.'); }
  try { return JSON.parse(source); } catch { throw new TypeError('Input is not valid JSON.'); }
}

export function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw new TypeError('CLI arguments must be strings.');
  const positional = [], options = {}; let requestPath, inputPath, command, literal = false, help = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (literal) { positional.push(argument); continue; }
    if (argument === '--') { literal = true; continue; }
    if (argument === '--help') { help = true; continue; }
    if (argument === '--pretty') continue;
    if (argument === '--request' || argument === '--input' || OPTIONS.has(argument)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new TypeError(`${argument} needs a value.`);
      if (argument === '--request') { if (requestPath !== undefined) throw new TypeError('--request cannot be repeated.'); requestPath = value; }
      else if (argument === '--input') { if (inputPath !== undefined) throw new TypeError('--input cannot be repeated.'); inputPath = value; }
      else { const key = OPTIONS.get(argument); if (Object.hasOwn(options, key)) throw new TypeError('The same option cannot be repeated.'); options[key] = value; }
      continue;
    }
    if (argument.startsWith('-')) throw new TypeError('Unknown option. Use -- before literal values starting with a hyphen.');
    if (!command && COMMANDS.has(argument) && !positional.length) command = argument;
    else positional.push(argument);
  }
  if (requestPath !== undefined && (inputPath !== undefined || command || positional.length || Object.keys(options).length)) throw new TypeError('--request cannot be combined with another command or query options.');
  if (inputPath !== undefined && (positional.length || command && command !== 'track')) throw new TypeError('--input is only for track and cannot be combined with positional values.');
  return { command: command ?? (inputPath !== undefined ? 'track' : undefined), positional, options, requestPath, inputPath, help };
}

function normalizeRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A request must be a JSON object.');
  const allowedFilters = {};
  for (const key of ['country', 'continent', 'lane', 'offset', 'limit']) if (value.filters && Object.hasOwn(value.filters, key)) allowedFilters[key] = value.filters[key];
  return { ...allowedFilters, ...value, kind: value.kind === 'bol' ? 'bill_of_lading' : value.kind };
}

export async function runCli(argv, { stdin = process.stdin, stdout = process.stdout, catalog } = {}) {
  const parsed = parseArguments(argv);
  if (parsed.help) { stdout.write(HELP); return; }
  let request;
  if (parsed.requestPath !== undefined) request = normalizeRequest(await readJSON(parsed.requestPath, stdin));
  else if (parsed.inputPath !== undefined) {
    const value = await readJSON(parsed.inputPath, stdin);
    request = { ...(Array.isArray(value) ? { identifiers: value } : normalizeRequest(value)), ...parsed.options, command: 'track' };
  } else {
    if (!parsed.command) throw new TypeError('Provide a supported command or --request JSON file.');
    request = { command: parsed.command, ...parsed.options,
      ...(parsed.command === 'track' && parsed.positional.length > 1 ? { identifiers: parsed.positional } : { query: parsed.positional.join(' ') }) };
  }
  if (request.kind === 'bol') request.kind = 'bill_of_lading';
  const result = executeQuery(request, catalog ?? await loadCatalog());
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${JSON.stringify({ error: { code: 'INVALID_INPUT', message: error instanceof Error ? error.message : 'Request rejected.' }, liveStatusRetrieved: false })}\n`); process.exitCode = 2; }
}
