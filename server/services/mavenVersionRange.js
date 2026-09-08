'use strict';

const { compareFabricVersions, normalizeFabricMinecraftVersion } = require('./fabricVersionPredicate');

function parseMavenRange(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/^([\[(])\s*([^,\[\]]*)\s*,\s*([^,\[\]]*)\s*([\])])$/);
  if (!match) return null;
  return {
    type: 'maven',
    raw,
    lower: match[2].trim(),
    lowerInclusive: match[1] === '[',
    upper: match[3].trim(),
    upperInclusive: match[4] === ']',
  };
}

function isMavenRange(value) {
  if (value == null || Array.isArray(value)) return false;
  return Boolean(parseMavenRange(value));
}

function compareForKind(left, right, kind) {
  const a = kind === 'minecraft' ? normalizeFabricMinecraftVersion(left) : String(left || '').trim();
  const b = kind === 'minecraft' ? normalizeFabricMinecraftVersion(right) : String(right || '').trim();
  return compareFabricVersions(a, b, { semanticOnly: true });
}

function satisfiesMavenRange(raw, candidate, kind = 'loader') {
  const range = typeof raw === 'object' && raw && raw.type === 'maven' ? raw : parseMavenRange(raw);
  if (!range) return false;
  const wanted = String(candidate || '').trim();
  if (!wanted) return false;
  if (range.lower) {
    const cmp = compareForKind(wanted, range.lower, kind);
    if (cmp == null) return false;
    if (range.lowerInclusive ? cmp < 0 : cmp <= 0) return false;
  }
  if (range.upper) {
    const cmp = compareForKind(wanted, range.upper, kind);
    if (cmp == null) return false;
    if (range.upperInclusive ? cmp > 0 : cmp >= 0) return false;
  }
  return true;
}

module.exports = {
  compareForKind,
  isMavenRange,
  parseMavenRange,
  satisfiesMavenRange,
};
