'use strict';

const LIMITS = Object.freeze({
  maxPredicateLength: 256,
  maxArrayEntries: 32,
  maxAndTerms: 16,
  maxNumericComponents: 16,
  maxPrereleaseIds: 16,
  maxIdentifierLength: 64,
  maxCacheSize: 256,
});

const WILDCARD = Number.MIN_SAFE_INTEGER;
const UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;
const DOT_SEPARATED_ID = /^[-0-9A-Za-z]+(?:\.[-0-9A-Za-z]+)*$/;
const NUMERIC_COMPONENT = /^[0-9]+$/;
const OPERATORS = Object.freeze([
  { token: '>=', id: '>=', minInclusive: true, maxInclusive: false },
  { token: '<=', id: '<=', minInclusive: false, maxInclusive: true },
  { token: '>', id: '>', minInclusive: false, maxInclusive: false },
  { token: '<', id: '<', minInclusive: false, maxInclusive: false },
  { token: '=', id: '=', minInclusive: true, maxInclusive: true },
  { token: '~', id: '~', minInclusive: true, maxInclusive: false },
  { token: '^', id: '^', minInclusive: true, maxInclusive: false },
]);

const predicateCache = new Map();

class FabricPredicateError extends Error {
  constructor(message, { predicate = '', code = 'FABRIC_PREDICATE_INVALID' } = {}) {
    super(message);
    this.name = 'FabricPredicateError';
    this.code = code;
    this.predicate = predicate;
  }
}

function isLimitError(err) {
  return err instanceof FabricPredicateError && err.code === 'FABRIC_PREDICATE_LIMIT';
}

function tooComplex(predicate, detail) {
  return new FabricPredicateError(
    detail || 'The Fabric version requirement is too complex to evaluate safely.',
    { predicate, code: 'FABRIC_PREDICATE_LIMIT' }
  );
}

function invalidPredicate(predicate, detail) {
  return new FabricPredicateError(
    detail || `The mod contains a Fabric version requirement that Minecraft Manager could not interpret: ${predicate}.`,
    { predicate, code: 'FABRIC_PREDICATE_INVALID' }
  );
}

function assertLength(value, predicate) {
  if (String(value || '').length > LIMITS.maxPredicateLength) {
    throw tooComplex(predicate || value, 'The Fabric version requirement is too long to evaluate safely.');
  }
}

function assertIdentifier(value, predicate) {
  if (String(value || '').length > LIMITS.maxIdentifierLength) {
    throw tooComplex(predicate, 'A Fabric version identifier is too long to evaluate safely.');
  }
}

function cloneVersion(version) {
  if (!version) return version;
  return {
    raw: version.raw,
    semantic: version.semantic,
    components: version.components ? version.components.slice() : [],
    prerelease: version.prerelease ? version.prerelease.slice() : [],
    hasPrerelease: Boolean(version.hasPrerelease),
    hasEmptyPrerelease: Boolean(version.hasEmptyPrerelease),
    build: version.build,
    wildcard: Boolean(version.wildcard),
  };
}

function versionFromComponents(components, prereleaseRaw, build, rawHint) {
  const hasPrerelease = prereleaseRaw != null;
  const prerelease = hasPrerelease && prereleaseRaw !== ''
    ? String(prereleaseRaw).split('.')
    : [];
  const rawComponents = components.join('.');
  const raw = rawHint
    || `${rawComponents}${hasPrerelease ? `-${prereleaseRaw}` : ''}${build ? `+${build}` : ''}`;
  return {
    raw,
    semantic: true,
    components: components.slice(),
    prerelease,
    hasPrerelease,
    hasEmptyPrerelease: hasPrerelease && prerelease.length === 0,
    build: build || null,
    wildcard: false,
  };
}

