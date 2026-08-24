const gitCatalog = require('./gitCatalogClient');
const fileCatalog = require('./fileCatalogClient');
const settingsStore = require('./settingsStore');
const catalogProviderRegistry = require('./catalogProviderRegistry');
const coreCatalogProviders = require('./coreCatalogProviders');
const catalogLibrary = require('./catalogLibrary');
const pluginAudit = require('./pluginAudit');
const { ALLOWED_CATALOG_EDITIONS } = require('./catalogEditions');
const catalogDownloadPolicy = require('./catalogDownloadPolicy');
const catalogModMeta = require('./catalogModMeta');
const minecraftVersions = require('./minecraftVersions');

const CATALOG_PAGE_SIZE = 40;
const LOCAL_FETCH_SIZE = 10000;
const LOCAL_PROVIDER_IDS = new Set(['git', 'file']);
const LEGACY_CURSEFORGE_SOURCE = 'curseforge';
const BEDROCK_CURSEFORGE_ID = 'curseforge-bedrock';
const JAVA_CURSEFORGE_ID = 'curseforge-java';
const JAVA_MODRINTH_ID = 'modrinth-java';

function clampPageSize(value) {
  const size = parseInt(value, 10);
  if (!Number.isFinite(size) || size < 1) return CATALOG_PAGE_SIZE;
  return Math.min(size, CATALOG_PAGE_SIZE);
}

function ensureProviders() {
  coreCatalogProviders.registerAll();
}

function normalizeEdition(value) {
  const edition = String(value || 'all').toLowerCase();
  if (edition === 'all') return 'all';
  if (ALLOWED_CATALOG_EDITIONS.includes(edition)) return edition;
  return 'all';
}

function sourceStatus() {
  ensureProviders();
  const settings = settingsStore.publicCatalogSettings();
  const java = catalogProviderRegistry.get(JAVA_CURSEFORGE_ID);
  const modrinth = catalogProviderRegistry.get(JAVA_MODRINTH_ID);
  return {
    curseforge: settings.curseforge.configured,
    git: Boolean(settings.git.enabled && settings.git.url),
    file: fileCatalog.isConfigured(),
    [JAVA_CURSEFORGE_ID]: Boolean(java),
    [JAVA_MODRINTH_ID]: Boolean(modrinth),
  };
}

function publicSources() {
  ensureProviders();
  const available = sourceStatus();
  const providers = catalogProviderRegistry.list();
  const sources = {};
  for (const provider of providers) {
    const key = provider.id === BEDROCK_CURSEFORGE_ID ? LEGACY_CURSEFORGE_SOURCE : provider.id;
    let isAvailable = true;
    if (provider.id === BEDROCK_CURSEFORGE_ID) isAvailable = Boolean(available.curseforge);
    else if (provider.id === JAVA_CURSEFORGE_ID) isAvailable = Boolean(available[JAVA_CURSEFORGE_ID]);
    else if (provider.id === JAVA_MODRINTH_ID) isAvailable = Boolean(available[JAVA_MODRINTH_ID]);
    else if (provider.id === 'git') isAvailable = Boolean(available.git);
    else if (provider.id === 'file') isAvailable = Boolean(available.file);
    sources[key] = {
      available: isAvailable,
      label: provider.name,
      providerId: provider.id,
      editions: provider.editions,
      source: provider.source,
    };
  }
  return { sources, providers };
}

function configureError(source) {
  if (source === 'git') {
    return 'Git catalog is not configured. Add a repository in Catalog Settings.';
  }
  if (source === 'file') {
    return 'File catalog is not configured. Enable a local folder, SMB share, or NFS path in Catalog Settings.';
  }
  if (source === JAVA_CURSEFORGE_ID) {
    return 'CurseForge Java requires the existing CurseForge API key. Open Catalog Settings to add it.';
  }
  if (source === JAVA_MODRINTH_ID) {
    return 'The Modrinth Java catalog is disabled. Enable the Modrinth Java Catalog plugin to search Java projects.';
  }
  return 'That catalog source is not configured.';
}

