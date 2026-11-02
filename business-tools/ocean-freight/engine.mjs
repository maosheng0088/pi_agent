/** Independent offline freight engine. Browser-safe ESM: no I/O or automatic requests. */
import { normalizeIdentifier, normalizeContainerNumber, validateContainerNumber, calculateContainerCheckDigit } from './freight-identifiers.mjs';
export { validateContainerNumber, calculateContainerCheckDigit };

const INDEXES = new WeakMap();
const COMMANDS = new Set(['track', 'carriers', 'ports', 'port', 'roro', 'types', 'vessel', 'stats']);
const KINDS = new Set(['auto', 'container', 'bill_of_lading', 'booking']);
const norm = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value = '', max = 300, { multiline = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value)) throw new TypeError(`Expected text of at most ${max} characters.`);
  return value.normalize('NFKC').trim();
}

/** URLs are navigation targets, never fetched by the engine. Unsafe URLs are omitted. */
export function safeExternalURL(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u0020\u007f<>"`\\]/u.test(value)) return null;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
      || host === 'huodaiagent.com' || host.endsWith('.huodaiagent.com')
      || !host.includes('.') || /^(?:localhost|0\.0\.0\.0|127(?:\.|$)|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[)/u.test(host)) return null;
    return url.href;
  } catch { return null; }
}

function indexCatalog(catalog) {
  if (!isObject(catalog) || catalog.schemaVersion !== 2) throw new TypeError('Catalog schemaVersion must be 2.');
  if (INDEXES.has(catalog)) return INDEXES.get(catalog);
  for (const name of ['carriers', 'ports', 'roro', 'types', 'owners']) if (!Array.isArray(catalog[name]) || catalog[name].length > 100000) throw new TypeError(`Invalid catalog array: ${name}`);
  const carrierIds = new Map(), carrierPrefixes = new Map(), scac = new Map(), ownerPrefixes = new Map(), portCodes = new Map(), portIds = new Map();
  const push = (map, key, value) => { const values = map.get(key) ?? []; values.push(value); map.set(key, values); };
  for (const carrier of catalog.carriers) {
    if (typeof carrier.id !== 'string' || !['carrier', 'leasing'].includes(carrier.type) || carrierIds.has(carrier.id)) throw new TypeError('Invalid or duplicated carrier ID/type.');
    carrierIds.set(carrier.id, carrier);
    for (const prefix of carrier.prefixes ?? []) push(carrierPrefixes, String(prefix).toUpperCase(), carrier);
    for (const prefix of carrier.bl ?? []) push(scac, String(prefix).toUpperCase(), carrier);
  }
  for (const owner of catalog.owners) {
    const code = String(owner.code ?? '').toUpperCase();
    if (/^[A-Z]{3}[UJZ]$/u.test(code)) push(ownerPrefixes, code, owner);
  }
  for (const port of catalog.ports) {
    const id = String(port.id ?? port.code ?? '').toLowerCase();
    if (!id || portIds.has(id)) throw new TypeError('Port IDs must be unique.');
    portIds.set(id, port);
    const code = String(port.code ?? port.id ?? '').toUpperCase();
    if (code) push(portCodes, code, port);
    for (const alias of port.aliases ?? []) if (String(alias).toUpperCase() !== code) push(portCodes, String(alias).toUpperCase(), port);
  }
  const value = { carrierIds, carrierPrefixes, scac, ownerPrefixes, portCodes, portIds };
  INDEXES.set(catalog, value); return value;
}

function provenance(catalog, section) {
  const metadata = catalog.metadata ?? {};
  const sectionMeta = metadata.sources?.[section] ?? {};
  return { directorySnapshot: true, liveStatusRetrieved: false, officiallyVerified: false,
    catalogVersion: metadata.version ?? metadata.catalogVersion ?? '2',
    snapshotDate: sectionMeta.snapshotDate ?? sectionMeta.sourceDate ?? metadata.snapshotDate ?? metadata.capturedAt ?? metadata.generatedAt ?? null,
    ownerSnapshotDate: metadata.ownerSnapshotDate ?? null,
    freshness: 'Reference snapshot; verify current business facts with the relevant official provider.',
    ...(sectionMeta.sourceName ? { sourceName: sectionMeta.sourceName } : {}),
  };
}