function parseSemanticVersion(raw, { allowWildcard = false } = {}) {
  let rest = String(raw);
  let build = null;
  const plus = rest.indexOf('+');
  if (plus >= 0) {
    build = rest.slice(plus + 1);
    rest = rest.slice(0, plus);
    if (build !== '' && !DOT_SEPARATED_ID.test(build)) {
      throw invalidPredicate(raw, `Invalid Fabric version build metadata: ${raw}`);
    }
    const buildParts = build ? build.split('.') : [];
    if (buildParts.length > LIMITS.maxPrereleaseIds) {
      throw tooComplex(raw);
    }
    for (const part of buildParts) assertIdentifier(part, raw);
  }

  let prereleaseRaw = null;
  const dash = rest.indexOf('-');
  if (dash >= 0) {
    prereleaseRaw = rest.slice(dash + 1);
    rest = rest.slice(0, dash);
    if (prereleaseRaw !== '' && !DOT_SEPARATED_ID.test(prereleaseRaw)) {
      throw invalidPredicate(raw, `Invalid Fabric version prerelease: ${raw}`);
    }
  }

  if (rest.endsWith('.')) {
    throw invalidPredicate(raw, `Invalid Fabric version: ${raw}`);
  }
  if (!rest) {
    throw invalidPredicate(raw, `Invalid Fabric version: ${raw}`);
  }

  const parts = rest.split('.');
  if (parts.length > LIMITS.maxNumericComponents) {
    throw tooComplex(raw);
  }

  const components = [];
  let sawWildcard = false;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (allowWildcard && (part === 'x' || part === 'X' || part === '*')) {
      if (i === 0) {
        throw invalidPredicate(raw, `Invalid Fabric wildcard version: ${raw}`);
      }
      if (prereleaseRaw != null) {
        throw invalidPredicate(raw, `Invalid Fabric wildcard version: ${raw}`);
      }
      if (sawWildcard) {
        continue;
      }
      components.push(WILDCARD);
      sawWildcard = true;
      continue;
    }
    if (sawWildcard) {
      throw invalidPredicate(raw, `Invalid Fabric wildcard version: ${raw}`);
    }
    if (!part || !NUMERIC_COMPONENT.test(part)) {
      throw invalidPredicate(raw, `Invalid Fabric version: ${raw}`);
    }
    if (part.length > 10) {
      throw tooComplex(raw);
    }
    const numeric = Number(part);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 2147483647) {
      throw tooComplex(raw);
    }
    components.push(numeric);
  }

  while (
    components.length > 2
    && components[components.length - 1] === WILDCARD
    && components[components.length - 2] === WILDCARD
  ) {
    components.pop();
  }

  if (sawWildcard && components[0] === WILDCARD) {
    throw invalidPredicate(raw, `Invalid Fabric wildcard version: ${raw}`);
  }

  const prerelease = prereleaseRaw != null && prereleaseRaw !== ''
    ? prereleaseRaw.split('.')
    : [];
  if (prerelease.length > LIMITS.maxPrereleaseIds) {
    throw tooComplex(raw);
  }
  for (const part of prerelease) assertIdentifier(part, raw);

  return {
    raw: String(raw),
    semantic: true,
    components,
    prerelease,
    hasPrerelease: prereleaseRaw != null,
    hasEmptyPrerelease: prereleaseRaw === '',
    build: build || null,
    wildcard: sawWildcard,
  };
}

function parseFabricVersion(value, options = {}) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  assertLength(raw, raw);
  try {
    return parseSemanticVersion(raw, options);
  } catch (err) {
    if (isLimitError(err)) throw err;
    return {
      raw,
      semantic: false,
      components: [],
      prerelease: [],
      hasPrerelease: false,
      hasEmptyPrerelease: false,
      build: null,
      wildcard: false,
    };
  }
}

function getComponent(version, index) {
  if (index < version.components.length) return version.components[index];
  return version.wildcard ? WILDCARD : 0;
}

