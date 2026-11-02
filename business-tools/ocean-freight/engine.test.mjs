import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { executeQuery, calculateContainerCheckDigit, safeExternalURL, trackingAction, haversineKm } from './engine.mjs';
import { loadCatalog, runCli, parseArguments } from './cli.mjs';

const catalog = await loadCatalog();
const fixture = () => structuredClone(catalog);
const number = prefix => `${prefix}123456${calculateContainerCheckDigit(`${prefix}123456`)}`;
const one = input => executeQuery({ command: 'track', ...input }, catalog).results[0];

test('installed independent snapshot exposes complete counts and geographic filter labels', () => {
  const stats = executeQuery({ command: 'stats' }, catalog);
  assert.equal(stats.counts.shippingLines, 51); assert.equal(stats.counts.lessors, 10);
  assert.equal(stats.counts.ports, 13072); assert.equal(stats.counts.uniquePortCodes, 13068);
  assert.equal(stats.counts.ownerPrefixes, 3334); assert.equal(stats.counts.roro, 21); assert.equal(stats.counts.types, 8);
  assert.equal(stats.counts.deepTrackingCarriers, 16);
  assert.equal(stats.filters.countries.length, 247); assert.equal(stats.filters.continents.length, 6); assert.equal(stats.filters.lanes.length, 33);
  assert.equal(stats.filters.lanes.find(row => row.value === 'china-main').label, '中国大陆');
  assert.equal(stats.provenance.liveStatusRetrieved, false); assert.equal(stats.provenance.officiallyVerified, false);
});

test('ISO U/J/Z, fullwidth and grouped input are independently calculated without rewriting originals', () => {
  for (const prefix of ['CSQU', 'ABCJ', 'ABCZ']) {
    const value = number(prefix), result = one({ query: value });
    assert.equal(result.containerValidation.iso6346Valid, true);
    assert.equal(result.actualExistence.status, 'not_checked');
  }
  const original = ' ｍｓｋｕ １２３４５６ ５ ';
  const normalized = one({ query: original });
  assert.equal(normalized.original, original); assert.equal(normalized.normalized, 'MSKU1234565');
  assert.equal(normalized.containerValidation.iso6346Valid, true);
  const bad = one({ query: 'MSKU1234560' });
  assert.equal(bad.containerValidation.expectedCheckDigit, 5); assert.equal(bad.validation, 'invalid');
  assert.equal(bad.original, 'MSKU1234560'); assert.ok(bad.trackingActions.every(action => action.mode === 'manual_entry'));
});

test('invalid category, incomplete and unknown prefix never certify equipment or shipment', () => {
  const invalid = one({ query: 'ABCA1234560' }); assert.equal(invalid.containerValidation.equipmentCategoryValid, false); assert.equal(invalid.validation, 'invalid');
  const partial = one({ query: 'MSKU123' }); assert.equal(partial.validation, 'invalid');
  const unknown = one({ query: number('ZZZU') });
  assert.equal(unknown.ownerCandidates.length, 0); assert.equal(unknown.carrierCandidates.length, 0); assert.equal(unknown.actualExistence.status, 'not_checked');
});

test('lease and BIC-only owner lookup preserve ownership versus carrier distinction', () => {
  const leased = one({ query: number('TRLU') });
  assert.equal(leased.ownerCandidates.length, 1); assert.equal(leased.ownerCandidates[0].entityType, 'leasing');
  assert.equal(leased.carrierCandidates.length, 0); assert.equal(leased.ownerCandidates[0].officiallyVerified, false);
  const registeredOnly = one({ query: number('CIMU') });
  assert.ok(registeredOnly.ownerCandidates.some(row => row.code === 'CIMU' && row.sources.includes('owner_snapshot')));
  assert.equal(registeredOnly.actualExistence.status, 'not_checked');
});