function integer(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new TypeError(`${name} must be an integer from 0 to ${maximum}.`);
  return parsed;
}

function envelope(input, rows, catalog, notes = [], { max = 100, defaultLimit = 20, extras = {} } = {}) {
  const offset = integer(input.offset, 0, 1000000, 'offset');
  const limit = integer(input.limit, defaultLimit, max, 'limit');
  if (limit < 1) throw new TypeError('limit must be at least 1.');
  return { command: input.command, query: typeof input.query === 'string' ? input.query : null,
    results: rows.slice(offset, offset + limit), total: rows.length, offset, limit, hasMore: offset + limit < rows.length,
    provenance: provenance(catalog, input.command), notes, ...extras };
}

const matches = (query, values) => !query || query === '*' || values.some(value => norm(value).includes(norm(query)));
const unique = (rows, key) => [...new Map(rows.map(row => [key(row), row])).values()];
const linkRows = rows => (rows ?? []).map(row => ({ id: row.id ?? null, name: row.name, url: safeExternalURL(row.url ?? row.page) })).filter(row => row.url);
const carrierRow = row => ({ id: row.id, name: row.name, en: row.en ?? '', country: row.country ?? '', type: row.type,
  prefixes: [...(row.prefixes ?? [])], bl: [...(row.bl ?? [])], page: safeExternalURL(row.page), trackingAvailable: ['GET', 'POST'].includes(row.tracking?.method),
  entityRole: row.type === 'leasing' ? 'container_lessor' : 'shipping_line', operatingCarrierConfirmed: false });

function encodeBase64ASCII(value) {
  if (typeof btoa === 'function') return btoa(value);
  // Small independent fallback keeps this module usable in browsers without a global btoa.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let result = '';
  for (let index = 0; index < value.length; index += 3) {
    const a = value.charCodeAt(index), b = value.charCodeAt(index + 1), c = value.charCodeAt(index + 2);
    if (a > 127 || b > 127 || c > 127) throw new TypeError('Tracking payload must be ASCII.');
    const packed = (a << 16) | ((b || 0) << 8) | (c || 0);
    result += alphabet[(packed >>> 18) & 63] + alphabet[(packed >>> 12) & 63] + (index + 1 < value.length ? alphabet[(packed >>> 6) & 63] : '=') + (index + 2 < value.length ? alphabet[packed & 63] : '=');
  }
  return result;
}

function templateURL(template, number, descriptor) {
  if (typeof template !== 'string' || template.length > 4096) return null;
  const encodedNumber = encodeURIComponent(number);
  let encoded = encodedNumber;
  if (descriptor.encoding) {
    if (!['msc-base64', 'base64'].includes(descriptor.encoding)) return null;
    const payload = String(descriptor.payloadTemplate ?? '{num}').replaceAll('{num}', number);
    if (payload.length > 1000 || /[^\x20-\x7e]/u.test(payload) || /\{[^}]*\}/u.test(payload)) return null;
    encoded = encodeURIComponent(encodeBase64ASCII(payload));
  }
  const url = template.replaceAll('{num}', encodedNumber).replaceAll('{encoded}', encoded);
  if (/\{[^}]*\}|\$CONTAINER_NUMBER\$|\$BASE64/u.test(url)) return null;
  const safe = safeExternalURL(url);
  if (!safe) return null;
  // Substitution must never change the host or protocol of a declarative descriptor.
  const staticURL = safeExternalURL(template.replaceAll('{num}', 'SAMPLE').replaceAll('{encoded}', 'SAMPLE'));
  if (!staticURL || new URL(staticURL).origin !== new URL(safe).origin) return null;
  return safe;
}