function compareIdentifiers(left, right) {
  const leftNumeric = UNSIGNED_INTEGER.test(left);
  const rightNumeric = UNSIGNED_INTEGER.test(right);
  if (leftNumeric && rightNumeric) {
    const byLength = left.length - right.length;
    if (byLength) return byLength;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrereleases(left, right) {
  const leftParts = left.prerelease || [];
  const rightParts = right.prerelease || [];
  const shared = Math.min(leftParts.length, rightParts.length);
  for (let i = 0; i < shared; i += 1) {
    const cmp = compareIdentifiers(leftParts[i], rightParts[i]);
    if (cmp) return cmp;
  }
  if (leftParts.length === rightParts.length) return 0;
  return leftParts.length < rightParts.length ? -1 : 1;
}

function compareSemantic(left, right) {
  const max = Math.max(left.components.length, right.components.length);
  for (let i = 0; i < max; i += 1) {
    const a = getComponent(left, i);
    const b = getComponent(right, i);
    if (a === WILDCARD || b === WILDCARD) continue;
    if (a !== b) return a - b;
  }
  if (left.hasPrerelease || right.hasPrerelease) {
    if (left.hasPrerelease && right.hasPrerelease) {
      return comparePrereleases(left, right);
    }
    if (left.hasPrerelease) return right.wildcard ? 0 : -1;
    return left.wildcard ? 0 : 1;
  }
  return 0;
}

function asVersion(value, options) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'semantic')) {
    return value;
  }
  return parseFabricVersion(value, options);
}

function compareFabricVersions(left, right, options = {}) {
  const a = asVersion(left, options);
  const b = asVersion(right, options);
  if (!a || !b) return null;
  if (a.semantic && b.semantic) return compareSemantic(a, b);
  if (a.raw === b.raw) return 0;
  if (options.semanticOnly) return null;
  return a.raw < b.raw ? -1 : 1;
}

function operatorById(id) {
  return OPERATORS.find((item) => item.id === id) || OPERATORS.find((item) => item.id === '=');
}

function testOperator(operator, candidate, reference) {
  const spec = operatorById(operator);
  if (candidate.semantic && reference.semantic) {
    if (operator === '~') {
      return compareSemantic(candidate, reference) >= 0
        && getComponent(candidate, 0) === getComponent(reference, 0)
        && getComponent(candidate, 1) === getComponent(reference, 1);
    }
    if (operator === '^') {
      return compareSemantic(candidate, reference) >= 0
        && getComponent(candidate, 0) === getComponent(reference, 0);
    }
    const cmp = compareSemantic(candidate, reference);
    if (operator === '>') return cmp > 0;
    if (operator === '>=') return cmp >= 0;
    if (operator === '<') return cmp < 0;
    if (operator === '<=') return cmp <= 0;
    return cmp === 0;
  }
  if (spec.minInclusive || spec.maxInclusive) {
    return candidate.raw === reference.raw;
  }
  return false;
}

function emptyPrereleaseVersion(components, build = null) {
  return versionFromComponents(components, '', build);
}

function rewriteWildcardTerm(operator, version, predicate) {
  if (!version.wildcard) return [{ operator, version: cloneVersion(version) }];
  if (operator !== '=') {
    throw invalidPredicate(
      predicate,
      `The mod contains a Fabric version requirement that Minecraft Manager could not interpret: ${predicate}.`
    );
  }
  const kept = version.components.slice(0, -1);
  if (!kept.length) {
    throw invalidPredicate(predicate);
  }
  const lower = emptyPrereleaseVersion(kept, version.build);
  if (version.components.length <= 3) {
    return [{
      operator: version.components.length === 2 ? '^' : '~',
      version: lower,
    }];
  }
  const upperComponents = kept.slice();
  upperComponents[upperComponents.length - 1] += 1;
  return [
    { operator: '>=', version: lower },
    { operator: '<', version: emptyPrereleaseVersion(upperComponents) },
  ];
}

