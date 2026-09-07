'use strict';

const {
  FABRIC_API_PROJECT_ID,
  FLOODGATE_PROJECT_ID,
  catalogListsExactMinecraft,
  loaderLabel,
  minecraftVersionsEqual,
} = require('./floodgateVersions');

const MODRINTH_API_HOST = 'api.modrinth.com';
const MODRINTH_CDN_HOST = 'cdn.modrinth.com';
const MAX_VERSIONS = 200;
const MAX_FILES = 20;
const MAX_DEPS = 40;
const MAX_FILE_BYTES = 80 * 1024 * 1024;
const VERSION_TYPES = new Set(['release', 'beta', 'alpha']);
const SERVER_ENVIRONMENTS = new Set([
  'server',
  'server_only',
  'dedicated_server_only',
  'server_only_client_optional',
  'both',
  'client_and_server',
  'client_or_server',
  'client_or_server_prefers_both',
  'client_only_server_optional',
  'unknown',
  '',
]);
const CLIENT_ONLY_ENVIRONMENTS = new Set([
  'client',
  'client_only',
  'singleplayer_only',
]);

function asString(value, max = 200) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function asStringArray(value, maxItems = 40, maxLen = 64) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .map((item) => asString(item, maxLen))
    .filter(Boolean);
}

function safeJarName(name, fallback = 'mod.jar') {
  const base = asString(name, 160).replace(/\\/g, '/').split('/').pop();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.jar$/i.test(base)) return base;
  return fallback;
}

function httpsUrl(raw, allowHosts) {
  try {
    const parsed = new URL(String(raw || ''));
    if (parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    const host = parsed.hostname.toLowerCase();
    const allowed = (allowHosts || []).map((item) => String(item).toLowerCase());
    if (!allowed.some((item) => host === item || host.endsWith(`.${item}`))) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function parseHashes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const hashes = {};
  for (const algo of ['sha512', 'sha256', 'sha1']) {
    const value = asString(raw[algo], 128).toLowerCase();
    if (algo === 'sha512' && /^[a-f0-9]{128}$/.test(value)) hashes.sha512 = value;
    if (algo === 'sha256' && /^[a-f0-9]{64}$/.test(value)) hashes.sha256 = value;
    if (algo === 'sha1' && /^[a-f0-9]{40}$/.test(value)) hashes.sha1 = value;
  }
  return hashes;
}

function parseDependencies(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_DEPS).map((item) => {
    if (!item || typeof item !== 'object') return null;
    return {
      projectId: asString(item.project_id, 64),
      versionId: asString(item.version_id, 64),
      dependencyType: asString(item.dependency_type, 32).toLowerCase(),
    };
  }).filter((item) => item && item.projectId);
}

function isClientOnlyVersion(version) {
  const env = asString(version.environment, 64).toLowerCase();
  if (CLIENT_ONLY_ENVIRONMENTS.has(env)) return true;
  if (env && !SERVER_ENVIRONMENTS.has(env)) return true;
  const name = `${asString(version.name, 120)} ${asString(version.version_number, 80)}`.toLowerCase();
  if (/(^|[^a-z])client([^a-z]|$)/.test(name) && !/server/.test(name)) return true;
  return false;
}

function parseFile(file, allowHosts) {
  if (!file || typeof file !== 'object') return null;
  const filename = safeJarName(file.filename || file.name);
  if (!filename) return null;
  const url = httpsUrl(file.url, allowHosts);
  if (!url) return null;
  const size = Number(file.size);
  if (Number.isFinite(size) && (size <= 0 || size > MAX_FILE_BYTES)) return null;
  const hashes = parseHashes(file.hashes);
  if (!hashes.sha512 && !hashes.sha256 && !hashes.sha1) return null;
  return {
    filename,
    url,
    primary: Boolean(file.primary),
    size: Number.isFinite(size) ? size : 0,
    hashes,
  };
}

function parseVersion(raw, allowHosts) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = asString(raw.id, 64);
  const versionNumber = asString(raw.version_number, 80);
  const versionType = asString(raw.version_type, 16).toLowerCase();
  if (!id || !versionNumber || !VERSION_TYPES.has(versionType)) return null;
  const files = (Array.isArray(raw.files) ? raw.files.slice(0, MAX_FILES) : [])
    .map((file) => parseFile(file, allowHosts))
    .filter(Boolean);
  if (!files.length) return null;
  return {
    id,
    versionNumber,
    versionType,
    name: asString(raw.name, 160),
    datePublished: asString(raw.date_published, 40),
    gameVersions: asStringArray(raw.game_versions),
    loaders: asStringArray(raw.loaders).map((item) => item.toLowerCase()),
    environment: asString(raw.environment, 64).toLowerCase(),
    files,
    dependencies: parseDependencies(raw.dependencies),
  };
}