/** Build a navigation action; this function never submits forms or sends requests. */
export function trackingAction(entity, number, { kind = 'container', allowDeepLink = false } = {}) {
  const copyText = text(number, 2048), descriptor = entity.tracking ?? {};
  const base = { carrierId: entity.id ?? entity.code ?? null, carrierName: entity.name ?? '', copyText,
    actualExistenceConfirmed: false, automaticRequest: false };
  const page = safeExternalURL(entity.page ?? entity.homePage ?? entity.website);
  const allowedKinds = descriptor.kinds ?? ['container'];
  if (allowDeepLink && allowedKinds.includes(kind) && /^[A-Z0-9][A-Z0-9-]{0,127}$/u.test(copyText)) {
    const url = templateURL(descriptor.urlTemplate, copyText, descriptor);
    if (url && descriptor.method === 'GET') return { ...base, method: 'GET', url, mode: 'deep_link', requiresManualEntry: false };
    const fieldTemplate = descriptor.fieldsByKind?.[kind] ?? descriptor.fields;
    if (url && descriptor.method === 'POST' && isObject(fieldTemplate)) {
      const fields = {};
      for (const [name, value] of Object.entries(fieldTemplate)) {
        if (!/^[A-Za-z0-9_\-]{1,80}$/u.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name) || typeof value !== 'string' || value.length > 1000) return page ? { ...base, method: 'GET', url: page, mode: 'manual_entry', requiresManualEntry: true } : null;
        const expanded = value.replaceAll('{num}', copyText);
        if (/\{[^}]*\}|[\u0000-\u001f\u007f]/u.test(expanded)) return null;
        fields[name] = expanded;
      }
      return { ...base, method: 'POST', url, fields, mode: 'deep_link', requiresManualEntry: false };
    }
  }
  return page ? { ...base, method: 'GET', url: page, mode: 'manual_entry', requiresManualEntry: true } : null;
}

function identifiers(input) {
  const values = input.identifiers ?? input.query;
  if (Array.isArray(values)) {
    if (!values.length || values.length > 10000) throw new TypeError('Provide 1 to 10000 identifiers.');
    return values;
  }
  if (typeof values !== 'string' || values.length > 500000) throw new TypeError('Provide identifier text of at most 500000 characters.');
  // Keep each raw line intact. Normalization belongs in the per-row result and
  // must not discard the user's original fullwidth characters or whitespace.
  const parts = values.split(/[\r\n,;，；]+/u).filter(part => part.trim());
  if (!parts.length) throw new TypeError('Provide an identifier.');
  if (parts.length > 10000) throw new TypeError('At most 10000 identifiers are supported.');
  return parts;
}

function consolidateOwnerEvidence(records) {
  const groups = new Map();
  for (const record of records) { const rows = groups.get(record.code) ?? []; rows.push(record); groups.set(record.code, rows); }
  return [...groups.values()].map(rows => {
    const directory = rows.filter(row => row.source === 'carrier_directory');
    const registry = rows.filter(row => row.source === 'owner_snapshot');
    const preferred = directory[0] ?? rows[0];
    const directoryNames = new Set(directory.flatMap(row => [norm(row.name), norm(row.en)]).filter(Boolean));
    const registryNames = unique(registry.map(row => row.name), value => norm(value));
    const nameConflict = new Set(directory.map(row => row.carrierId)).size > 1
      || registryNames.length > 1 || directory.length > 0 && registryNames.some(name => !directoryNames.has(norm(name)));
    const sources = [...new Set(rows.map(row => row.source))];
    return { ...preferred, source: sources.length > 1 ? 'combined_reference' : preferred.source, sources,
      sourceNames: unique(rows.map(row => ({ name: row.name, source: row.source })), row => `${row.source}:${norm(row.name)}`),
      registryName: registryNames.length === 1 ? registryNames[0] : null, registryNames,
      entityTypes: [...new Set(rows.map(row => row.entityType))], nameConflict, ambiguous: nameConflict,
      sourceDate: registry[0]?.sourceDate ?? preferred.sourceDate ?? null,
      officiallyVerified: false,
    };
  });
}