function parseTerm(token, predicate) {
  let operator = '=';
  let rest = token;
  for (const spec of OPERATORS) {
    if (rest.startsWith(spec.token)) {
      operator = spec.id;
      rest = rest.slice(spec.token.length);
      break;
    }
  }
  if (!rest) {
    throw invalidPredicate(predicate);
  }
  const parsed = parseFabricVersion(rest, { allowWildcard: true });
  if (!parsed) {
    throw invalidPredicate(predicate);
  }
  if (!parsed.semantic) {
    const spec = operatorById(operator);
    if (!spec.minInclusive && !spec.maxInclusive) {
      throw invalidPredicate(predicate);
    }
    return [{ operator: '=', version: parsed }];
  }
  return rewriteWildcardTerm(operator, parsed, predicate);
}

function parsePredicateString(value) {
  const text = String(value || '').trim();
  assertLength(text, text);
  if (!text || text === '*') {
    return { type: 'any', raw: text || '*', terms: [] };
  }
  const tokens = text.split(' ');
  const terms = [];
  for (const token of tokens) {
    const part = token.trim();
    if (!part || part === '*') continue;
    terms.push(...parseTerm(part, text));
  }
  if (terms.length > LIMITS.maxAndTerms) {
    throw tooComplex(text);
  }
  if (!terms.length) {
    return { type: 'any', raw: text, terms: [] };
  }
  if (terms.length === 1) {
    return { type: 'term', raw: text, operator: terms[0].operator, version: terms[0].version, terms };
  }
  return { type: 'and', raw: text, terms };
}

function cacheGet(key, factory) {
  if (predicateCache.has(key)) {
    const cached = predicateCache.get(key);
    predicateCache.delete(key);
    predicateCache.set(key, cached);
    return cached;
  }
  const value = factory();
  predicateCache.set(key, value);
  if (predicateCache.size > LIMITS.maxCacheSize) {
    const oldest = predicateCache.keys().next().value;
    predicateCache.delete(oldest);
  }
  return value;
}

function parseFabricPredicate(value) {
  const text = value == null ? '' : String(value);
  assertLength(text, text);
  const cached = cacheGet(`p:${text}`, () => {
    try {
      return { ok: true, predicate: parsePredicateString(text) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof FabricPredicateError
          ? err
          : invalidPredicate(text, err.message),
      };
    }
  });
  if (!cached.ok) throw cached.error;
  return cached.predicate;
}

function omittedRequirement(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return false;
  const text = String(value).trim();
  return !text || text === '*';
}

function formatRequirement(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((item) => String(item)).join(' | ');
  return String(value);
}

function testParsedPredicate(candidateVersion, parsed) {
  if (!parsed || parsed.type === 'any') return true;
  const terms = parsed.terms && parsed.terms.length
    ? parsed.terms
    : [{ operator: parsed.operator, version: parsed.version }];
  return terms.every((term) => testOperator(term.operator, candidateVersion, term.version));
}

function parseErrorResult(candidate, requirement, normalizedCandidate, err) {
  const constraint = formatRequirement(requirement);
  const display = err?.predicate || constraint || String(requirement || '');
  return {
    compatible: false,
    candidate,
    constraint,
    normalizedCandidate,
    parseError: true,
    reason: `The mod contains a Fabric version requirement that Minecraft Manager could not interpret: ${display}.`,
  };
}

function failureReason(candidate, parsed, subject) {
  const terms = parsed?.terms || [];
  if (terms.length === 1 && terms[0].operator === '~' && terms[0].version?.semantic) {
    const major = getComponent(terms[0].version, 0);
    const minor = getComponent(terms[0].version, 1);
    return `${subject} ${candidate} is outside the required ${major}.${minor} version family.`;
  }
  if (terms.length === 1 && terms[0].operator === '^' && terms[0].version?.semantic) {
    const major = getComponent(terms[0].version, 0);
    return `${subject} ${candidate} is outside the required ${major} version family.`;
  }
  const constraint = parsed?.raw || '';
  return `${subject} ${candidate} does not satisfy ${constraint}.`;
}