test('same owner code bilingual sources consolidate while true conflicts remain visible', () => {
  const normal = one({ query: 'MSKU1234565' });
  assert.equal(normal.ownerCandidates.length, 1); assert.equal(normal.ownerCandidates[0].nameConflict, false);
  assert.equal(normal.ownerCandidates[0].sourceNames.length, 2); assert.equal(normal.ownerCandidates[0].registryName, 'Maersk');
  const c = fixture(); c.owners.find(row => row.code === 'MSKU').name = 'Different historical company';
  const result = executeQuery({ command: 'track', query: 'MSKU1234565' }, c).results[0];
  assert.equal(result.ownerCandidates.length, 1); assert.equal(result.ownerCandidates[0].nameConflict, true);
  assert.ok(result.ownerCandidates[0].sourceNames.some(row => row.name === 'Different historical company'));
});

test('SCAC document candidates preserve conflicts and never infer numeric booking from length', () => {
  const c = fixture(); c.carriers[0].bl.push('TEST'); c.carriers[1].bl.push('TEST');
  const ambiguous = executeQuery({ command: 'track', query: 'TEST000012345678' }, c).results[0];
  assert.equal(ambiguous.kind, 'ambiguous'); assert.equal(ambiguous.carrierCandidates.length, 2);
  assert.ok(ambiguous.carrierCandidates.every(row => row.confirmed === false));
  const digits = one({ query: '000012345678' }); assert.equal(digits.kind, 'unknown'); assert.equal(digits.normalized, '000012345678');
  const manual = one({ query: '000012345678', carrierId: 'maersk' });
  assert.equal(manual.trackingActions[0].copyText, '000012345678'); assert.equal(manual.trackingActions[0].mode, 'manual_entry');
});

test('all 16 declarative carrier deep paths work for valid containers without making requests', () => {
  const rows = catalog.carriers.filter(row => ['GET', 'POST'].includes(row.tracking.method));
  assert.equal(rows.length, 16);
  for (const carrier of rows) {
    const value = number(carrier.prefixes[0]);
    const result = one({ query: value, carrierId: carrier.id, kind: 'container' });
    assert.equal(result.trackingActions[0].mode, 'deep_link', carrier.id);
    assert.equal(result.trackingActions[0].automaticRequest, false);
    assert.ok(safeExternalURL(result.trackingActions[0].url));
  }
});

test('MSC payload is safely encoded and Evergreen POST fields follow the selected identifier kind', () => {
  const mscValue = number('MSCU'), msc = one({ query: mscValue, carrierId: 'msc' }).trackingActions[0];
  assert.equal(atob(new URL(msc.url).searchParams.get('params')), `trackingNumber=${mscValue}&trackingMode=0`);
  const container = one({ query: number('EGHU'), carrierId: 'evergreen', kind: 'container' }).trackingActions[0];
  assert.equal(container.method, 'POST'); assert.deepEqual(container.fields, { TYPE: 'CNTR', CNTR: number('EGHU') });
  const bill = one({ query: 'EGLV0000123456', carrierId: 'evergreen', kind: 'bill_of_lading' }).trackingActions[0];
  assert.equal(bill.method, 'POST'); assert.deepEqual(bill.fields, { TYPE: 'BL', BL: 'EGLV0000123456' });
  const booking = one({ query: '0000012345', carrierId: 'evergreen', kind: 'booking' }).trackingActions[0];
  assert.equal(booking.method, 'GET'); assert.equal(booking.mode, 'manual_entry'); assert.equal(booking.copyText, '0000012345');
  const otherBill = one({ query: 'MAEU0000123456', carrierId: 'maersk', kind: 'bill_of_lading' }).trackingActions[0];
  assert.equal(otherBill.mode, 'manual_entry');
});

