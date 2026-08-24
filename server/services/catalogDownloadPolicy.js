const path = require('path');
const pluginAudit = require('./pluginAudit');

const ALLOWED_ENVIRONMENTS = new Set(['client', 'server', 'both', 'unknown']);
const ALLOWED_DOWNLOAD_STATES = new Set(['allowed', 'blocked', 'requires-selection', 'unknown']);
const ALLOWED_BLOCK_REASONS = new Set([
  'client-only',
  'incompatible-loader',
  'incompatible-minecraft',
  'unavailable',
]);
const CLIENT_ONLY_CODE = 'CLIENT_ONLY_FILE';
const UNKNOWN_FILE_CODE = 'UNKNOWN_FILE_ID';
const CLIENT_ONLY_MESSAGE = 'Client-only files cannot be downloaded for a dedicated server.';
const CACHE_TTL_MS = 5 * 60 * 1000;

const availabilityCache = new Map();

function normalizeEnvironment(value) {
  const env = String(value || 'unknown').trim().toLowerCase();
  return ALLOWED_ENVIRONMENTS.has(env) ? env : 'unknown';
}

function normalizeDownloadState(value) {
  const state = String(value || 'unknown').trim().toLowerCase();
  return ALLOWED_DOWNLOAD_STATES.has(state) ? state : 'unknown';
}

function normalizeBlockReason(value) {
  const reason = String(value || '').trim().toLowerCase();
  return ALLOWED_BLOCK_REASONS.has(reason) ? reason : undefined;
}

function isJavaJar(file = {}) {
  const ext = String(file.extension || path.extname(file.fileName || file.name || '')).toLowerCase();
  return ext === '.jar';
}

function clientOnlyError(detail = {}) {
  return Object.assign(new Error(CLIENT_ONLY_MESSAGE), {
    status: 400,
    code: CLIENT_ONLY_CODE,
    providerId: detail.providerId || '',
    projectId: detail.projectId || '',
    fileId: detail.fileId || '',
  });
}

function unknownFileError(detail = {}) {
  return Object.assign(new Error('Unknown catalog file ID'), {
    status: 400,
    code: UNKNOWN_FILE_CODE,
    providerId: detail.providerId || '',
    projectId: detail.projectId || '',
    fileId: detail.fileId || '',
  });
}

function auditRejectedDownload(detail = {}, actor = 'system') {
  pluginAudit.record('catalog.download.rejected', {
    actor,
    targetType: 'catalog-source',
    targetId: detail.providerId || '',
    detail: {
      projectId: detail.projectId || '',
      fileId: detail.fileId || '',
      code: detail.code || CLIENT_ONLY_CODE,
    },
  });
}

function annotateFile(file = {}) {
  const environment = normalizeEnvironment(file.environment);
  const clientOnly = environment === 'client';
  const blockedReason = clientOnly ? 'client-only' : normalizeBlockReason(file.blockedReason);
  return {
    ...file,
    environment,
    downloadable: !clientOnly,
    blockedReason: clientOnly ? 'client-only' : blockedReason,
  };
}

function publicCachedFile(file = {}) {
  const annotated = annotateFile(file);
  return {
    id: annotated.id,
    fileId: annotated.fileId,
    name: annotated.name,
    fileName: annotated.fileName,
    displayName: annotated.displayName,
    type: annotated.type,
    extension: annotated.extension,
    date: annotated.date,
    size: annotated.size,
    releaseType: annotated.releaseType,
    loader: annotated.loader,
    minecraftVersions: annotated.minecraftVersions,
    environment: annotated.environment,
    environmentLabel: annotated.environmentLabel,
    environmentRaw: annotated.environmentRaw,
    downloadable: annotated.downloadable,
    blockedReason: annotated.blockedReason,
    warning: annotated.warning,
    fabric: annotated.fabric,
    neoforge: annotated.neoforge,
    sha1: annotated.sha1,
    sha512: annotated.sha512,
    edition: annotated.edition,
  };
}

function projectAvailability(files = [], { complete = true } = {}) {
  if (!complete) {
    return { downloadState: 'unknown' };
  }
  const jars = (files || []).filter(isJavaJar);
  if (!jars.length) {
    return {
      downloadState: 'unknown',
      availableFileCount: 0,
      selectableFileCount: 0,
    };
  }
  const annotated = jars.map(annotateFile);
  const selectable = annotated.filter((file) => file.downloadable);
  const allClient = annotated.every((file) => file.environment === 'client');
  if (allClient) {
    return {
      downloadState: 'blocked',
      blockedReason: 'client-only',
      availableFileCount: annotated.length,
      selectableFileCount: 0,
    };
  }
  if (selectable.length < annotated.length) {
    return {
      downloadState: 'requires-selection',
      availableFileCount: annotated.length,
      selectableFileCount: selectable.length,
    };
  }
  return {
    downloadState: 'allowed',
    availableFileCount: annotated.length,
    selectableFileCount: selectable.length,
  };
}