function unsupportedCombination(source, edition, providerId) {
  const sourceLabel = providerId || source || 'that source';
  const editionLabel = edition === 'all' ? 'the selected edition' : edition;
  return {
    results: [],
    total: 0,
    page: 1,
    warning: `No catalog results: ${sourceLabel} does not include ${editionLabel} projects. Choose a matching source and edition.`,
    emptyReason: 'unsupported-combination',
  };
}

function matchingEntries({ source = 'all', provider, edition = 'all' } = {}) {
  ensureProviders();
  let list = catalogProviderRegistry.entries();
  const providerId = String(provider || '').trim();
  const sourceId = String(source || 'all').trim() || 'all';
  if (providerId) {
    list = list.filter((entry) => entry.id === providerId);
  } else if (sourceId !== 'all') {
    if (sourceId === LEGACY_CURSEFORGE_SOURCE) {
      list = list.filter((entry) => entry.id === BEDROCK_CURSEFORGE_ID);
    } else {
      list = list.filter((entry) => entry.id === sourceId || (entry.provider.getMetadata()?.source === sourceId && entry.id !== JAVA_CURSEFORGE_ID));
    }
  }
  if (edition !== 'all') {
    list = list.filter((entry) => (entry.editions || []).includes(edition));
  }
  return list;
}

function errorId(entry) {
  return entry.id === BEDROCK_CURSEFORGE_ID ? LEGACY_CURSEFORGE_SOURCE : entry.id;
}

function categoryForProvider(entry, category) {
  const requested = String(category || '').trim();
  if (!requested) return '';
  const colon = requested.indexOf(':');
  if (colon > 0) {
    const prefix = requested.slice(0, colon);
    return prefix === entry.id ? requested : '__skip__';
  }
  if (entry.id === JAVA_CURSEFORGE_ID || entry.id === JAVA_MODRINTH_ID) return '__skip__';
  return requested;
}

async function searchProvider(entry, query, options, errors, strict) {
  try {
    if (typeof entry.provider.isAvailable === 'function' && !entry.provider.isAvailable() && LOCAL_PROVIDER_IDS.has(entry.id)) {
      return { results: [], total: 0 };
    }
    const requested = minecraftVersions.parseRequestedGameVersions(options.gameVersions);
    const editions = entry.editions || entry.provider.getMetadata?.()?.editions || [];
    const versions = minecraftVersions.providerGameVersions(editions, requested);
    if (requested.length && !versions.length) {
      return { results: [], total: 0 };
    }
    const result = await entry.provider.search(query, { ...options, minecraftVersions: versions });
    return {
      results: result.results || [],
      total: result.total || 0,
    };
  } catch (err) {
    const message = err.message || 'Catalog search failed';
    errors.push({ source: errorId(entry), providerId: entry.id, error: message });
    if (entry.id === JAVA_CURSEFORGE_ID && err.code === 'CURSEFORGE_API_KEY_REQUIRED') {
      pluginAudit.record('catalog.search.unconfigured', {
        targetType: 'catalog-source',
        targetId: entry.id,
      });
    }
    if (strict) throw err;
    return { results: [], total: 0 };
  }
}

