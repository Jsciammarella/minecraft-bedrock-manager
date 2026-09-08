'use strict';

const FABRIC_API_MOD_ID = 'fabric-api';
const FABRIC_API_LEGACY_MOD_ID = 'fabric';
const FABRIC_LOADER_MOD_ID = 'fabricloader';
const FLOODGATE_MOD_ID = 'floodgate';
const FABRIC_API_PROJECT_ID = 'P7dR8mSH';
const FLOODGATE_PROJECT_ID = 'bWrNNfkb';
const FABRIC_API_MOD_IDS = new Set([FABRIC_API_MOD_ID, FABRIC_API_LEGACY_MOD_ID]);

function canonicalMinecraftVersion(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const dropped = raw.match(/^1\.(2[6-9]|[3-9]\d|\d{3,})(\..*)?$/);
  if (dropped) return `${dropped[1]}${dropped[2] || ''}`;
  return raw;
}

function minecraftVersionsEqual(a, b) {
  const left = canonicalMinecraftVersion(a);
  const right = canonicalMinecraftVersion(b);
  return Boolean(left && right && left === right);
}

function catalogListsExactMinecraft(gameVersions, serverVersion) {
  const wanted = canonicalMinecraftVersion(serverVersion);
  if (!wanted) return false;
  return (Array.isArray(gameVersions) ? gameVersions : []).some((item) => minecraftVersionsEqual(item, wanted));
}

function tokenizeVersion(value) {
  const raw = String(value || '').trim().replace(/^v/i, '');
  if (!raw) return null;
  const match = raw.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.](.+))?$/);
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)],
    pre: match[4] ? String(match[4]) : '',
    raw,
  };
}

function compareVersions(a, b) {
  const left = tokenizeVersion(a);
  const right = tokenizeVersion(b);
  if (!left || !right) return String(a) === String(b) ? 0 : null;
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i];
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre.localeCompare(right.pre, 'en');
}

function compareForKind(a, b, kind) {
  if (kind === 'minecraft') {
    return compareVersions(canonicalMinecraftVersion(a), canonicalMinecraftVersion(b));
  }
  return compareVersions(a, b);
}

function parseMavenRange(text) {
  const match = String(text || '').trim().match(/^([\[(])\s*([^,\[\]]*)\s*,\s*([^,\[\]]*)\s*([\])])$/);
  if (!match) return null;
  return {
    type: 'maven',
    lower: match[2].trim(),
    lowerInclusive: match[1] === '[',
    upper: match[3].trim(),
    upperInclusive: match[4] === ']',
  };
}

function parseConstraintList(raw) {
  const text = String(raw || '').trim();
  if (!text || text === '*' || text.toLowerCase() === 'any') {
    return [{ type: 'any' }];
  }
  const maven = parseMavenRange(text);
  if (maven) return [maven];
  if (/^(\d+)(?:\.(\d+))?\.x$/i.test(text)) {
    const [major, minor] = text.replace(/\.x$/i, '').split('.');
    return [{ type: 'wildcard', major, minor: minor || null }];
  }
  const parts = [];
  const tokenRe = /(>=|<=|>|<|=)?\s*(\d+(?:\.[0-9A-Za-z-]+)*)/g;
  let match;
  while ((match = tokenRe.exec(text))) {
    parts.push({ type: 'cmp', op: match[1] || '=', value: match[2] });
  }
  return parts.length ? parts : [{ type: 'cmp', op: '=', value: text }];
}

function satisfiesConstraint(raw, candidate, kind = 'loader') {
  const wanted = String(candidate || '').trim();
  if (!wanted) return false;
  const parts = parseConstraintList(raw);
  return parts.every((part) => {
    if (part.type === 'any') return true;
    if (part.type === 'wildcard') {
      const token = tokenizeVersion(kind === 'minecraft' ? canonicalMinecraftVersion(wanted) : wanted);
      if (!token) return false;
      if (String(token.parts[0]) !== String(part.major)) return false;
      if (part.minor == null) return true;
      return String(token.parts[1]) === String(part.minor);
    }
    if (part.type === 'maven') {
      if (part.lower) {
        const cmp = compareForKind(wanted, part.lower, kind);
        if (cmp == null) return false;
        if (part.lowerInclusive ? cmp < 0 : cmp <= 0) return false;
      }
      if (part.upper) {
        const cmp = compareForKind(wanted, part.upper, kind);
        if (cmp == null) return false;
        if (part.upperInclusive ? cmp > 0 : cmp >= 0) return false;
      }
      return true;
    }
    const cmp = compareForKind(wanted, part.value, kind);
    if (cmp == null) return minecraftVersionsEqual(wanted, part.value);
    if (part.op === '>') return cmp > 0;
    if (part.op === '>=') return cmp >= 0;
    if (part.op === '<') return cmp < 0;
    if (part.op === '<=') return cmp <= 0;
    return cmp === 0 || (kind === 'minecraft' && minecraftVersionsEqual(wanted, part.value));
  });
}