function assertNoClientOnlySelection(files, selectedIds, { providerId, projectId } = {}) {
  const wanted = (selectedIds || []).map(String).filter(Boolean);
  if (!wanted.length) return;
  const byId = new Map((files || []).map((file) => [String(file.id), annotateFile(file)]));
  for (const id of wanted) {
    const file = byId.get(id);
    if (!file) {
      throw unknownFileError({ providerId, projectId, fileId: id });
    }
    if (file.environment === 'client') {
      throw clientOnlyError({ providerId, projectId, fileId: id });
    }
  }
}

function assertPlanNotClientOnly(plan = {}, { providerId } = {}) {
  const files = Array.isArray(plan.files) ? plan.files : [];
  const javaPlan = plan.project?.edition === 'java' || files.some(isJavaJar);
  if (!javaPlan) return;
  const blocked = files.find((file) => normalizeEnvironment(file.environment) === 'client');
  if (blocked) {
    throw clientOnlyError({
      providerId: providerId || plan.project?.providerId,
      projectId: plan.project?.curseforgeId || plan.project?.slug,
      fileId: blocked.id || blocked.fileId,
    });
  }
}

function appliesJavaPolicy(entry, body = {}) {
  const providerId = entry?.id || body.provider || '';
  const edition = String(body.edition || '').toLowerCase();
  return providerId === 'curseforge-java' || providerId === 'modrinth-java' || edition === 'java';
}

function isClientOnlyAvailability(availability = {}) {
  return availability.downloadState === 'blocked' && availability.blockedReason === 'client-only';
}

function cacheKey(providerId, projectId, extra = {}) {
  const base = `${String(providerId || '')}:${String(projectId || '')}`;
  const loader = String(extra.loader || '').trim().toLowerCase();
  const versions = Array.isArray(extra.minecraftVersions)
    ? extra.minecraftVersions.join(',')
    : String(extra.minecraftVersions || extra.gameVersions || '');
  if (!loader && !versions) return base;
  return `${base}:${loader}:${versions}`;
}

function getCachedAvailability(providerId, projectId, extra = {}) {
  const key = cacheKey(providerId, projectId, extra);
  const cached = availabilityCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.at > CACHE_TTL_MS) {
    availabilityCache.delete(key);
    return null;
  }
  return cached;
}

function setCachedAvailability(providerId, projectId, value, { at = Date.now(), loader = '', minecraftVersions, gameVersions } = {}) {
  availabilityCache.set(cacheKey(providerId, projectId, { loader, minecraftVersions, gameVersions }), {
    at,
    files: (value.files || []).map(publicCachedFile),
    availability: value.availability,
  });
}

function applyCachedProjectAvailability(project = {}) {
  if (project.providerId !== 'curseforge-java' && project.providerId !== 'modrinth-java' && project.edition !== 'java') {
    return project;
  }
  const cached = getCachedAvailability(
    project.providerId || 'curseforge-java',
    project.curseforgeId || project.modrinthId || project.id
  );
  if (cached?.availability) {
    return {
      ...project,
      downloadState: normalizeDownloadState(cached.availability.downloadState),
      blockedReason: normalizeBlockReason(cached.availability.blockedReason),
      availableFileCount: cached.availability.availableFileCount,
      selectableFileCount: cached.availability.selectableFileCount,
    };
  }
  return {
    ...project,
    downloadState: 'unknown',
    blockedReason: undefined,
    availableFileCount: undefined,
    selectableFileCount: undefined,
  };
}

function clearCacheForProviders(providerIds = []) {
  const ids = new Set((providerIds || []).map(String));
  for (const key of [...availabilityCache.keys()]) {
    const providerId = key.split(':')[0];
    if (ids.has(providerId)) availabilityCache.delete(key);
  }
}

function clearAvailabilityCache() {
  availabilityCache.clear();
}

module.exports = {
  ALLOWED_BLOCK_REASONS,
  ALLOWED_DOWNLOAD_STATES,
  ALLOWED_ENVIRONMENTS,
  CACHE_TTL_MS,
  CLIENT_ONLY_CODE,
  CLIENT_ONLY_MESSAGE,
  UNKNOWN_FILE_CODE,
  annotateFile,
  appliesJavaPolicy,
  applyCachedProjectAvailability,
  assertNoClientOnlySelection,
  assertPlanNotClientOnly,
  auditRejectedDownload,
  clearAvailabilityCache,
  clearCacheForProviders,
  clientOnlyError,
  getCachedAvailability,
  isClientOnlyAvailability,
  isJavaJar,
  normalizeBlockReason,
  normalizeDownloadState,
  normalizeEnvironment,
  projectAvailability,
  publicCachedFile,
  setCachedAvailability,
  unknownFileError,
};