async function searchMods(query = '', options = {}) {
  const source = options.source || 'all';
  const provider = options.provider || '';
  const edition = normalizeEdition(options.edition);
  const page = parseInt(options.page, 10) || 1;
  const pageSize = clampPageSize(options.pageSize);
  options = {
    ...options,
    page,
    pageSize,
    edition,
    provider,
    source,
    gameVersions: minecraftVersions.parseRequestedGameVersions(options.gameVersions),
    loader: options.loader || '',
    environment: options.environment || '',
  };
  const available = sourceStatus();
  const errors = [];
  const matched = matchingEntries({ source, provider, edition });

  if ((source === 'git' || source === 'file') && !available[source] && (edition === 'all' || edition === 'bedrock')) {
    throw new Error(configureError(source));
  }
  if ((source === JAVA_CURSEFORGE_ID || provider === JAVA_CURSEFORGE_ID) && !catalogProviderRegistry.get(JAVA_CURSEFORGE_ID)) {
    return withMeta(unsupportedCombination(source, edition, JAVA_CURSEFORGE_ID), errors, available, {
      warning: 'CurseForge Java is disabled. Enable the CurseForge Java Catalog plugin to search Java projects.',
    });
  }
  if ((source === JAVA_MODRINTH_ID || provider === JAVA_MODRINTH_ID) && !catalogProviderRegistry.get(JAVA_MODRINTH_ID)) {
    return withMeta(unsupportedCombination(source, edition, JAVA_MODRINTH_ID), errors, available, {
      warning: 'Modrinth is disabled. Enable the Modrinth Java Catalog plugin to search Java projects.',
    });
  }
  if ((provider || (source && source !== 'all')) && !matched.length) {
    return withMeta(unsupportedCombination(source, edition, provider), errors, available);
  }
  if (!matched.length) {
    return withMeta({
      results: [],
      total: 0,
      page,
      warning: edition === 'java'
        ? 'No Java catalog sources are enabled. Enable the CurseForge Java Catalog or Modrinth Java Catalog plugin to search Java projects.'
        : 'No catalog sources match the selected filters.',
      emptyReason: 'no-providers',
    }, errors, available);
  }

  const locals = matched.filter((entry) => LOCAL_PROVIDER_IDS.has(entry.id));
  const remotes = matched.filter((entry) => !LOCAL_PROVIDER_IDS.has(entry.id));

  if (matched.length === 1 && !LOCAL_PROVIDER_IDS.has(matched[0].id)) {
    const category = categoryForProvider(matched[0], options.category);
    if (category === '__skip__') {
      return withMeta(unsupportedCombination(source, edition, matched[0].id), errors, available);
    }
    const result = await searchProvider(matched[0], query, { ...options, category }, errors, true);
    return withMeta({
      results: (result.results || []).map(catalogDownloadPolicy.applyCachedProjectAvailability),
      total: result.total,
      page,
    }, errors, available);
  }

  const local = [];
  for (const entry of locals) {
    const category = categoryForProvider(entry, options.category);
    if (category === '__skip__') continue;
    const result = await searchProvider(entry, query, {
      ...options,
      category,
      page: 1,
      pageSize: LOCAL_FETCH_SIZE,
    }, errors, source === entry.id);
    local.push(...(result.results || []).map(catalogDownloadPolicy.applyCachedProjectAvailability));
  }

  if (!remotes.length) {
    const start = Math.max(0, (page - 1) * pageSize);
    return withMeta({
      results: local.slice(start, start + pageSize),
      total: local.length,
      page,
    }, errors, available);
  }

  const start = Math.max(0, (page - 1) * pageSize);
  const localSlice = local.slice(start, start + pageSize);
  let remaining = pageSize - localSlice.length;
  let remoteOffset = Math.max(0, start - local.length);
  const remoteResults = [];
  let remoteTotal = 0;

  for (const entry of remotes) {
    const category = categoryForProvider(entry, options.category);
    if (category === '__skip__') continue;
    const slot = remotes.length > 1 && edition === 'all' && remaining > 0
      ? Math.max(1, Math.ceil(remaining / (remotes.length)))
      : remaining;
    const result = await searchProvider(entry, query, {
      ...options,
      category,
      offset: remaining > 0 ? remoteOffset : 0,
      pageSize: remaining > 0 ? (remotes.length > 1 && edition === 'all' ? slot : remaining) : 1,
    }, errors, source !== 'all' && matched.length === 1);
    remoteTotal += result.total || 0;
    if (remaining > 0) {
      const take = result.results.slice(0, remaining).map(catalogDownloadPolicy.applyCachedProjectAvailability);
      remoteResults.push(...take);
      remaining -= take.length;
    }
  }

  let warning;
  const anyLocal = available.git || available.file;
  const cfFailed = errors.some((item) => item.providerId === BEDROCK_CURSEFORGE_ID || item.source === LEGACY_CURSEFORGE_SOURCE);
  const javaFailed = errors.some((item) => item.providerId === JAVA_CURSEFORGE_ID);
  const modrinthFailed = errors.some((item) => item.providerId === JAVA_MODRINTH_ID);
  if (!anyLocal && cfFailed && !javaFailed && !modrinthFailed) {
    warning = 'CurseForge is unavailable. Open Catalog Settings to add a Git repository, file catalog, or CurseForge API key.';
  } else if (javaFailed) {
    warning = errors.find((item) => item.providerId === JAVA_CURSEFORGE_ID)?.error;
  } else if (modrinthFailed) {
    warning = errors.find((item) => item.providerId === JAVA_MODRINTH_ID)?.error;
  } else if (!available.curseforge && !anyLocal && !remoteResults.length && !local.length) {
    warning = 'No catalog sources are configured. Open Catalog Settings to add a Git repository, file catalog, or CurseForge API key.';
  }

  return withMeta({
    results: [...localSlice, ...remoteResults],
    total: local.length + remoteTotal,
    page,
  }, errors, available, warning);
}

