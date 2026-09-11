'use strict';

const {
  compareFabricVersions,
  normalizeFabricMinecraftVersion,
  parseFabricVersion,
} = require('./fabricVersionPredicate');

const VERSION_ALIASES = new Set(['latest', 'latest-compatible', 'vanilla']);
const FABRICATED_CALENDAR_PREFIX = /^1\.(2[6-9]|[3-9]\d|\d{3,})(\..*)?$/;
const SNAPSHOT_ID = /^\d{2}w\d{2}[a-z]?$/i;
const CALENDAR_RELEASE = /^(2[6-9]|[3-9]\d|\d{3,})\.\d+(?:\.\d+)?$/;
const LEGACY_RELEASE = /^1\.\d+(?:\.\d+)?$/;
const PRE_RELEASE = /(?:^|[.+_-])(snapshot|alpha|beta|rc|pre|preview|experimental)(?:[.+_-]|$|\d)/i;

function parseVersionList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parseVersionList(parsed);
    } catch {
      /* comma-separated */
    }
    return raw.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function versionTokens(value) {
  return String(value || '').split('.').filter(Boolean);
}

function canonicalMinecraftVersion(value) {
  return normalizeFabricMinecraftVersion(value);
}

function isVersionAlias(value) {
  const raw = String(value || '').trim().toLowerCase();
  return !raw || VERSION_ALIASES.has(raw);
}

function isFabricatedMinecraftVersion(value) {
  const raw = String(value || '').trim();
  return FABRICATED_CALENDAR_PREFIX.test(raw);
}

function looksLikeMinecraftVersion(value) {
  const raw = String(value || '').trim();
  if (!raw || isVersionAlias(raw)) return false;
  if (isFabricatedMinecraftVersion(raw)) return false;
  if (SNAPSHOT_ID.test(raw)) return true;
  const canonical = canonicalMinecraftVersion(raw);
  const parsed = parseMinecraftVersion(canonical);
  if (!parsed?.semantic) {
    return LEGACY_RELEASE.test(canonical) || CALENDAR_RELEASE.test(canonical);
  }
  if (parsed.components.length < 2 || parsed.components.length > 3) return false;
  if (parsed.components[0] === 1) return true;
  return parsed.components[0] >= 26;
}

function looksLikeLoaderArtifactVersion(value) {
  const raw = String(value || '').trim();
  if (!raw || isVersionAlias(raw)) return false;
  const parsed = parseMinecraftVersion(raw);
  if (!parsed?.semantic) return /-\w+/.test(raw) && /^\d+\.\d+\.\d+/.test(raw);
  if (parsed.components[0] >= 26 && parsed.components.length >= 4) return true;
  if (parsed.components[0] !== 1 && parsed.components[0] < 26 && parsed.components.length >= 3) return true;
  return false;
}

function parseMinecraftVersion(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return parseFabricVersion(canonicalMinecraftVersion(raw), { allowWildcard: false });
  } catch {
    return null;
  }
}

function compareMinecraftVersions(left, right) {
  const a = canonicalMinecraftVersion(left);
  const b = canonicalMinecraftVersion(right);
  if (!a || !b) return null;
  return compareFabricVersions(a, b, { semanticOnly: true });
}

function minecraftVersionsEqual(left, right) {
  const a = canonicalMinecraftVersion(left);
  const b = canonicalMinecraftVersion(right);
  if (a && b && a === b) return true;
  const cmp = compareMinecraftVersions(left, right);
  return cmp === 0;
}

function listedSupportsServer(listed, serverVersion) {
  const aRaw = String(listed || '').trim();
  const bRaw = String(serverVersion || '').trim();
  if (!aRaw || aRaw.toLowerCase() === 'any' || aRaw === '*') return true;
  if (aRaw === bRaw) return true;
  const a = canonicalMinecraftVersion(aRaw);
  const b = canonicalMinecraftVersion(bRaw);
  if (a && b && a === b) return true;
  if (minecraftVersionsEqual(aRaw, bRaw)) return true;
  const ta = versionTokens(a);
  const tb = versionTokens(b);
  if (ta.length === 2 && tb.length >= 2 && ta[0] === tb[0] && ta[1] === tb[1]) return true;
  return false;
}

function supportsMinecraftVersion(versions, serverVersion) {
  const wanted = String(serverVersion || '').trim();
  if (!wanted) return true;
  const list = parseVersionList(versions);
  if (!list.length) return true;
  return list.some((item) => listedSupportsServer(item, wanted));
}

function sortMinecraftVersions(values, { descending = false } = {}) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean))]
    .sort((left, right) => {
      const cmp = compareMinecraftVersions(left, right);
      if (cmp != null) return descending ? -cmp : cmp;
      return String(left).localeCompare(String(right), undefined, { numeric: true });
    });
}