function parseVersionList(data, allowHosts) {
  if (!Array.isArray(data)) {
    throw Object.assign(new Error('Modrinth catalog response is invalid'), {
      status: 502,
      code: 'FLOODGATE_CATALOG_INVALID',
    });
  }
  return data.slice(0, MAX_VERSIONS)
    .map((item) => parseVersion(item, allowHosts))
    .filter(Boolean);
}

function primaryFile(version) {
  return (version.files || []).find((file) => file.primary) || version.files[0] || null;
}

function compatibleWithTarget(version, { minecraftVersion, loader }) {
  if (!version) return false;
  if (!catalogListsExactMinecraft(version.gameVersions, minecraftVersion)) return false;
  if (!version.loaders.includes(String(loader || '').toLowerCase())) return false;
  if (isClientOnlyVersion(version)) return false;
  return Boolean(primaryFile(version));
}

function typeRank(versionType) {
  if (versionType === 'release') return 0;
  if (versionType === 'beta') return 1;
  return 2;
}

function comparePublished(a, b) {
  const left = Date.parse(a.datePublished || '') || 0;
  const right = Date.parse(b.datePublished || '') || 0;
  if (left !== right) return right - left;
  return String(a.id).localeCompare(String(b.id), 'en');
}

function selectCompatibleVersion(versions, target) {
  const compatible = (versions || []).filter((item) => compatibleWithTarget(item, target));
  if (!compatible.length) return null;
  const releases = compatible.filter((item) => item.versionType === 'release');
  const pool = releases.length ? releases : compatible.filter((item) => item.versionType === 'beta');
  if (!pool.length) return null;
  return [...pool].sort((a, b) => {
    const type = typeRank(a.versionType) - typeRank(b.versionType);
    if (type) return type;
    return comparePublished(a, b);
  })[0];
}

function queryVersions(minecraftVersion) {
  const raw = String(minecraftVersion || '').trim();
  const items = [raw];
  if (raw.startsWith('1.') && !items.includes(raw.slice(2))) items.push(raw.slice(2));
  if (!raw.startsWith('1.') && /^\d{2,}(\.|$)/.test(raw)) items.push(`1.${raw}`);
  return [...new Set(items.filter(Boolean))];
}

function catalogUrl(projectId, { minecraftVersion, loader }) {
  const url = new URL(`https://${MODRINTH_API_HOST}/v2/project/${encodeURIComponent(projectId)}/version`);
  url.searchParams.set('game_versions', JSON.stringify(queryVersions(minecraftVersion)));
  url.searchParams.set('loaders', JSON.stringify([String(loader || '').toLowerCase()]));
  return url.toString();
}

function unsupportedTargetError(target) {
  const loader = String(target.loader || '').toLowerCase();
  const minecraftVersion = String(target.minecraftVersion || '').trim();
  const loaderVersion = String(target.loaderVersion || '').trim();
  const label = loaderLabel(loader);
  return Object.assign(
    new Error(`Floodgate is not available for ${label} ${minecraftVersion}. Choose a supported Minecraft/${label} version, use Fabric with a compatible Floodgate build, or select another authentication method.`),
    {
      status: 400,
      code: 'FLOODGATE_UNSUPPORTED_TARGET',
      loader,
      minecraftVersion,
      loaderVersion,
    }
  );
}