function analyzeIdentifier(raw, input, catalog, indexes) {
  const object = isObject(raw), original = object ? raw.value ?? raw.identifier : raw;
  const requestedKind = object ? raw.kind ?? raw.hint ?? input.kind ?? 'auto' : input.kind ?? 'auto';
  const hint = requestedKind === 'bol' ? 'bill_of_lading' : requestedKind;
  if (!KINDS.has(hint)) throw new TypeError('kind must be auto, container, bill_of_lading or booking.');
  if (typeof original !== 'string') return { original: null, normalized: null, kind: 'unknown', validation: 'invalid', ownerCandidates: [], carrierCandidates: [], trackingActions: [], warnings: ['Identifiers must be strings; numeric JSON values are not accepted because leading zeroes may be lost.'], actualExistence: { status: 'not_checked' } };
  const checkedText = text(original, 2048), compact = normalizeContainerNumber(checkedText), normalizedDocument = normalizeIdentifier(checkedText);
  const containerValidation = validateContainerNumber(original);
  const containerShape = /^[A-Z]{4}\d{7}$/u.test(compact);
  const incompleteContainer = /^[A-Z]{3}[UJZ]\d{0,6}$/u.test(compact);
  const useContainerNormalization = hint === 'container' || (hint === 'auto' && (containerShape || incompleteContainer));
  const normalized = useContainerNormalization ? compact : normalizedDocument;
  const prefix = compact.slice(0, 4);
  const prefixRows = /^[A-Z]{3}[UJZ]$/u.test(prefix) ? indexes.carrierPrefixes.get(prefix) ?? [] : [];
  const registryOwners = /^[A-Z]{3}[UJZ]$/u.test(prefix) ? indexes.ownerPrefixes.get(prefix) ?? [] : [];
  const documentRows = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(normalizedDocument) && normalizedDocument.length <= 128
    ? [...indexes.scac].filter(([label]) => normalizedDocument.startsWith(label) && normalizedDocument.length > label.length).flatMap(([, rows]) => rows) : [];
  let kind = hint === 'auto' ? containerShape || incompleteContainer ? 'container' : documentRows.length ? 'bill_of_lading' : 'unknown' : hint;
  const warnings = [];
  let basis = hint !== 'auto' ? 'explicit_user_hint' : kind === 'container' ? 'container_structure' : documentRows.length ? 'scac_prefix_candidate' : /^\d+$/u.test(normalizedDocument) ? 'numeric_reference_requires_carrier' : 'insufficient_evidence';
  if (kind === 'bill_of_lading' && hint === 'auto') warnings.push('Known SCAC-like prefix is a document candidate only; it does not certify a bill of lading or exclude a booking reference.');
  if (hint === 'auto' && containerShape && documentRows.length) warnings.push('This string also has a document-prefix candidate; the apparent container structure does not establish document type. Supply the original document context if needed.');
  if (hint === 'booking' || hint === 'bill_of_lading') warnings.push('The selected document kind is user intent, not proof of an actual carrier record.');
  const ownerCandidates = consolidateOwnerEvidence([
    ...prefixRows.map(row => ({ code: prefix, ownerCode: prefix.slice(0, 3), name: row.name, en: row.en, entityType: row.type, carrierId: row.id, source: 'carrier_directory', officiallyVerified: false, website: safeExternalURL(row.page) })),
    ...registryOwners.map(row => ({ code: row.code, ownerCode: row.ownerCode ?? row.code.slice(0, 3), name: row.name, entityType: 'registry', source: 'owner_snapshot', sourceDate: row.sourceDate ?? null, officiallyVerified: false, website: safeExternalURL(row.homePage ?? row.website) })),
  ]);
  const manualId = object ? raw.carrierId ?? input.carrierId : input.carrierId;
  const manual = manualId ? indexes.carrierIds.get(manualId) : null;
  if (manualId && !manual) throw new TypeError('Selected carrier ID does not exist.');
  const candidateSource = manual ? [manual] : kind === 'container' ? prefixRows.filter(row => row.type === 'carrier') : documentRows.filter(row => row.type === 'carrier');
  const carrierCandidates = unique(candidateSource, row => row.id).map(row => ({ ...carrierRow(row),
    evidence: manual ? 'manual_selection' : kind === 'container' ? 'container_prefix_candidate' : 'scac_prefix_candidate', confirmed: false }));
  if (carrierCandidates.length > 1) warnings.push('Multiple carrier candidates remain; none has been selected automatically.');
  if (ownerCandidates.length) warnings.push('Owner/lessor matches do not confirm the shipment operating carrier.');
  if (ownerCandidates.some(row => row.nameConflict)) warnings.push('Historical name sources differ for this owner code; all source labels are retained and current ownership remains unverified.');
  if (!carrierCandidates.length && kind !== 'container') warnings.push('Choose the actual carrier from the document; no carrier is inferred from number length alone.');
  if (kind === 'container' && !containerValidation.iso6346Valid) warnings.push('Container format/checksum failed or is incomplete; the original number has not been corrected.');
  const actions = carrierCandidates.map(row => trackingAction(indexes.carrierIds.get(row.id), normalized, {
    kind, allowDeepLink: kind === 'container' && containerValidation.iso6346Valid
      || kind === 'bill_of_lading' && (hint === 'bill_of_lading' || Boolean(manual)) && /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(normalized) && normalized.length <= 128,
  })).filter(Boolean);
  if (!actions.length && kind === 'container') for (const owner of registryOwners) {
    const action = trackingAction({ ...owner, id: owner.code }, normalized, { kind, allowDeepLink: containerValidation.iso6346Valid });
    if (action) actions.push({ ...action, ownerWebsiteOnly: true });
  }
  const validation = kind === 'container' ? containerValidation.iso6346Valid ? 'iso6346_valid' : 'invalid'
    : kind === 'unknown' ? 'unresolved' : /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(normalized) && normalized.length <= 128 ? 'unverified_reference' : 'invalid';
  if (carrierCandidates.length > 1 && kind !== 'container' && hint === 'auto') { kind = 'ambiguous'; basis = 'multiple_carrier_candidates'; }
  return { original, input: original, normalized, kind, basis, hint, validation, containerValidation,
    classification: { kind, basis, candidateCarrierCount: carrierCandidates.length, confirmed: false }, ownerCandidates, carrierCandidates,
    trackingActions: unique(actions, action => `${action.carrierId}:${action.method}:${action.url}`), warnings,
    actualExistence: { status: 'not_checked', explanation: 'No carrier, equipment, booking, shipment, document or live registry was queried.' } };
}