function compareLoaderVersions(left, right) {
  return compareFabricVersions(String(left || '').trim(), String(right || '').trim(), { semanticOnly: true });
}

function sortLoaderVersions(values, { descending = true } = {}) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean))]
    .sort((left, right) => {
      const cmp = compareLoaderVersions(left, right);
      if (cmp != null) return descending ? -cmp : cmp;
      return String(right).localeCompare(String(left), undefined, { numeric: true });
    });
}

function isPrereleaseVersion(value) {
  const raw = String(value || '').trim();
  if (!raw || isVersionAlias(raw)) return false;
  if (SNAPSHOT_ID.test(raw)) return true;
  return PRE_RELEASE.test(raw);
}

function serverMinecraftVersion(server) {
  return String(server?.minecraft_version || server?.minecraftVersion || server?.version || '').trim();
}

function modMinecraftVersions(mod) {
  return parseVersionList(mod?.minecraftVersions ?? mod?.minecraft_versions);
}

function parseRequestedGameVersions(raw) {
  const items = [];
  const list = Array.isArray(raw)
    ? raw
    : String(raw || '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const item of list) {
    if (item && typeof item === 'object' && item.version) {
      const edition = item.edition === 'java' || item.edition === 'bedrock' ? item.edition : '';
      items.push({ version: String(item.version).trim(), edition });
      continue;
    }
    const text = String(item || '');
    const [version, edition] = text.split(':');
    if (!version) continue;
    items.push({
      version: version.trim(),
      edition: edition === 'java' || edition === 'bedrock' ? edition : '',
    });
  }
  return items.filter((item) => item.version);
}

function providerGameVersions(editions, requested) {
  const list = Array.isArray(requested) ? requested : parseRequestedGameVersions(requested);
  if (!list.length) return [];
  const allowed = Array.isArray(editions) ? editions : [];
  return [...new Set(list
    .filter((item) => !item.edition || allowed.includes(item.edition))
    .map((item) => item.version)
    .filter(Boolean))];
}

function matchesCatalogGameVersions(mod, minecraftVersions, requested = []) {
  const listed = modMinecraftVersions(mod);
  const edition = String(mod?.edition || '').toLowerCase();
  const selected = Array.isArray(requested) && requested.length
    ? requested
    : (Array.isArray(minecraftVersions) ? minecraftVersions.filter(Boolean).map((version) => ({ version })) : []);
  if (!selected.length) return true;
  const wanted = selected
    .filter((item) => {
      const version = typeof item === 'string' ? item : item?.version;
      const itemEdition = typeof item === 'string' ? '' : item?.edition;
      return version && (!itemEdition || !edition || itemEdition === edition);
    })
    .map((item) => (typeof item === 'string' ? item : item.version));
  if (!wanted.length) return false;
  if (!listed.length) return true;
  return wanted.some((version) => supportsMinecraftVersion(listed, version));
}

function compatibilityError(message, extra = {}) {
  const err = new Error(message);
  err.status = extra.status || 400;
  err.code = extra.code || 'MINECRAFT_LOADER_INCOMPATIBLE';
  if (extra.minecraftVersion != null) err.minecraftVersion = extra.minecraftVersion;
  if (extra.loaderVersion != null) err.loaderVersion = extra.loaderVersion;
  if (extra.loader != null) err.loader = extra.loader;
  return err;
}

function rejectSwappedVersions({ minecraftVersion, loaderVersion, loader } = {}) {
  const mc = String(minecraftVersion || '').trim();
  const lv = String(loaderVersion || '').trim();
  if (!mc || !lv || isVersionAlias(mc) || isVersionAlias(lv)) return;
  if (looksLikeLoaderArtifactVersion(mc) && looksLikeMinecraftVersion(lv) && !looksLikeMinecraftVersion(mc)) {
    throw compatibilityError(
      `Minecraft version ${mc} looks like a ${loader || 'loader'} artifact. Use minecraftVersion for the game version and loaderVersion for the loader build.`,
      { minecraftVersion: mc, loaderVersion: lv, loader, code: 'VERSION_FIELDS_SWAPPED' }
    );
  }
}

module.exports = {
  canonicalMinecraftVersion,
  compareLoaderVersions,
  compareMinecraftVersions,
  compatibilityError,
  isFabricatedMinecraftVersion,
  isPrereleaseVersion,
  isVersionAlias,
  listedSupportsServer,
  looksLikeLoaderArtifactVersion,
  looksLikeMinecraftVersion,
  matchesCatalogGameVersions,
  minecraftVersionsEqual,
  modMinecraftVersions,
  parseMinecraftVersion,
  parseRequestedGameVersions,
  parseVersionList,
  providerGameVersions,
  rejectSwappedVersions,
  serverMinecraftVersion,
  sortLoaderVersions,
  sortMinecraftVersions,
  supportsMinecraftVersion,
};
