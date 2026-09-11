'use strict';

const path = require('path');
const fs = require('fs');
const minecraftVersions = require('../../services/minecraftVersions');

const CALENDAR_MAJOR_MIN = 26;
const QUALIFIER_RE = /^(alpha|beta|rc|snapshot|pre|preview|experimental)(?:[.+_-].*)?$/i;

function splitCoreAndSuffix(raw) {
  let rest = String(raw || '').trim();
  if (!rest) return null;
  let build = null;
  const plus = rest.indexOf('+');
  if (plus >= 0) {
    build = rest.slice(plus + 1);
    rest = rest.slice(0, plus);
  }
  let qualifier = null;
  const dash = rest.indexOf('-');
  if (dash >= 0) {
    qualifier = rest.slice(dash + 1);
    rest = rest.slice(0, dash);
  }
  return { core: rest, qualifier, build };
}

function parseNeoForgeArtifact(version) {
  const raw = String(version || '').trim();
  if (!raw) return null;
  const split = splitCoreAndSuffix(raw);
  if (!split?.core) return null;
  const parts = split.core.split('.');
  if (parts.length < 2 || parts.length > 6) return null;
  const numeric = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    numeric.push(Number(part));
  }
  if (!Number.isInteger(numeric[0]) || numeric[0] < 1) return null;
  return {
    raw,
    numeric,
    qualifier: split.qualifier || null,
    build: split.build || null,
    channel: loaderChannelFromQualifier(split.qualifier, split.build),
  };
}

function loaderChannelFromQualifier(qualifier, build) {
  const text = `${qualifier || ''} ${build || ''}`.trim().toLowerCase();
  if (!text) return 'stable';
  if (/snapshot/.test(text)) return 'snapshot';
  if (/alpha/.test(text)) return 'alpha';
  if (/beta/.test(text)) return 'beta';
  if (/\brc\b|release-candidate/.test(text)) return 'rc';
  if (/\bpre/.test(text)) return 'pre';
  if (QUALIFIER_RE.test(String(qualifier || ''))) return String(qualifier).split(/[.+_-]/)[0].toLowerCase();
  return 'prerelease';
}

function dropTrailingZeroPatch(major, minor, patch) {
  if (patch && Number(patch) > 0) return `${major}.${minor}.${patch}`;
  return `${major}.${minor}`;
}

function minecraftFromParsed(parsed) {
  if (!parsed?.numeric || parsed.numeric.length < 2) return '';
  const [major, minor, patch] = parsed.numeric;
  if (major >= CALENDAR_MAJOR_MIN) {
    const mc = dropTrailingZeroPatch(major, minor, parsed.numeric.length >= 3 ? patch : 0);
    if (parsed.build && /^snapshot-?\d+/i.test(parsed.build)) {
      return `${major}.${minor}-${parsed.build}`;
    }
    return mc;
  }
  return `1.${major}.${minor}`;
}

function canonicalizeExplicitMinecraft(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (minecraftVersions.isFabricatedMinecraftVersion(raw)) {
    return minecraftVersions.canonicalMinecraftVersion(raw);
  }
  return minecraftVersions.canonicalMinecraftVersion(raw) || raw;
}

function minecraftFromNeoformVersion(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const head = raw.split('-')[0];
  if (!head) return '';
  if (minecraftVersions.isFabricatedMinecraftVersion(head)) return '';
  if (minecraftVersions.looksLikeMinecraftVersion(head) || /^(1\.\d+|\d+\.\d+)/.test(head)) {
    return canonicalizeExplicitMinecraft(head);
  }
  return '';
}

function minecraftFromNeoForgePom(xml) {
  const text = String(xml || '');
  const property = text.match(/<minecraftVersion>\s*([^<]+)\s*<\/minecraftVersion>/i)
    || text.match(/<minecraft_version>\s*([^<]+)\s*<\/minecraft_version>/i)
    || text.match(/<mcVersion>\s*([^<]+)\s*<\/mcVersion>/i);
  if (property) {
    const fromProp = canonicalizeExplicitMinecraft(property[1]);
    if (fromProp && !minecraftVersions.isFabricatedMinecraftVersion(fromProp)) return fromProp;
  }
  const neoform = text.match(/<artifactId>\s*neoform\s*<\/artifactId>\s*<version>\s*([^<]+)\s*<\/version>/i);
  if (neoform) {
    const fromNeoform = minecraftFromNeoformVersion(neoform[1]);
    if (fromNeoform) return fromNeoform;
  }
  return '';
}