async function getCategories(options = {}) {
  const edition = normalizeEdition(options.edition);
  const matched = matchingEntries({
    source: options.source || 'all',
    provider: options.provider,
    edition,
  });
  const categories = [];
  const seen = new Set();
  for (const entry of matched) {
    try {
      const items = await entry.provider.getCategories(options);
      for (const item of items || []) {
        const id = String(item.id);
        if (seen.has(id)) continue;
        seen.add(id);
        categories.push(item);
      }
    } catch {
      /* skip a failed provider's categories */
    }
  }
  return categories;
}

function catalogProjectId(body = {}, slug) {
  return body.curseforgeId || body.modrinthId || slug;
}

function javaMinecraftVersions(body = {}) {
  const requested = minecraftVersions.parseRequestedGameVersions(body.gameVersions || body.minecraftVersions);
  return minecraftVersions.providerGameVersions(['java'], requested);
}

function resolveDownloadEntry(body = {}) {
  const provider = String(body.provider || '').trim();
  const source = String(body.source || LEGACY_CURSEFORGE_SOURCE).trim();
  const edition = normalizeEdition(body.edition);
  if (provider) {
    return catalogProviderRegistry.requireProvider(provider);
  }
  if (source === JAVA_CURSEFORGE_ID) {
    return catalogProviderRegistry.requireProvider(JAVA_CURSEFORGE_ID);
  }
  const matched = matchingEntries({ source, edition });
  if (matched.length === 1) return matched[0];
  if (source === LEGACY_CURSEFORGE_SOURCE || source === 'curseforge') {
    return catalogProviderRegistry.requireProvider(BEDROCK_CURSEFORGE_ID);
  }
  const byId = catalogProviderRegistry.get(source);
  if (byId) return byId;
  throw Object.assign(new Error('Catalog source is not available'), { status: 400 });
}

