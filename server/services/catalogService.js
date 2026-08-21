const curseforge = require('./curseforgeClient');
const gitCatalog = require('./gitCatalogClient');
const fileCatalog = require('./fileCatalogClient');
const settingsStore = require('./settingsStore');

const CATALOG_PAGE_SIZE = 40;
const LOCAL_FETCH_SIZE = 10000;

function clampPageSize(value) {
  const size = parseInt(value, 10);
  if (!Number.isFinite(size) || size < 1) return CATALOG_PAGE_SIZE;
  return Math.min(size, CATALOG_PAGE_SIZE);
}

function sourceStatus() {
  const settings = settingsStore.publicCatalogSettings();
  return {
    curseforge: settings.curseforge.configured,
    git: Boolean(settings.git.enabled && settings.git.url),
    file: fileCatalog.isConfigured(),
  };
}

function configureError(source) {
  if (source === 'git') {
    return 'Git catalog is not configured. Add a repository in Catalog Settings.';
  }
  if (source === 'file') {
    return 'File catalog is not configured. Enable a local folder, SMB share, or NFS path in Catalog Settings.';
  }
  return 'That catalog source is not configured.';
}

async function collectLocal(label, fn, source, errors) {
  try {
    const result = await fn();
    return (result.results || []).map((item) => ({ ...item, source: item.source || label }));
  } catch (err) {
    errors.push({ source: label, error: err.message });
    if (source === label) throw err;
    return [];
  }
}

async function searchMods(query = '', options = {}) {
  const source = options.source || 'all';
  const page = parseInt(options.page, 10) || 1;
  const pageSize = clampPageSize(options.pageSize);
  options = { ...options, page, pageSize };
  const available = sourceStatus();
  const errors = [];
  let curseforgeResult = { results: [], total: 0, page };

  if ((source === 'git' || source === 'file') && !available[source]) {
    throw new Error(configureError(source));
  }

  const wantCurseforge = source === 'all' || source === 'curseforge';
  const wantGit = source === 'all' || source === 'git';
  const wantFile = source === 'all' || source === 'file';
  const local = [];

  if (wantGit && available.git) {
    local.push(...await collectLocal('git', () => gitCatalog.searchMods(query, {
      ...options,
      page: 1,
      pageSize: LOCAL_FETCH_SIZE,
    }), source, errors));
  }
  if (wantFile && available.file) {
    local.push(...await collectLocal('file', () => fileCatalog.searchMods(query, {
      ...options,
      page: 1,
      pageSize: LOCAL_FETCH_SIZE,
    }), source, errors));
  }

  if (source === 'git' || source === 'file') {
    const start = Math.max(0, (page - 1) * pageSize);
    return withMeta({
      results: local.slice(start, start + pageSize),
      total: local.length,
      page,
    }, errors, available);
  }

  if (source === 'curseforge') {
    try {
      curseforgeResult = await curseforge.searchMods(query, options);
    } catch (err) {
      errors.push({ source: 'curseforge', error: err.message });
      throw err;
    }
    return withMeta(markSource(curseforgeResult, 'curseforge'), errors, available);
  }

  const start = Math.max(0, (page - 1) * pageSize);
  const localSlice = local.slice(start, start + pageSize);
  const remaining = pageSize - localSlice.length;
  const cfOffset = Math.max(0, start - local.length);

  if (wantCurseforge) {
    try {
      const cfPageSize = remaining > 0 ? remaining : 1;
      const cfOffsetActual = remaining > 0 ? cfOffset : 0;
      curseforgeResult = await curseforge.searchMods(query, {
        ...options,
        offset: cfOffsetActual,
        pageSize: cfPageSize,
      });
      if (remaining === 0) {
        curseforgeResult = { ...curseforgeResult, results: [] };
      }
    } catch (err) {
      errors.push({ source: 'curseforge', error: err.message });
    }
  }

  const cfResults = (curseforgeResult.results || []).map((item) => ({ ...item, source: item.source || 'curseforge' }));
  const anyLocal = available.git || available.file;

  let warning;
  if (!anyLocal && errors.some((item) => item.source === 'curseforge')) {
    warning = 'CurseForge is unavailable. Open Catalog Settings to add a Git repository, file catalog, or CurseForge API key.';
  } else if (!available.curseforge && !anyLocal && (curseforgeResult.results || []).length === 0 && local.length === 0) {
    warning = 'No catalog sources are configured. Open Catalog Settings to add a Git repository, file catalog, or CurseForge API key.';
  }

  return withMeta({
    results: [...localSlice, ...cfResults],
    total: local.length + (curseforgeResult.total || 0),
    page,
  }, errors, available, warning);
}

async function getCategories() {
  const categories = await curseforge.getCategories();
  const seen = new Set(categories.map((item) => item.id));
  for (const extra of [...gitCatalog.getDiscoveredCategories(), ...fileCatalog.getDiscoveredCategories()]) {
    if (!seen.has(extra.id)) {
      categories.push(extra);
      seen.add(extra.id);
    }
  }
  return categories;
}

async function downloadMod(slug, body = {}) {
  const source = body.source || 'curseforge';
  const selectedFiles = Array.isArray(body.files) ? body.files.map(String).filter(Boolean) : [];
  let files = [];
  try {
    files = await listDownloadFiles(slug, body);
  } catch {
    files = [];
  }
  const mode = settingsStore.getMultiFileMode();
  if (mode === 'manual' && files.length > 1 && !selectedFiles.length) {
    return { needsSelection: true, files };
  }

  if (source === 'git') {
    return gitCatalog.downloadMod(slug, body.serverId, selectedFiles);
  }
  if (source === 'file') {
    return fileCatalog.downloadMod(slug, body.serverId, body.fileKind, selectedFiles);
  }
  return curseforge.downloadMod(
    slug,
    body.projectClass,
    body.serverId,
    { modId: body.curseforgeId, fileId: body.fileId },
    selectedFiles
  );
}

async function listDownloadFiles(slug, body = {}) {
  const source = body.source || 'curseforge';
  if (source === 'git') return gitCatalog.listDownloadFiles(slug);
  if (source === 'file') return fileCatalog.listDownloadFiles(slug, body.fileKind);
  const modId = body.curseforgeId || await curseforge.findModIdBySlug(slug, body.projectClass);
  if (!modId) return [];
  return curseforge.listDownloadableFiles(modId);
}

function setMultiFileMode(mode) {
  settingsStore.setMultiFileMode(mode);
  return getSettings();
}

async function getDetails(slug, query = {}) {
  if (query.source === 'git') {
    return gitCatalog.getMod(slug) || null;
  }
  if (query.source === 'file') {
    return fileCatalog.getMod(slug, query.fileKind) || null;
  }
  return curseforge.getModDetails(slug, query.projectClass);
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

function markSource(result, source) {
  return {
    ...result,
    results: (result.results || []).map((item) => ({ ...item, source: item.source || source })),
  };
}

function withMeta(result, errors, available, warning) {
  return {
    ...result,
    sources: {
      curseforge: { available: available.curseforge },
      git: { available: available.git },
      file: { available: available.file },
    },
    errors,
    warning,
  };
}

module.exports = {
  searchMods,
  getCategories,
  downloadMod,
  getDetails,
  getSettings,
  saveSettings,
  setMultiFileMode,
  testGitConnection,
  testFileConnection,
  sourceStatus,
};
