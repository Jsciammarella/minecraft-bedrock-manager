const curseforge = require('./curseforgeClient');
const gitCatalog = require('./gitCatalogClient');
const settingsStore = require('./settingsStore');

const CATALOG_PAGE_SIZE = 40;

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
  };
}

async function searchMods(query = '', options = {}) {
  const source = options.source || 'all';
  const page = parseInt(options.page, 10) || 1;
  const pageSize = clampPageSize(options.pageSize);
  options = { ...options, page, pageSize };
  const available = sourceStatus();
  const errors = [];
  let curseforgeResult = { results: [], total: 0, page };
  let gitResult = { results: [], total: 0, page };

  if (source === 'git' && !available.git) {
    throw new Error('Git catalog is not configured. Add a repository in Catalog Settings.');
  }

  const wantCurseforge = source === 'all' || source === 'curseforge';
  const wantGit = source === 'all' || source === 'git';

  if (wantGit && available.git) {
    try {
      const start = Math.max(0, (page - 1) * pageSize);
      gitResult = await gitCatalog.searchMods(query, {
        ...options,
        page: source === 'git' ? page : 1,
        pageSize: source === 'git' ? pageSize : start + pageSize,
      });
    } catch (err) {
      errors.push({ source: 'git', error: err.message });
      if (source === 'git') throw err;
    }
  }

  if (source === 'git') {
    return withMeta(gitResult, errors, available);
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

  const gitTotal = gitResult.total || 0;
  const start = Math.max(0, (page - 1) * pageSize);
  const gitSlice = (gitResult.results || []).slice(start, start + pageSize);
  const remaining = pageSize - gitSlice.length;
  const cfOffset = Math.max(0, start - gitTotal);

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

  const cfResults = (curseforgeResult.results || []).map(item => ({ ...item, source: item.source || 'curseforge' }));

  let warning;
  if (!available.git && errors.some(item => item.source === 'curseforge')) {
    warning = 'CurseForge is unavailable. Open Catalog Settings to add a Git repository or a CurseForge API key.';
  } else if (!available.curseforge && !available.git && (curseforgeResult.results || []).length === 0) {
    warning = 'No catalog sources are configured. Open Catalog Settings to add a Git repository or a CurseForge API key.';
  }

  return withMeta({
    results: [...gitSlice, ...cfResults],
    total: gitTotal + (curseforgeResult.total || 0),
    page,
  }, errors, available, warning);
}

async function getCategories() {
  const categories = await curseforge.getCategories();
  const seen = new Set(categories.map(item => item.id));
  for (const extra of gitCatalog.getDiscoveredCategories()) {
    if (!seen.has(extra.id)) {
      categories.push(extra);
      seen.add(extra.id);
    }
  }
  return categories;
}

async function downloadMod(slug, body = {}) {
  const source = body.source || 'curseforge';
  if (source === 'git') {
    return gitCatalog.downloadMod(slug, body.serverId);
  }
  return curseforge.downloadMod(
    slug,
    body.projectClass,
    body.serverId,
    { modId: body.curseforgeId, fileId: body.fileId }
  );
}

async function getDetails(slug, query = {}) {
  if (query.source === 'git') {
    return gitCatalog.getMod(slug) || null;
  }
  return curseforge.getModDetails(slug, query.projectClass);
}

function getSettings() {
  const settings = settingsStore.publicCatalogSettings();
  let gitModCount = 0;
  if (settings.git.enabled && settings.git.url) {
    try {
      gitModCount = gitCatalog.loadEntries().length;
    } catch {
      gitModCount = 0;
    }
  }
  return {
    ...settings,
    git: {
      ...settings.git,
      modCount: gitModCount,
      sync: gitCatalog.getSyncStatus(),
    },
  };
}

function saveSettings(body = {}) {
  const git = body.git || {};

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

function markSource(result, source) {
  return {
    ...result,
    results: (result.results || []).map(item => ({ ...item, source: item.source || source })),
  };
}

function withMeta(result, errors, available, warning) {
  return {
    ...result,
    sources: {
      curseforge: { available: available.curseforge },
      git: { available: available.git },
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
  testGitConnection,
  sourceStatus,
};
