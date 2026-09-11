'use strict';

const path = require('path');
const minecraftVersions = require('../../services/minecraftVersions');
const loaderVersionCache = require('../../services/loaderVersionCache');
const mapping = require('./versionMapping');

const MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const CACHE_CHANNEL = 'all';
const CACHE_LOADER = 'neoforge';

function pomUrl(loaderVersion) {
  return `${MAVEN}/${encodeURIComponent(loaderVersion)}/neoforge-${encodeURIComponent(loaderVersion)}.pom`;
}

function installerFileName(loaderVersion) {
  return `neoforge-${loaderVersion}-installer.jar`;
}

function installerUrl(loaderVersion) {
  return `${MAVEN}/${encodeURIComponent(loaderVersion)}/${installerFileName(loaderVersion)}`;
}

function argFileRelative(loaderVersion, platform = process.platform) {
  const argsName = platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  return ['libraries', 'net', 'neoforged', 'neoforge', String(loaderVersion), argsName].join('/');
}

function mapEntry(loaderVersion, metadata = null) {
  const parsed = mapping.parseNeoForgeArtifact(loaderVersion);
  const minecraftVersion = mapping.minecraftFromNeoForge(loaderVersion, metadata);
  if (!parsed || !minecraftVersion) return null;
  return {
    loaderVersion: parsed.raw,
    minecraftVersion,
    loader: 'neoforge',
    loaderChannel: parsed.channel,
  };
}

function dedupeMinecraftVersions(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const key = minecraftVersions.canonicalMinecraftVersion(entry.minecraftVersion);
    if (!key || seen.has(key) || minecraftVersions.isFabricatedMinecraftVersion(key)) continue;
    seen.add(key);
    out.push(entry.minecraftVersion);
  }
  return minecraftVersions.sortMinecraftVersions(out, { descending: true });
}

function buildCatalog(loaderVersions, metadataByVersion = {}) {
  const versions = [];
  for (const loaderVersion of loaderVersions) {
    const entry = mapEntry(loaderVersion, metadataByVersion[loaderVersion]);
    if (entry) versions.push(entry);
  }
  return {
    format: loaderVersionCache.FORMAT,
    loader: CACHE_LOADER,
    channel: CACHE_CHANNEL,
    versions,
    minecraftVersions: dedupeMinecraftVersions(versions),
  };
}

async function fetchInstallerVersions(http) {
  const xml = await http.getText(`${MAVEN}/maven-metadata.xml`);
  return mapping.parseMavenMetadataVersions(xml);
}

async function loadKnownMinecraftVersions(services) {
  if (typeof services?.knownMinecraftVersions === 'function') {
    try {
      const listed = await services.knownMinecraftVersions();
      if (Array.isArray(listed) && listed.length) return listed;
      return null;
    } catch {
      return null;
    }
  }
  try {
    const javaEdition = require('../../services/javaEdition');
    const listed = await javaEdition.listAllReleaseIds();
    if (Array.isArray(listed) && listed.length) return listed;
  } catch {
    /* Mojang list is advisory; NeoForge results still stand if it is unavailable. */
  }
  return null;
}

function intersectMinecraftVersions(fromLoader, known) {
  if (!Array.isArray(fromLoader) || !fromLoader.length) return [];
  if (!Array.isArray(known) || !known.length) return fromLoader;
  const allowed = new Set(known.map((item) => minecraftVersions.canonicalMinecraftVersion(item)).filter(Boolean));
  return fromLoader.filter((item) => allowed.has(minecraftVersions.canonicalMinecraftVersion(item)));
}

function cacheDir(services) {
  return services?.dataDir || '';
}

async function loadCatalog(http, services = {}, { refresh = false } = {}) {
  const dir = cacheDir(services);
  if (!refresh) {
    const cached = loaderVersionCache.readCatalog(dir, {
      loader: CACHE_LOADER,
      channel: CACHE_CHANNEL,
    });
    if (cached) return cached;
  }
  const installerVersions = await fetchInstallerVersions(http);
  const catalog = buildCatalog(installerVersions);
  loaderVersionCache.writeCatalog(dir, catalog, {
    loader: CACHE_LOADER,
    channel: CACHE_CHANNEL,
  });
  return catalog;
}