function minecraftFromNeoForge(version, metadata = null) {
  const explicit = canonicalizeExplicitMinecraft(
    metadata?.minecraftVersion || metadata?.minecraft || metadata?.gameVersion
  );
  if (explicit && !minecraftVersions.isFabricatedMinecraftVersion(explicit)) {
    return explicit;
  }
  const raw = String(version || '').trim();
  if (raw && minecraftVersions.looksLikeMinecraftVersion(raw)
    && !minecraftVersions.looksLikeLoaderArtifactVersion(raw)) {
    return canonicalizeExplicitMinecraft(raw);
  }
  const parsed = parseNeoForgeArtifact(version);
  if (!parsed) return '';
  const mapped = minecraftFromParsed(parsed);
  if (!mapped || minecraftVersions.isFabricatedMinecraftVersion(mapped)) return '';
  return mapped;
}

function minecraftVersionsCompatible(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b || minecraftVersions.isVersionAlias(a) || minecraftVersions.isVersionAlias(b)) return true;
  return minecraftVersions.minecraftVersionsEqual(a, b);
}

function parseMavenMetadataVersions(xml) {
  return [...String(xml || '').matchAll(/<version>([^<]+)<\/version>/g)].map((item) => item[1].trim()).filter(Boolean);
}

function recommendedJavaMajor(minecraftVersion, loaderVersion) {
  const parsed = parseNeoForgeArtifact(loaderVersion);
  const mc = minecraftVersions.canonicalMinecraftVersion(minecraftVersion);
  if ((parsed && parsed.numeric[0] >= CALENDAR_MAJOR_MIN) || /^(2[6-9]|[3-9]\d)/.test(mc)) return 25;
  if ((parsed && parsed.numeric[0] >= 21) || /^1\.2[1-9]/.test(mc) || /^1\.20\.[5-9]/.test(mc)) return 21;
  return 17;
}

function pickLatestCompatible(versions) {
  const listed = (Array.isArray(versions) ? versions : []).map((item) => String(item || '').trim()).filter(Boolean);
  const parsed = listed
    .map((value) => ({ value, parsed: parseNeoForgeArtifact(value) }))
    .filter((item) => item.parsed);
  if (!parsed.length) return listed[0] || '';
  const stable = parsed.filter((item) => item.parsed.channel === 'stable');
  const pool = stable.length ? stable : parsed;
  const sorted = minecraftVersions.sortLoaderVersions(pool.map((item) => item.value), { descending: true });
  return sorted[0] || '';
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function inspectInstalledMinecraft(serverDir, server = {}) {
  const sources = [];
  let meta = {};
  try { meta = server.loader_metadata ? JSON.parse(server.loader_metadata) : {}; } catch { meta = {}; }
  const fromMeta = minecraftFromNeoForge('', meta);
  if (fromMeta) sources.push({ minecraftVersion: fromMeta, source: 'loader_metadata' });

  const loaderVersion = String(server.loader_version || meta.loaderVersion || '').trim();
  const candidates = [
    'version.json',
    path.join('installer', 'version.json'),
  ];
  if (loaderVersion) {
    candidates.push(path.join('libraries', 'net', 'neoforged', 'neoforge', loaderVersion, 'version.json'));
  }
  if (serverDir) {
    for (const relative of candidates) {
      const json = readJsonSafe(path.join(serverDir, relative));
      const raw = json?.inheritsFrom || json?.id || json?.minecraftVersion || json?.minecraft;
      const mapped = canonicalizeExplicitMinecraft(raw);
      if (mapped && !minecraftVersions.isFabricatedMinecraftVersion(mapped)) {
        sources.push({ minecraftVersion: mapped, source: relative });
        break;
      }
    }
  }

  const fromLoader = minecraftFromNeoForge(loaderVersion);
  if (fromLoader) sources.push({ minecraftVersion: fromLoader, source: 'loader_version' });

  return sources[0] || null;
}

module.exports = {
  CALENDAR_MAJOR_MIN,
  canonicalizeExplicitMinecraft,
  inspectInstalledMinecraft,
  loaderChannelFromQualifier,
  minecraftFromNeoForge,
  minecraftFromNeoForgePom,
  minecraftFromNeoformVersion,
  minecraftFromParsed,
  minecraftVersionsCompatible,
  parseMavenMetadataVersions,
  parseNeoForgeArtifact,
  pickLatestCompatible,
  recommendedJavaMajor,
};