async function downloadMod(slug, body = {}) {
  ensureProviders();
  const entry = resolveDownloadEntry(body);
  const selectedFiles = Array.isArray(body.files) ? body.files.map(String).filter(Boolean) : [];
  const javaPolicy = catalogDownloadPolicy.appliesJavaPolicy(entry, body);
  const projectId = catalogProjectId(body, slug);
  let files = [];
  try {
    files = await listDownloadFiles(slug, body);
  } catch (err) {
    if (javaPolicy && selectedFiles.length) throw err;
    files = [];
  }
  const availability = javaPolicy
    ? catalogDownloadPolicy.projectAvailability(files, { complete: true })
    : null;
  if (javaPolicy && files.length) {
    catalogDownloadPolicy.setCachedAvailability(entry.id, projectId, { files, availability }, {
      loader: body.loader,
      minecraftVersions: javaMinecraftVersions(body),
    });
  }

  if (javaPolicy && selectedFiles.length) {
    try {
      catalogDownloadPolicy.assertNoClientOnlySelection(files, selectedFiles, {
        providerId: entry.id,
        projectId,
      });
    } catch (err) {
      catalogDownloadPolicy.auditRejectedDownload({
        providerId: entry.id,
        projectId,
        fileId: err.fileId,
        code: err.code,
      });
      throw err;
    }
  } else if (javaPolicy && catalogDownloadPolicy.isClientOnlyAvailability(availability)) {
    catalogDownloadPolicy.auditRejectedDownload({
      providerId: entry.id,
      projectId,
      code: catalogDownloadPolicy.CLIENT_ONLY_CODE,
    });
    return {
      ...availability,
      files,
    };
  }

  const mode = settingsStore.getMultiFileMode();
  const javaCatalog = entry.id === JAVA_CURSEFORGE_ID || javaPolicy;
  const mixedLoaders = new Set(files.map((file) => file.loader || 'unknown')).size > 1;
  const unknownCompat = files.some((file) => !file.loader || file.loader === 'unknown');
  const needsJavaPicker = javaCatalog && (
    mixedLoaders
    || unknownCompat
    || availability?.downloadState === 'requires-selection'
  );
  const javaNeedsPicker = javaPolicy && !selectedFiles.length && files.length >= 1;
  if (javaNeedsPicker || (!selectedFiles.length && files.length > 1 && (mode === 'manual' || needsJavaPicker))) {
    return {
      needsSelection: true,
      files,
      warning: javaCatalog
        ? 'Choose a file that matches your Minecraft version and loader. The newest file is not always compatible.'
        : undefined,
      ...(availability || {}),
    };
  }

  const requestedLoader = catalogModMeta.normalizeLoader(body.loader, javaPolicy ? 'java' : 'bedrock');

  const downloaded = await entry.provider.download(projectId, selectedFiles, {
    slug,
    projectClass: body.projectClass,
    curseforgeId: body.curseforgeId,
    fileId: body.fileId,
    fileKind: body.fileKind,
    serverId: body.serverId,
    loader: javaPolicy ? requestedLoader : undefined,
    minecraftVersions: javaPolicy ? javaMinecraftVersions(body) : undefined,
    gameVersions: body.gameVersions,
  });
  if (downloaded?.needsSelection) {
    const listed = javaPolicy
      ? (downloaded.files || []).map(catalogDownloadPolicy.annotateFile)
      : downloaded.files;
    return {
      ...downloaded,
      files: listed,
      ...(availability || {}),
    };
  }
  if (downloaded?.plan) {
    if (javaPolicy) {
      try {
        catalogDownloadPolicy.assertPlanNotClientOnly(downloaded, { providerId: entry.id });
      } catch (err) {
        catalogDownloadPolicy.auditRejectedDownload({
          providerId: entry.id,
          projectId,
          fileId: err.fileId,
          code: err.code,
        });
        throw err;
      }
    }
    const importOpts = {
      allowHosts: entry.downloadHosts || entry.provider.getMetadata()?.downloadHosts || [],
      providerId: entry.id,
      loader: javaPolicy ? requestedLoader : undefined,
    };
    if (javaPolicy) {
      for (const related of downloaded.relatedPlans || []) {
        catalogDownloadPolicy.assertPlanNotClientOnly(related, { providerId: entry.id });
      }
    }
    const imported = await catalogLibrary.importDownloadPlan(downloaded, importOpts);
    const extras = [];
    for (const plan of downloaded.relatedPlans || []) {
      extras.push(await catalogLibrary.importDownloadPlan(plan, importOpts));
    }
    if (!extras.length) return imported;
    return {
      ...imported,
      dependencies: extras.map((item) => ({
        modId: item.modId,
        name: item.name,
        merged: item.merged,
        files: item.files,
      })),
    };
  }
  return downloaded;
}