function toArtifact(version, {
  projectId,
  role,
  destination,
  minecraftVersion,
  loader,
  loaderVersion,
}) {
  const file = primaryFile(version);
  const fallback = role === 'fabric-api' ? 'fabric-api.jar' : 'Floodgate.jar';
  const dir = String(destination || 'mods/Floodgate.jar').replace(/\\/g, '/').replace(/\/[^/]+$/, '') || 'mods';
  return {
    projectId,
    versionId: version.id,
    versionNumber: version.versionNumber,
    versionType: version.versionType,
    filename: file.filename,
    destination: `${dir}/${safeJarName(file.filename, fallback)}`,
    url: file.url,
    hashes: file.hashes,
    size: file.size,
    gameVersions: version.gameVersions,
    loaders: version.loaders,
    dependencies: version.dependencies,
    role: role || 'floodgate',
    minecraftVersion,
    loader,
    loaderVersion: loaderVersion || '',
    license: 'MIT',
    maximumBytes: Math.min(file.size || MAX_FILE_BYTES, MAX_FILE_BYTES),
  };
}

async function resolveProjectVersion({
  projectId,
  minecraftVersion,
  loader,
  loaderVersion,
  requestJson,
  allowHosts,
  role,
  destination,
}) {
  const hosts = allowHosts || [MODRINTH_API_HOST, MODRINTH_CDN_HOST];
  const url = catalogUrl(projectId, { minecraftVersion, loader });
  const data = await requestJson(url, { allowHosts: hosts });
  const versions = parseVersionList(data, hosts);
  const selected = selectCompatibleVersion(versions, { minecraftVersion, loader });
  if (!selected) return null;
  return toArtifact(selected, {
    projectId,
    role,
    destination,
    minecraftVersion,
    loader,
    loaderVersion,
  });
}

async function resolveFloodgateArtifact(target, deps = {}) {
  const artifact = await resolveProjectVersion({
    ...deps,
    projectId: FLOODGATE_PROJECT_ID,
    minecraftVersion: target.minecraftVersion,
    loader: target.loader,
    loaderVersion: target.loaderVersion,
    role: 'floodgate',
    destination: 'mods/Floodgate.jar',
  });
  if (!artifact) throw unsupportedTargetError(target);
  return artifact;
}

function floodgateRequiresFabricApi(artifact) {
  return (artifact.dependencies || []).some((item) => (
    item.dependencyType === 'required' && item.projectId === FABRIC_API_PROJECT_ID
  ));
}

async function resolveFabricApiArtifact(target, deps = {}) {
  const artifact = await resolveProjectVersion({
    ...deps,
    projectId: FABRIC_API_PROJECT_ID,
    minecraftVersion: target.minecraftVersion,
    loader: 'fabric',
    loaderVersion: target.loaderVersion,
    role: 'fabric-api',
    destination: 'mods/fabric-api.jar',
  });
  if (!artifact) {
    throw Object.assign(
      new Error(`A compatible Fabric API build was not found for Minecraft ${target.minecraftVersion}. Floodgate on Fabric requires Fabric API; Fabric Loader is not a substitute.`),
      {
        status: 400,
        code: 'FABRIC_API_UNSUPPORTED_TARGET',
        loader: 'fabric',
        minecraftVersion: target.minecraftVersion,
        loaderVersion: target.loaderVersion || '',
      }
    );
  }
  return artifact;
}

module.exports = {
  MAX_FILE_BYTES,
  MODRINTH_API_HOST,
  MODRINTH_CDN_HOST,
  catalogUrl,
  compatibleWithTarget,
  floodgateRequiresFabricApi,
  minecraftVersionsEqual,
  parseVersionList,
  primaryFile,
  resolveFabricApiArtifact,
  resolveFloodgateArtifact,
  resolveProjectVersion,
  safeJarName,
  selectCompatibleVersion,
  unsupportedTargetError,
};
