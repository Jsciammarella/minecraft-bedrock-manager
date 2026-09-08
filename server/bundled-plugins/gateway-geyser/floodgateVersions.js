'use strict';

const {
  compareFabricVersions,
  evaluateFabricDependency,
  normalizeFabricMinecraftVersion,
  parseFabricVersion,
} = require('../../services/fabricVersionPredicate');
const {
  isMavenRange,
  parseMavenRange,
  satisfiesMavenRange,
} = require('../../services/mavenVersionRange');

const FABRIC_API_MOD_ID = 'fabric-api';
const FABRIC_API_LEGACY_MOD_ID = 'fabric';
const FABRIC_LOADER_MOD_ID = 'fabricloader';
const FLOODGATE_MOD_ID = 'floodgate';
const FABRIC_API_PROJECT_ID = 'P7dR8mSH';
const FLOODGATE_PROJECT_ID = 'bWrNNfkb';
const FABRIC_API_MOD_IDS = new Set([FABRIC_API_MOD_ID, FABRIC_API_LEGACY_MOD_ID]);

function canonicalMinecraftVersion(value) {
  return normalizeFabricMinecraftVersion(value);
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
  const parsed = parseFabricVersion(value);
  if (!parsed || !parsed.semantic) return null;
  return {
    parts: [
      parsed.components[0] || 0,
      parsed.components[1] || 0,
      parsed.components[2] || 0,
    ],
    pre: parsed.hasPrerelease
      ? (parsed.hasEmptyPrerelease ? '' : parsed.prerelease.join('.'))
      : '',
    raw: parsed.raw,
  };
}

function compareVersions(a, b) {
  return compareFabricVersions(a, b, { semanticOnly: true });
}

function compareForKind(a, b, kind) {
  if (kind === 'minecraft') {
    return compareVersions(canonicalMinecraftVersion(a), canonicalMinecraftVersion(b));
  }
  return compareVersions(a, b);
}

function omittedConstraint(raw) {
  if (raw == null) return true;
  if (Array.isArray(raw)) return false;
  const text = String(raw).trim();
  return !text || text === '*' || text.toLowerCase() === 'any';
}

function formatConstraint(raw) {
  if (raw == null) return '';
  if (Array.isArray(raw)) return raw.map((item) => String(item)).join(' | ');
  return String(raw);
}

function parseConstraintList(raw) {
  if (Array.isArray(raw)) {
    return [{ type: 'fabric-or', value: raw }];
  }
  if (omittedConstraint(raw)) {
    return [{ type: 'any' }];
  }
  const text = String(raw).trim();
  const maven = parseMavenRange(text);
  if (maven) return [maven];
  return [{ type: 'fabric', value: text }];
}

function evaluateConstraint(raw, candidate, kind = 'loader') {
  const wanted = String(candidate || '').trim();
  const constraint = formatConstraint(raw);
  const normalizedCandidate = kind === 'minecraft' ? canonicalMinecraftVersion(wanted) : wanted;
  const subject = kind === 'minecraft' ? 'Minecraft' : 'Version';
  if (!wanted) {
    return {
      compatible: false,
      candidate: wanted,
      constraint,
      normalizedCandidate,
      reason: `No ${subject.toLowerCase()} version was provided.`,
    };
  }
  if (omittedConstraint(raw)) {
    return {
      compatible: true,
      candidate: wanted,
      constraint: constraint || '*',
      normalizedCandidate,
      reason: '',
    };
  }
  if (!Array.isArray(raw) && isMavenRange(raw)) {
    const compatible = satisfiesMavenRange(raw, wanted, kind);
    return {
      compatible,
      candidate: wanted,
      constraint,
      normalizedCandidate,
      reason: compatible ? '' : `${subject} ${wanted} is outside the required range ${constraint}.`,
    };
  }
  return evaluateFabricDependency(wanted, raw, {
    normalizeMinecraft: kind === 'minecraft',
    subject,
  });
}

function satisfiesConstraint(raw, candidate, kind = 'loader') {
  return evaluateConstraint(raw, candidate, kind).compatible;
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
  evaluateConstraint,
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