test('malformed batch rows do not abort other rows and JSON numbers cannot lose their leading zeroes silently', () => {
  const result = executeQuery({ command: 'track', identifiers: ['CSQU3054383', { value: 'bad\u0000input' }, 12345, { value: 'ABC', hint: 'invented' }, 'MSKU1234565'] }, catalog);
  assert.equal(result.total, 5); assert.equal(result.results[0].validation, 'iso6346_valid');
  assert.equal(result.results[1].error.code, 'INVALID_IDENTIFIER'); assert.equal(result.results[2].validation, 'invalid');
  assert.equal(result.results[3].error.code, 'INVALID_IDENTIFIER'); assert.equal(result.results[4].validation, 'iso6346_valid');
  const lines = executeQuery({ command: 'track', query: 'CSQU3054383\nbad\u0000input\nMSKU1234565' }, catalog);
  assert.equal(lines.total, 3); assert.equal(lines.results[1].validation, 'invalid'); assert.equal(lines.results[2].validation, 'iso6346_valid');
});

test('safe URLs reject original-site dependency, credentials, private hosts and template host substitution', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/private', 'https://a:b@example.com/', 'http://127.0.0.1/', 'http://0x7f000001/', 'http://192.168.0.5/', 'https://[::1]/', 'https://sea.huodaiagent.com/', 'https://www.huodaiagent.com/', 'https://example.com:4443/', 'https://example.com/\nvalue']) assert.equal(safeExternalURL(url), null, url);
  const action = trackingAction({ id: 'unsafe', name: 'Unsafe', page: 'https://example.com/', tracking: { method: 'GET', urlTemplate: 'https://{num}.example.com/' } }, 'MSKU1234565', { allowDeepLink: true });
  assert.equal(action.mode, 'manual_entry'); assert.equal(action.url, 'https://example.com/');
});

test('port alias/name search, geographic filters and capped pagination operate on the full snapshot', () => {
  const alias = executeQuery({ command: 'ports', query: 'CNSHG' }, catalog);
  assert.ok(alias.results.some(row => row.code === 'CNSHA'));
  const chinese = executeQuery({ command: 'ports', country: '中国', continent: '亚洲', limit: 100 }, catalog);
  assert.equal(chinese.total, 371); assert.equal(chinese.results.length, 100); assert.equal(chinese.hasMore, true);
  const second = executeQuery({ command: 'ports', country: 'CN', offset: 100, limit: 100 }, catalog);
  assert.equal(new Set([...chinese.results, ...second.results].map(row => row.id)).size, 200);
  assert.throws(() => executeQuery({ command: 'ports', limit: 101 }, catalog));
  const route = executeQuery({ command: 'ports', lane: 'china-main' }, catalog); assert.equal(route.total, 371);
  const rotterdam = executeQuery({ command: 'ports', query: 'Rotterdam' }, catalog); assert.ok(rotterdam.results.some(row => row.code === 'NLRTM'));
});

test('duplicate port codes preserve both records and explicit portId selects the requested record', () => {
  for (const code of ['AEJEA', 'USLAX', 'MYTPP', 'USNYC']) {
    const result = executeQuery({ command: 'port', query: code }, catalog); assert.equal(result.total, 2, code);
    assert.equal(new Set(result.results.map(row => row.id)).size, 2);
    assert.ok(result.results.every(row => row.codeDuplicateCount === 2));
    for (const row of result.results) {
      const selected = executeQuery({ command: 'port', portId: row.id }, catalog);
      assert.equal(selected.total, 1); assert.equal(selected.results[0].id, row.id);
      assert.equal(selected.results[0].codeDuplicateCount, 2);
    }
  }
  assert.equal(executeQuery({ command: 'port', query: 'CNSHA' }, catalog).results[0].codeDuplicateCount, 1);
});

test('port detail has measured nearest neighbors and geographic grouping without inventing routes', () => {
  const detail = executeQuery({ command: 'port', query: 'CNSHA' }, catalog).results[0];
  assert.ok(detail.neighbors.length > 0); assert.ok(detail.neighbors.every((row, index, rows) => index === 0 || row.distanceKm >= rows[index - 1].distanceKm));
  assert.ok(detail.sameLane.every(row => row.lanes.includes('china-main')));
  assert.equal(detail.laneGroupingBasis, 'geographic_browsing_reference_not_a_sailing_service');
  assert.ok(detail.mapLinks.every(link => safeExternalURL(link.url)));
  assert.ok(Math.abs(haversineKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 111.195) < 0.01);
  assert.equal(haversineKm({ lat: 91, lon: 0 }, { lat: 0, lon: 0 }), null);
});