async function listDownloadFiles(slug, body = {}) {
  ensureProviders();
  const entry = resolveDownloadEntry(body);
  const projectId = catalogProjectId(body, slug);
  const javaPolicy = catalogDownloadPolicy.appliesJavaPolicy(entry, body);
  const cacheExtra = javaPolicy
    ? { loader: body.loader, minecraftVersions: javaMinecraftVersions(body) }
    : {};
  if (javaPolicy) {
    const cached = catalogDownloadPolicy.getCachedAvailability(entry.id, projectId, cacheExtra);
    if (cached?.files) return cached.files;
  }
  const files = await entry.provider.listDownloadFiles(projectId, {
    slug,
    projectClass: body.projectClass,
    curseforgeId: body.curseforgeId,
    fileKind: body.fileKind,
    loader: body.loader,
    minecraftVersions: javaPolicy ? cacheExtra.minecraftVersions : undefined,
    gameVersions: body.gameVersions,
  });
  if (!javaPolicy) return files;
  const annotated = (files || []).map(catalogDownloadPolicy.annotateFile);
  const availability = catalogDownloadPolicy.projectAvailability(annotated, { complete: true });
  catalogDownloadPolicy.setCachedAvailability(entry.id, projectId, {
    files: annotated,
    availability,
  }, cacheExtra);
  return annotated;
}

function setMultiFileMode(mode) {
  settingsStore.setMultiFileMode(mode);
  return getSettings();
}

async function getDetails(slug, query = {}) {
  ensureProviders();
  const entry = resolveDownloadEntry(query);
  const details = await entry.provider.getDetails(query.curseforgeId || query.modrinthId || slug, {
    slug,
    projectClass: query.projectClass,
    fileKind: query.fileKind,
  });
  return details ? catalogDownloadPolicy.applyCachedProjectAvailability(details) : details;
}

function listProviders() {
  const listed = publicSources();
  return {
    ...listed,
    editions: catalogProviderRegistry.availableEditions(),
  };
}

function getSettings() {
  const settings = settingsStore.publicCatalogSettings();
  let gitModCount = 0;
  let fileModCount = 0;
  if (settings.git.enabled && settings.git.url) {
    try {
      gitModCount = gitCatalog.loadEntries().length;
    } catch {
      gitModCount = 0;
    }
  }
  try {
    fileModCount = fileCatalog.isConfigured() ? fileCatalog.loadEntries().length : 0;
  } catch {
    fileModCount = 0;
  }
  return {
    ...settings,
    git: {
      ...settings.git,
      modCount: gitModCount,
      sync: gitCatalog.getSyncStatus(),
    },
    files: {
      ...settings.files,
      defaultLocalPath: fileCatalog.defaultLocalPath(),
      modCount: fileModCount,
    },
  };
}

function saveFileSettings(files = {}, body = {}) {
  if (typeof files.enabled === 'boolean') {
    settingsStore.set(settingsStore.KEYS.FILE_ENABLED, files.enabled ? '1' : '0');
  }
  const local = files.local || {};
  if (typeof local.enabled === 'boolean') {
    settingsStore.set(settingsStore.KEYS.FILE_LOCAL_ENABLED, local.enabled ? '1' : '0');
  }
  if (typeof local.path === 'string') {
    fileCatalog.assertSafePath(local.path);
    settingsStore.set(settingsStore.KEYS.FILE_LOCAL_PATH, local.path.trim());
  }
  const smb = files.smb || {};
  if (typeof smb.enabled === 'boolean') {
    settingsStore.set(settingsStore.KEYS.FILE_SMB_ENABLED, smb.enabled ? '1' : '0');
  }
  if (typeof smb.path === 'string') {
    fileCatalog.assertSafePath(smb.path);
    settingsStore.set(settingsStore.KEYS.FILE_SMB_PATH, smb.path.trim());
  }
  if (typeof smb.username === 'string') {
    settingsStore.set(settingsStore.KEYS.FILE_SMB_USERNAME, smb.username.trim());
  }
  if (body.clearSmbPassword) {
    settingsStore.remove(settingsStore.KEYS.FILE_SMB_PASSWORD);
  } else if (typeof smb.password === 'string' && smb.password.trim()) {
    settingsStore.set(settingsStore.KEYS.FILE_SMB_PASSWORD, smb.password.trim());
  }
  const nfs = files.nfs || {};
  if (typeof nfs.enabled === 'boolean') {
    settingsStore.set(settingsStore.KEYS.FILE_NFS_ENABLED, nfs.enabled ? '1' : '0');
  }
  if (typeof nfs.path === 'string') {
    fileCatalog.assertSafePath(nfs.path);
    settingsStore.set(settingsStore.KEYS.FILE_NFS_PATH, nfs.path.trim());
  }
  fileCatalog.invalidate();
}