function portRow(row) {
  return { id: row.id ?? String(row.code).toLowerCase(), code: row.code, name: row.name, en: row.en ?? '',
    country: row.country ?? '', countryName: row.countryName ?? '', region: row.region ?? '', regionName: row.regionName ?? '',
    continent: row.continent ?? '', continentName: row.continentName ?? '', lat: Number.isFinite(row.lat) ? row.lat : null, lon: Number.isFinite(row.lon) ? row.lon : null,
    main: Boolean(row.main), mainPort: Boolean(row.main), aliases: [...(row.aliases ?? [])], lanes: [...(row.lanes ?? [])],
    codeDuplicateCount: Number.isSafeInteger(row.codeDuplicateCount) && row.codeDuplicateCount > 1 ? row.codeDuplicateCount : 1,
    sourceCodeStatus: row.sourceCodeStatus ?? 'reference_not_officially_verified' };
}
function filterPort(row, input) {
  return (!input.country || [row.country, row.countryName].some(value => norm(value) === norm(input.country)))
    && (!input.continent || [row.continent, row.continentName].some(value => norm(value) === norm(input.continent)))
    && (!input.lane || (row.lanes ?? []).some(lane => norm(lane) === norm(input.lane)));
}
const validPoint = row => Number.isFinite(row.lat) && Number.isFinite(row.lon) && Math.abs(row.lat) <= 90 && Math.abs(row.lon) <= 180;
export function haversineKm(a, b) {
  if (!validPoint(a) || !validPoint(b)) return null;
  const rad = angle => angle * Math.PI / 180, dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const term = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(Math.min(1, term)), Math.sqrt(Math.max(0, 1 - term)));
}
function detailPort(row, catalog) {
  const value = portRow(row), neighbors = validPoint(value) ? catalog.ports.filter(port => port.code !== row.code && validPoint(port))
    .map(port => ({ ...portRow(port), distanceKm: Math.round(haversineKm(value, port) * 10) / 10 }))
    .sort((a, b) => a.distanceKm - b.distanceKm || String(a.code).localeCompare(String(b.code))).slice(0, 8) : [];
  const lanes = new Set(row.lanes ?? []);
  const sameLane = lanes.size ? catalog.ports.filter(port => port.code !== row.code && (port.lanes ?? []).some(lane => lanes.has(lane))).slice(0, 20).map(portRow) : [];
  const mapLinks = validPoint(value) ? [
    { name: 'Google Maps', url: `https://www.google.com/maps/search/?api=1&query=${value.lat}%2C${value.lon}` },
    { name: 'OpenStreetMap', url: `https://www.openstreetmap.org/?mlat=${value.lat}&mlon=${value.lon}#map=10/${value.lat}/${value.lon}` },
  ] : [{ name: 'Google Maps', url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${value.name} ${value.en} port`)}` }];
  return { ...value, neighbors, sameLane, mapLinks, coordinateStatus: 'reference_coordinates_not_independently_verified', laneGroupingBasis: 'geographic_browsing_reference_not_a_sailing_service' };
}
function filterStats(rows, field, labelField, definitions = []) {
  const result = new Map();
  for (const definition of definitions) result.set(definition.id, { value: definition.id, label: definition.name ?? definition.id, count: 0,
    ...(definition.continent ? { continent: definition.continent } : {}), ...(definition.region ? { region: definition.region } : {}) });
  for (const row of rows) if (row[field]) {
    const values = Array.isArray(row[field]) ? row[field] : [row[field]];
    for (const value of values) { const existing = result.get(value) ?? { value, label: row[labelField] || value, count: 0 }; existing.count++; result.set(value, existing); }
  }
  return [...result.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function executeQuery(input, catalog) {
  if (!isObject(input) || !COMMANDS.has(input.command)) throw new TypeError('Unsupported freight command.');
  const indexes = indexCatalog(catalog);
  if (input.command === 'track') {
    if (input.kind !== undefined && !KINDS.has(input.kind === 'bol' ? 'bill_of_lading' : input.kind)) throw new TypeError('Unsupported identifier kind.');
    if (input.carrierId && !indexes.carrierIds.has(input.carrierId)) throw new TypeError('Selected carrier ID does not exist.');
    const rows = identifiers(input).map(value => {
      try { return analyzeIdentifier(value, input, catalog, indexes); }
      catch (error) { return { original: typeof value === 'string' ? value : typeof value?.value === 'string' ? value.value : null,
        normalized: null, kind: 'unknown', validation: 'invalid', ownerCandidates: [], carrierCandidates: [], trackingActions: [],
        error: { code: 'INVALID_IDENTIFIER', message: error.message }, warnings: ['This row was not processed; the remaining batch rows are independent.'], actualExistence: { status: 'not_checked' } }; }
    });
    return envelope(input, rows, catalog, ['Offline validation and reference candidates only; opening a link is not a successful live tracking query.'], { max: 10000, defaultLimit: Math.max(1, rows.length), extras: { aggregators: linkRows(catalog.aggregators), summary: { total: rows.length, validContainers: rows.filter(row => row.containerValidation?.iso6346Valid).length, invalid: rows.filter(row => row.validation === 'invalid').length, unresolved: rows.filter(row => ['unknown', 'ambiguous'].includes(row.kind)).length } } });
  }
  const query = text(input.query ?? '', 300);
  if (input.command === 'carriers') {
    const rows = catalog.carriers.filter(row => matches(query, [row.id, row.name, row.en, row.country, ...(row.prefixes ?? []), ...(row.bl ?? [])])).map(carrierRow);
    return envelope(input, rows, catalog, ['Directory and prefix candidates only; container lessors are distinct from operating carriers.']);
  }
  if (input.command === 'ports') {
    const rows = catalog.ports.filter(row => filterPort(row, input) && matches(query, [row.code, row.name, row.en, row.country, row.countryName, row.region, row.regionName, row.continent, row.continentName, ...(row.aliases ?? [])])).map(portRow);
    return envelope(input, rows, catalog, ['Port codes, aliases and coordinates are reference data; a port is distinct from a specific terminal or depot.']);
  }
  if (input.command === 'port') {
    if (!query && !input.portId) throw new TypeError('Provide a port code, alias, exact name or portId.');
    const selectedPort = input.portId ? indexes.portIds.get(text(input.portId, 100).toLowerCase()) : null;
    if (input.portId && !selectedPort) throw new TypeError('Selected port ID does not exist.');
    const exact = selectedPort ? [selectedPort] : indexes.portCodes.get(query.toUpperCase())
      ?? (indexes.portIds.has(query.toLowerCase()) ? [indexes.portIds.get(query.toLowerCase())] : catalog.ports.filter(row => [row.name, row.en].some(value => norm(value) === norm(query))));
    const rows = unique(exact, row => row.id ?? row.code).map(row => detailPort(row, catalog));
    return envelope(input, rows, catalog, ['Nearby distances use the haversine formula on reference coordinates, not road or sailing distances.', 'Lane groupings are geographic browsing aids, not evidence of a carrier service or sailing route.', ...(rows.length > 1 ? ['More than one reference record matches this code; select a unique port ID rather than assuming one record.'] : [])]);
  }
  if (input.command === 'roro') {
    const rows = catalog.roro.filter(row => matches(query, [row.id, row.name, row.en, row.country])).map(row => ({
      id: row.id, name: row.name, en: row.en ?? '', country: row.country ?? '', group: row.group, china: Boolean(row.china),
      page: safeExternalURL(row.page), schedule: safeExternalURL(row.schedule),
      scheduleStatus: safeExternalURL(row.schedule) ? 'snapshot_link_only' : 'not_listed_in_snapshot',
    }));
    return envelope(input, rows, catalog, ['Schedule links only; actual dates, voyages and capacity have not been retrieved.'], { extras: { tools: linkRows(catalog.roroTools) } });
  }
  if (input.command === 'types') {
    const rows = catalog.types.map(row => ({ id: row.id, label: row.label ?? row.name ?? '', codes: row.codes ?? (row.code ? [row.code] : []),
      dimensions: row.dimensions ?? '', approximateCapacity: row.approximateCapacity ?? row.capacity ?? '', indicative: true }))
      .filter(row => matches(query, [row.id, row.label, ...row.codes, row.dimensions]));
    return envelope(input, rows, catalog, ['Dimensions, volume and payload are indicative; confirm the actual equipment plate and carrier specification.']);
  }
  if (input.command === 'vessel') {
    if (!query || query === '*') throw new TypeError('Provide a vessel name, IMO or MMSI.');
    const rows = (catalog.vesselSources ?? []).map(source => {
      const template = source.urlTemplate ?? source.url;
      const url = typeof template === 'string' && template.includes('{q}') ? safeExternalURL(template.replaceAll('{q}', encodeURIComponent(query))) : safeExternalURL(source.page ?? template);
      return url ? { id: source.id, name: source.name, url, ...(source.requiresManualEntry || source.copy ? { requiresManualEntry: true, textToEnter: query } : {}) } : null;
    }).filter(Boolean);
    return envelope(input, rows, catalog, ['External search links only; no AIS position, identity, timestamp or ETA was retrieved. Confirm IMO/MMSI for vessels with identical names.']);
  }
  const counts = { carriers: catalog.carriers.length, shippingLines: catalog.carriers.filter(row => row.type === 'carrier').length,
    lessors: catalog.carriers.filter(row => row.type === 'leasing').length, roro: catalog.roro.length, types: catalog.types.length, ports: catalog.ports.length,
    ownerPrefixes: catalog.owners.length, uniqueOwnerCodes: indexes.ownerPrefixes.size,
    uniquePortCodes: new Set(catalog.ports.map(row => row.code)).size,
    countries: catalog.countries?.length ?? 0, regions: catalog.regions?.length ?? 0, continents: catalog.continents?.length ?? 0, lanes: catalog.lanes?.length ?? 0,
    deepTrackingCarriers: catalog.carriers.filter(row => ['GET', 'POST'].includes(row.tracking?.method)).length };
  const filters = { countries: filterStats(catalog.ports, 'country', 'countryName', catalog.countries), continents: filterStats(catalog.ports, 'continent', 'continentName', catalog.continents), lanes: filterStats(catalog.ports, 'lanes', 'laneName', catalog.lanes) };
  return envelope(input, [{ counts, filters }], catalog, ['Counts describe the installed reference snapshot, not live service coverage or verified registry status.'], { extras: { counts, filters } });
}