test('reference commands distinguish static links, approximate type data and vessel-name search', () => {
  const leasing = executeQuery({ command: 'carriers', query: 'TRLU' }, catalog).results[0]; assert.equal(leasing.type, 'leasing');
  const roro = executeQuery({ command: 'roro', query: 'minsheng' }, catalog); assert.equal(roro.results[0].scheduleStatus, 'not_listed_in_snapshot'); assert.equal(roro.tools.length, 3);
  const type = executeQuery({ command: 'types', query: '45G1' }, catalog).results[0]; assert.equal(type.id, '40hq'); assert.equal(type.indicative, true);
  const query = "O'NEIL & MMSI=123 / 船一", vessel = executeQuery({ command: 'vessel', query }, catalog);
  assert.equal(new URL(vessel.results.find(row => row.id === 'vesselfinder').url).searchParams.get('name'), query);
  assert.equal(vessel.provenance.liveStatusRetrieved, false); assert.ok(!Object.hasOwn(vessel.results[0], 'position'));
});

test('every query runs with fetch forbidden and returns no original-site URL', () => {
  const before = globalThis.fetch; globalThis.fetch = () => { throw new Error('Unexpected network request'); };
  try {
    for (const input of [{ command: 'track', query: 'MSKU1234565' }, { command: 'carriers', limit: 100 }, { command: 'ports', query: '上海' }, { command: 'port', query: 'CNSHA' }, { command: 'roro', limit: 100 }, { command: 'types' }, { command: 'vessel', query: 'SHI JIANG' }, { command: 'stats' }]) {
      const response = executeQuery(input, catalog);
      assert.equal(/https?:\/\/[^\s"\\]*huodaiagent\.com/iu.test(JSON.stringify(response)), false, input.command);
    }
  } finally { globalThis.fetch = before; }
});

test('CLI supports safe Unicode JSON request, per-row batch and literal leading-zero references', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ocean-freight-cli-'));
  const requestPath = path.join(directory, 'request.json'), batchPath = path.join(directory, 'batch.json');
  const output = []; const stdout = { write: chunk => output.push(chunk) };
  try {
    await fs.writeFile(requestPath, '\uFEFF' + JSON.stringify({ command: 'ports', query: '上海', filters: { country: 'CN', limit: 5 } }));
    const queried = await runCli(['--request', requestPath, '--pretty'], { stdout, catalog });
    assert.ok(queried.results.some(row => row.code === 'CNSHA')); assert.equal(queried.limit, 5);
    await fs.writeFile(batchPath, JSON.stringify({ identifiers: ['000012345678', 'CSQU3054383'] }));
    const batch = await runCli(['track', '--input', batchPath], { stdout, catalog });
    assert.equal(batch.results[0].normalized, '000012345678'); assert.equal(batch.results[1].validation, 'iso6346_valid');
    const standardInput = Readable.from([JSON.stringify({ command: 'types', query: '45G1' })]);
    const viaStdin = await runCli(['--request', '-'], { stdout, stdin: standardInput, catalog }); assert.equal(viaStdin.results[0].id, '40hq');
    assert.equal(output.length, 3);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('invalid CLI combinations, unsupported options and invalid UTF-8 fail explicitly', async () => {
  for (const args of [['--unknown'], ['--request', 'a.json', 'track'], ['ports', '--input', 'a.json'], ['track', '--kind', 'auto', '--hint', 'container'], ['ports', '--limit']]) assert.throws(() => parseArguments(args));
  await assert.rejects(runCli(['--request', '-'], { catalog, stdin: Readable.from([Buffer.from([0xff, 0xfe])]), stdout: { write() {} } }), /UTF-8/u);
  await assert.rejects(runCli(['--request', '-'], { catalog, stdin: Readable.from(['{"command":']), stdout: { write() {} } }), /valid JSON/u);
});