function isGeyserNativeJavaVersion(version, nativeVersions = []) {
  return (nativeVersions || []).some((native) => minecraftVersionsEqual(native, version));
}

function neoForgeMajor(loaderVersion) {
  const token = tokenizeVersion(loaderVersion);
  return token ? token.parts[0] : null;
}

function loaderLabel(loader) {
  const id = String(loader || '').toLowerCase();
  if (id === 'neoforge') return 'NeoForge';
  if (id === 'fabric') return 'Fabric';
  if (id === 'paper') return 'Paper';
  if (id === 'spigot') return 'Spigot';
  return id || 'unknown';
}

function paperLikeLoader(loader) {
  return ['paper', 'spigot', 'purpur', 'bukkit'].includes(String(loader || '').toLowerCase());
}

function modLoaderId(loader) {
  return String(loader || '').toLowerCase();
}

function isFabricApiModId(id) {
  return FABRIC_API_MOD_IDS.has(String(id || '').trim().toLowerCase());
}

function fabricApiDependIds(depends) {
  if (!depends || typeof depends !== 'object' || Array.isArray(depends)) return [];
  const ids = [];
  if (Object.prototype.hasOwnProperty.call(depends, FABRIC_API_MOD_ID)) ids.push(FABRIC_API_MOD_ID);
  if (Object.prototype.hasOwnProperty.call(depends, FABRIC_API_LEGACY_MOD_ID)) ids.push(FABRIC_API_LEGACY_MOD_ID);
  return ids;
}

function preferredFabricApiDependId(depends) {
  const ids = fabricApiDependIds(depends);
  if (ids.includes(FABRIC_API_MOD_ID)) return FABRIC_API_MOD_ID;
  return ids[0] || FABRIC_API_MOD_ID;
}

function isVersionAlias(value) {
  const raw = String(value || '').trim().toLowerCase();
  return !raw || raw === 'latest' || raw === 'latest-compatible';
}

function isUnstableRelease(value) {
  const raw = String(value || '').trim();
  if (!raw || isVersionAlias(raw)) return true;
  if (/^\d{2}w\d{2}[a-z]?$/i.test(raw)) return true;
  return /(?:^|[.+_-])(snapshot|alpha|beta|rc|experimental|preview|pre)(?:[.+_-]|$|\d)/i.test(raw);
}

function sortVersionsNewest(values, kind = 'loader') {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean))]
    .sort((a, b) => {
      const cmp = compareForKind(b, a, kind);
      if (cmp != null) return cmp;
      return String(b).localeCompare(String(a), undefined, { numeric: true });
    });
}

module.exports = {
  FABRIC_API_LEGACY_MOD_ID,
  FABRIC_API_MOD_ID,
  FABRIC_API_MOD_IDS,
  FABRIC_API_PROJECT_ID,
  FABRIC_LOADER_MOD_ID,
  FLOODGATE_MOD_ID,
  FLOODGATE_PROJECT_ID,
  canonicalMinecraftVersion,
  catalogListsExactMinecraft,
  compareVersions,
  fabricApiDependIds,
  isFabricApiModId,
  isGeyserNativeJavaVersion,
  isUnstableRelease,
  isVersionAlias,
  loaderLabel,
  minecraftVersionsEqual,
  modLoaderId,
  neoForgeMajor,
  paperLikeLoader,
  parseConstraintList,
  preferredFabricApiDependId,
  satisfiesConstraint,
  sortVersionsNewest,
  tokenizeVersion,
};
