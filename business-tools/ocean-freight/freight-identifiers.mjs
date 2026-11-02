/** Independently authored, browser-safe offline ISO 6346 and classification helpers.
 * A checksum, an injected prefix rule, or an owner-code match is not evidence
 * that a physical container, shipment, booking, or transport document exists. */

const INTERNAL_REGISTRY = Symbol('validated registry');
const CATEGORIES = Object.freeze({
  U: 'Freight containers',
  J: 'Detachable freight-container-related equipment',
  Z: 'Trailers and chassis',
});
const DOCUMENT_KINDS = Object.freeze(['bill_of_lading', 'booking']);
const HINTS = new Set(['auto', 'container', ...DOCUMENT_KINDS]);
const MAX_INPUT_CHARACTERS = 2048;
export const LIMITS = Object.freeze({ batchSize: 10000, inputCharacters: MAX_INPUT_CHARACTERS, registryRules: 1000, registryOwners: 1000 });

function boundedString(value, label, max, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} must be ${empty ? '' : 'nonempty '}text of at most ${max} characters without control characters.`);
  return value.trim();
}

/** Preserve punctuation in general document references: a hyphen can be part of
 * a carrier's real reference. Container grouping separators are handled below. */
export function normalizeIdentifier(value) {
  if (typeof value !== 'string') throw new TypeError('Identifier must be a string.');
  if (value.length > MAX_INPUT_CHARACTERS) throw new RangeError(`Identifier exceeds ${MAX_INPUT_CHARACTERS} characters.`);
  return value.normalize('NFKC').trim().toUpperCase();
}

export function normalizeContainerNumber(value) {
  return normalizeIdentifier(value).replace(/[\p{White_Space}\-\u2010-\u2015\u2212]/gu, '');
}

function checksum(prefix) {
  let sum = 0;
  for (let index = 0; index < prefix.length; index++) {
    const character = prefix[index];
    // Letter values start at 10 and omit multiples of 11: A=10, B=12,
    // K=21, L=23, U=32, V=34, Z=38.
    const ordinal = character.charCodeAt(0) - 65;
    const value = /[0-9]/u.test(character) ? Number(character) : 10 + ordinal + Math.floor((ordinal + 9) / 10);
    sum += value * 2 ** index;
  }
  const remainder = sum % 11;
  return { weightedSum: sum, remainder, checkDigit: remainder === 10 ? 0 : remainder };
}

/** Accept exactly an owner/category/serial prefix, without a check digit. */
export function calculateContainerCheckDigit(value) {
  const prefix = normalizeContainerNumber(value);
  if (!/^[A-Z]{3}[UJZ][0-9]{6}$/u.test(prefix)) throw new TypeError('Container checksum input must contain 3 ASCII owner letters, category U/J/Z and 6 ASCII serial digits, without the check digit.');
  return checksum(prefix).checkDigit;
}

export function validateContainerNumber(input) {
  const result = {
    input: typeof input === 'string' ? input : null,
    normalized: null,
    normalizationChanged: false,
    formatValid: false,
    equipmentCategoryValid: false,
    checksumValid: null,
    iso6346Valid: false,
    ownerCode: null,
    equipmentCategory: null,
    equipmentDescription: null,
    serialNumber: null,
    providedCheckDigit: null,
    expectedCheckDigit: null,
    checksumRemainder: null,
    issues: [],
    actualExistence: { status: 'not_checked', explanation: 'Offline format/checksum validation does not verify BIC owner allocation, physical equipment, shipment activity, or carrier records.' },
  };
  let normalized;
  try { normalized = normalizeContainerNumber(input); }
  catch (error) { result.issues.push({ code: typeof input === 'string' ? 'input_too_long' : 'input_not_string', message: error.message }); return result; }
  result.normalized = normalized;
  result.normalizationChanged = normalized !== input;
  // A lexically correct 4-letter/7-digit string can still have an invalid
  // equipment category. Report the two failures separately.
  if (!/^[A-Z]{4}[0-9]{7}$/u.test(normalized)) {
    result.issues.push({ code: 'invalid_format', message: 'Expected exactly 4 ASCII letters and 7 ASCII digits (3 owner letters, category U/J/Z, 6 serial digits, 1 check digit).' });
    return result;
  }
  result.formatValid = true;
  result.ownerCode = normalized.slice(0, 3);
  result.equipmentCategory = normalized[3];
  result.serialNumber = normalized.slice(4, 10);
  result.providedCheckDigit = Number(normalized[10]);
  if (!Object.hasOwn(CATEGORIES, result.equipmentCategory)) {
    result.issues.push({ code: 'invalid_equipment_category', message: 'ISO 6346 equipment category must be U, J or Z.' });
    return result;
  }
  result.equipmentCategoryValid = true;
  result.equipmentDescription = CATEGORIES[result.equipmentCategory];
  const calculated = checksum(normalized.slice(0, 10));
  result.expectedCheckDigit = calculated.checkDigit;
  result.checksumRemainder = calculated.remainder;
  result.checksumValid = result.providedCheckDigit === calculated.checkDigit;
  result.iso6346Valid = result.checksumValid;
  if (!result.checksumValid) result.issues.push({ code: 'checksum_mismatch', message: `The check digit is ${result.providedCheckDigit}; the ISO 6346 calculation expects ${result.expectedCheckDigit}.` });
  return result;
}

/** Registry rules are data, never executable regex or JavaScript. Their matches
 * are candidate hints supplied by the caller, not official carrier lookups. */
export function createRegistry(input = { version: 1, rules: [], owners: [] }) {
  if (input?.[INTERNAL_REGISTRY]) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1) throw new TypeError('Registry must be an object with version: 1.');
  const rules = input.rules ?? [], owners = input.owners ?? [];
  if (!Array.isArray(rules) || rules.length > LIMITS.registryRules || !Array.isArray(owners) || owners.length > LIMITS.registryOwners) throw new TypeError('Registry rules/owners must be bounded arrays.');
  const ids = new Set();
  const normalizedRules = rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new TypeError(`Registry rule ${index} must be an object.`);
    const ruleId = boundedString(rule.id, `Rule ${index} id`, 100);
    if (ids.has(ruleId)) throw new TypeError(`Registry rule ${index} has a duplicate id.`);
    ids.add(ruleId);
    if (!DOCUMENT_KINDS.includes(rule.kind)) throw new TypeError(`Registry rule ${index} kind must be bill_of_lading or booking.`);
    const prefix = normalizeIdentifier(boundedString(rule.prefix, `Rule ${index} prefix`, 30));
    if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(prefix)) throw new TypeError(`Registry rule ${index} prefix must use ASCII letters/digits and optional internal hyphens.`);
    if (!Number.isSafeInteger(rule.minLength) || !Number.isSafeInteger(rule.maxLength) || rule.minLength < prefix.length || rule.maxLength < rule.minLength || rule.maxLength > 128) throw new TypeError(`Registry rule ${index} length bounds are invalid.`);
    const characterSet = rule.characterSet ?? 'alphanumeric';
    if (!['alphanumeric', 'alphanumeric-hyphen'].includes(characterSet)) throw new TypeError(`Registry rule ${index} characterSet is unsupported.`);
    if (characterSet === 'alphanumeric' && prefix.includes('-')) throw new TypeError(`Registry rule ${index} prefix conflicts with its characterSet.`);
    return Object.freeze({ id: ruleId, kind: rule.kind, prefix, minLength: rule.minLength, maxLength: rule.maxLength, characterSet,
      ...(rule.carrierId !== undefined ? { carrierId: boundedString(rule.carrierId, `Rule ${index} carrierId`, 100) } : {}),
      ...(rule.carrierName !== undefined ? { carrierName: boundedString(rule.carrierName, `Rule ${index} carrierName`, 160) } : {}) });
  });
  const ownerCodes = new Set();
  const normalizedOwners = owners.map((owner, index) => {
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) throw new TypeError(`Registry owner ${index} must be an object.`);
    const ownerCode = normalizeIdentifier(boundedString(owner.ownerCode, `Owner ${index} ownerCode`, 3));
    if (!/^[A-Z]{3}$/u.test(ownerCode) || ownerCodes.has(ownerCode)) throw new TypeError(`Registry owner ${index} code is invalid or duplicated.`);
    ownerCodes.add(ownerCode);
    return Object.freeze({ ownerCode, name: boundedString(owner.name, `Owner ${index} name`, 160) });
  });
  return Object.freeze({ version: 1, rules: Object.freeze(normalizedRules), owners: Object.freeze(normalizedOwners), [INTERNAL_REGISTRY]: true });
}

export const EMPTY_REGISTRY = createRegistry();

function documentSyntax(value, characterSet = 'alphanumeric-hyphen') {
  return value.length >= 1 && value.length <= 128 && (characterSet === 'alphanumeric' ? /^[A-Z0-9]+$/u : /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u).test(value);
}

export function classifyIdentifier(input, { registry = EMPTY_REGISTRY, hint = 'auto' } = {}) {
  if (!HINTS.has(hint)) throw new TypeError('Hint must be auto, container, bill_of_lading or booking.');
  const checkedRegistry = createRegistry(registry);
  const container = validateContainerNumber(input);
  let normalized = null;
  try { normalized = normalizeIdentifier(input); } catch { /* Per-item validation remains a batch result. */ }
  const matches = normalized === null ? [] : checkedRegistry.rules.filter(rule => normalized.startsWith(rule.prefix) && normalized.length >= rule.minLength && normalized.length <= rule.maxLength && documentSyntax(normalized, rule.characterSet));
  const candidates = [];
  if (container.formatValid && container.equipmentCategoryValid) candidates.push({ kind: 'container', basis: 'iso6346_structure', iso6346Valid: container.iso6346Valid });
  for (const kind of DOCUMENT_KINDS) {
    const selected = matches.filter(rule => rule.kind === kind);
    if (selected.length) candidates.push({ kind, basis: 'injected_prefix_rules', ruleIds: selected.map(rule => rule.id), carriers: selected.filter(rule => rule.carrierId || rule.carrierName).map(rule => ({ ...(rule.carrierId ? { id: rule.carrierId } : {}), ...(rule.carrierName ? { name: rule.carrierName } : {}) })) });
  }
  let kind = candidates.length === 1 ? candidates[0].kind : candidates.length > 1 ? 'ambiguous' : 'unknown';
  let basis = candidates.length === 1 ? candidates[0].basis : candidates.length > 1 ? 'multiple_candidate_kinds' : 'insufficient_evidence';
  let validation = normalized === null || normalized === '' ? 'invalid' : kind === 'container' ? container.iso6346Valid ? 'iso6346_valid' : 'invalid' : kind === 'unknown' || kind === 'ambiguous' ? 'unresolved' : 'unverified_reference';
  const warnings = [];
  if (hint !== 'auto') {
    kind = hint; basis = 'explicit_user_hint';
    validation = hint === 'container' ? container.iso6346Valid ? 'iso6346_valid' : 'invalid' : normalized !== null && documentSyntax(normalized) ? 'unverified_reference' : 'invalid';
    if (candidates.length && !candidates.some(candidate => candidate.kind === hint)) warnings.push('The explicit hint conflicts with the automatically found candidate kinds.');
    if (hint !== 'container') warnings.push('A supplied document kind is user intent, not proof of a valid booking or bill of lading.');
  }
  const owner = container.ownerCode ? checkedRegistry.owners.find(item => item.ownerCode === container.ownerCode) : undefined;
  return { input: typeof input === 'string' ? input : null, normalized, kind, basis, validation, candidates, hint, containerValidation: container,
    ownerRegistry: { status: owner ? 'provided_registry_match' : checkedRegistry.owners.length ? 'not_in_provided_registry' : 'not_checked', ...(owner ? { ownerCode: owner.ownerCode, name: owner.name } : {}), explanation: 'Caller-supplied owner data is not a live BIC allocation check and says nothing about a specific container existing.' },
    actualExistence: { status: 'not_checked', explanation: 'No carrier, container, booking, bill-of-lading or shipment registry was queried.' },
    warnings: [...warnings, ...(kind === 'ambiguous' ? ['More than one identifier kind matches; request the original document context or an explicit kind.'] : []), ...(kind === 'unknown' ? ['Do not infer a bill-of-lading or booking kind from length alone; supply context or a verified carrier rule registry.'] : [])] };
}

export function analyzeBatch(identifiers, options = {}) {
  if (!Array.isArray(identifiers) || identifiers.length > LIMITS.batchSize) throw new TypeError(`Batch must be an array of at most ${LIMITS.batchSize} identifiers.`);
  const registry = createRegistry(options.registry ?? EMPTY_REGISTRY), defaultHint = options.hint ?? 'auto';
  if (!HINTS.has(defaultHint)) throw new TypeError('Batch hint is unsupported.');
  const results = identifiers.map((item, index) => {
    const objectItem = item !== null && typeof item === 'object' && !Array.isArray(item);
    const value = objectItem ? item.value : item, hint = objectItem ? item.hint ?? defaultHint : defaultHint;
    if (!HINTS.has(hint)) return { index, input: typeof value === 'string' ? value : null, kind: 'unknown', validation: 'invalid', error: { code: 'invalid_hint', message: 'Per-item hint is unsupported.' }, actualExistence: { status: 'not_checked' } };
    return { index, ...classifyIdentifier(value, { registry, hint }) };
  });
  const counts = { total: results.length, container: 0, bill_of_lading: 0, booking: 0, ambiguous: 0, unknown: 0, iso6346Valid: 0, invalid: 0 };
  for (const result of results) { counts[result.kind]++; if (result.containerValidation?.iso6346Valid) counts.iso6346Valid++; if (result.validation === 'invalid') counts.invalid++; }
  return { schemaVersion: 1, offline: true, registry: { rules: registry.rules.length, owners: registry.owners.length, source: registry === EMPTY_REGISTRY ? 'default_empty' : 'caller_supplied' }, summary: counts, results };
}