function saveSettings(body = {}) {
  const git = body.git || {};
  const files = body.files || {};

  if (typeof git.url === 'string' && git.url.trim()) {
    gitCatalog.assertRemoteUrl(git.url.trim());
  }
  if (typeof git.subdir === 'string' && git.subdir.includes('..')) {
    throw new Error('Catalog subdirectory cannot contain ".."');
  }

  if (body.clearCurseforgeApiKey) {
    settingsStore.remove(settingsStore.KEYS.CURSEFORGE_API_KEY);
  } else if (typeof body.curseforgeApiKey === 'string' && body.curseforgeApiKey.trim()) {
    settingsStore.set(settingsStore.KEYS.CURSEFORGE_API_KEY, body.curseforgeApiKey.trim());
  }

  if (typeof git.enabled === 'boolean') {
    settingsStore.set(settingsStore.KEYS.GIT_ENABLED, git.enabled ? '1' : '0');
  }
  if (typeof git.url === 'string') {
    settingsStore.set(settingsStore.KEYS.GIT_URL, git.url.trim());
  }
  if (typeof git.branch === 'string') {
    settingsStore.set(settingsStore.KEYS.GIT_BRANCH, git.branch.trim() || 'main');
  }
  if (typeof git.username === 'string') {
    settingsStore.set(settingsStore.KEYS.GIT_USERNAME, git.username.trim());
  }
  if (typeof git.subdir === 'string') {
    settingsStore.set(settingsStore.KEYS.GIT_SUBDIR, git.subdir.trim());
  }
  if (body.clearGitToken) {
    settingsStore.remove(settingsStore.KEYS.GIT_TOKEN);
  } else if (typeof git.token === 'string' && git.token.trim()) {
    settingsStore.set(settingsStore.KEYS.GIT_TOKEN, git.token.trim());
  }

  saveFileSettings(files, body);
  gitCatalog.entriesCache = null;
  return getSettings();
}

async function testGitConnection(body = {}) {
  const current = settingsStore.getGitConfig();
  return gitCatalog.testConnection({
    url: (body.url && String(body.url).trim()) || current.url,
    branch: (body.branch && String(body.branch).trim()) || current.branch,
    username: (body.username && String(body.username).trim()) || current.username,
    token: (body.token && String(body.token).trim()) || current.token,
  });
}

async function testFileConnection(body = {}) {
  const config = settingsStore.getFileCatalogConfig();
  const kind = String(body.kind || 'local').toLowerCase();
  const current = config[kind] || {};
  return fileCatalog.testConnection({
    kind,
    path: (body.path && String(body.path).trim()) || current.path,
    username: (body.username && String(body.username).trim()) || current.username,
    password: (body.password && String(body.password).trim()) || current.password,
  });
}

function withMeta(result, errors, available, warning) {
  const { sources, providers } = publicSources();
  const warningText = warning && typeof warning === 'object' ? warning.warning : warning;
  return {
    ...result,
    sources,
    providers,
    errors,
    warning: warningText || result.warning,
  };
}

module.exports = {
  searchMods,
  getCategories,
  downloadMod,
  listDownloadFiles,
  getDetails,
  getSettings,
  saveSettings,
  setMultiFileMode,
  testGitConnection,
  testFileConnection,
  sourceStatus,
  listProviders,
  ensureProviders,
};