async function attachPomMetadata(http, loaderVersion, entry) {
  if (!http?.getText || !loaderVersion) return entry;
  try {
    const xml = await http.getText(pomUrl(loaderVersion));
    const fromPom = mapping.minecraftFromNeoForgePom(xml);
    if (!fromPom) return entry;
    return {
      ...entry,
      minecraftVersion: fromPom,
      metadataSource: 'pom',
    };
  } catch {
    return entry;
  }
}

async function listMinecraftVersions(http, services = {}) {
  const catalog = await loadCatalog(http, services);
  const known = await loadKnownMinecraftVersions(services);
  return intersectMinecraftVersions(catalog.minecraftVersions, known);
}

async function listLoaderVersions(http, services, minecraftVersion) {
  const catalog = await loadCatalog(http, services);
  const wanted = String(minecraftVersion || '').trim();
  let entries = catalog.versions;
  if (wanted && !minecraftVersions.isVersionAlias(wanted)) {
    entries = entries.filter((item) => mapping.minecraftVersionsCompatible(item.minecraftVersion, wanted));
  }
  return minecraftVersions.sortLoaderVersions(entries.map((item) => item.loaderVersion), { descending: true });
}

async function resolveMappedInstallation(http, services, request = {}) {
  minecraftVersions.rejectSwappedVersions({
    minecraftVersion: request.minecraftVersion || request.version,
    loaderVersion: request.loaderVersion,
    loader: 'neoforge',
  });
  const requestedMc = String(request.minecraftVersion || request.version || 'latest').trim() || 'latest';
  const loaders = await listLoaderVersions(http, services, requestedMc === 'latest' ? '' : requestedMc);
  if (!loaders.length) {
    throw minecraftVersions.compatibilityError(
      `NeoForge is not available for Minecraft ${requestedMc}`,
      { minecraftVersion: requestedMc, loader: 'neoforge', code: 'NEOFORGE_MINECRAFT_UNSUPPORTED' }
    );
  }
  let loaderVersion = request.loaderVersion || 'latest-compatible';
  if (!loaderVersion || minecraftVersions.isVersionAlias(loaderVersion)) {
    loaderVersion = mapping.pickLatestCompatible(loaders);
  }
  if (!loaders.includes(loaderVersion)) {
    throw minecraftVersions.compatibilityError(
      `NeoForge ${loaderVersion} is not compatible with Minecraft ${requestedMc}`,
      {
        minecraftVersion: requestedMc,
        loaderVersion,
        loader: 'neoforge',
        code: 'NEOFORGE_LOADER_INCOMPATIBLE',
      }
    );
  }
  let entry = mapEntry(loaderVersion);
  if (!entry) {
    throw minecraftVersions.compatibilityError(
      `NeoForge ${loaderVersion} could not be mapped to a Minecraft version`,
      { loaderVersion, loader: 'neoforge', minecraftVersion: requestedMc, code: 'NEOFORGE_VERSION_UNMAPPED' }
    );
  }
  entry = await attachPomMetadata(http, loaderVersion, entry);
  if (requestedMc && !minecraftVersions.isVersionAlias(requestedMc)
    && !mapping.minecraftVersionsCompatible(entry.minecraftVersion, requestedMc)) {
    throw minecraftVersions.compatibilityError(
      `NeoForge ${loaderVersion} is not compatible with Minecraft ${requestedMc}`,
      {
        minecraftVersion: requestedMc,
        loaderVersion,
        loader: 'neoforge',
        code: 'NEOFORGE_LOADER_INCOMPATIBLE',
      }
    );
  }
  return {
    loader: 'neoforge',
    minecraftVersion: entry.minecraftVersion,
    loaderVersion,
    loaderChannel: entry.loaderChannel,
    javaMajor: mapping.recommendedJavaMajor(entry.minecraftVersion, loaderVersion),
  };
}

module.exports = {
  CACHE_CHANNEL,
  CACHE_LOADER,
  MAVEN,
  argFileRelative,
  attachPomMetadata,
  buildCatalog,
  installerFileName,
  installerUrl,
  listLoaderVersions,
  listMinecraftVersions,
  loadCatalog,
  mapEntry,
  pomUrl,
  resolveMappedInstallation,
};