function normalizeFabricMinecraftVersion(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const dropped = raw.match(/^1\.(2[6-9]|[3-9]\d|\d{3,})(\..*)?$/);
  if (dropped) return `${dropped[1]}${dropped[2] || ''}`;
  return raw;
}

function evaluateOnePredicate(candidate, predicate, options = {}) {
  const rawCandidate = candidate == null ? '' : String(candidate);
  const normalizedCandidate = options.normalizeMinecraft
    ? normalizeFabricMinecraftVersion(rawCandidate)
    : rawCandidate;
  const subject = options.subject || (options.normalizeMinecraft ? 'Minecraft' : 'Version');
  const compareCandidate = normalizedCandidate || rawCandidate;
  if (!compareCandidate) {
    return {
      compatible: false,
      candidate: rawCandidate,
      constraint: formatRequirement(predicate),
      normalizedCandidate,
      reason: `No ${subject.toLowerCase()} version was provided.`,
    };
  }
  try {
    const parsed = parseFabricPredicate(predicate);
    const version = parseFabricVersion(compareCandidate, { allowWildcard: false });
    if (!version) {
      return {
        compatible: false,
        candidate: rawCandidate,
        constraint: formatRequirement(predicate),
        normalizedCandidate,
        reason: `${subject} ${rawCandidate || compareCandidate} is not a valid version.`,
      };
    }
    const compatible = testParsedPredicate(version, parsed);
    return {
      compatible,
      candidate: rawCandidate,
      constraint: formatRequirement(predicate),
      normalizedCandidate,
      reason: compatible ? '' : failureReason(rawCandidate || compareCandidate, parsed, subject),
    };
  } catch (err) {
    if (err instanceof FabricPredicateError) {
      return parseErrorResult(rawCandidate, predicate, normalizedCandidate, err);
    }
    throw err;
  }
}

function evaluateFabricDependency(candidate, requirement, options = {}) {
  const rawCandidate = candidate == null ? '' : String(candidate);
  const normalizedCandidate = options.normalizeMinecraft
    ? normalizeFabricMinecraftVersion(rawCandidate)
    : rawCandidate;
  if (omittedRequirement(requirement)) {
    return {
      compatible: true,
      candidate: rawCandidate,
      constraint: formatRequirement(requirement) || '*',
      normalizedCandidate,
      reason: '',
    };
  }
  if (Array.isArray(requirement)) {
    if (requirement.length > LIMITS.maxArrayEntries) {
      return parseErrorResult(
        rawCandidate,
        requirement,
        normalizedCandidate,
        tooComplex(formatRequirement(requirement))
      );
    }
    if (!requirement.length) {
      return {
        compatible: false,
        candidate: rawCandidate,
        constraint: '',
        normalizedCandidate,
        reason: `${options.subject || 'Version'} ${rawCandidate || normalizedCandidate} does not satisfy an empty version requirement.`,
      };
    }
    const results = requirement.map((item) => evaluateOnePredicate(candidate, item, options));
    const matched = results.find((item) => item.compatible);
    if (matched) return matched;
    const parseFailed = results.find((item) => item.parseError);
    return parseFailed || results[0];
  }
  return evaluateOnePredicate(candidate, requirement, options);
}

function satisfiesFabricPredicate(candidate, predicate) {
  return evaluateOnePredicate(candidate, predicate).compatible;
}

function satisfiesFabricDependency(candidate, requirement, options = {}) {
  return evaluateFabricDependency(candidate, requirement, options).compatible;
}

function clearPredicateCache() {
  predicateCache.clear();
}

module.exports = {
  FabricPredicateError,
  LIMITS,
  clearPredicateCache,
  compareFabricVersions,
  evaluateFabricDependency,
  normalizeFabricMinecraftVersion,
  parseFabricPredicate,
  parseFabricVersion,
  satisfiesFabricDependency,
  satisfiesFabricPredicate,
};
