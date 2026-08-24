const gitCatalog = require('./gitCatalogClient');
const settingsStore = require('./settingsStore');
const pluginAudit = require('./pluginAudit');
const pluginSecrets = require('./pluginSecrets');
const gitCatalogTemplate = require('./gitCatalogTemplate');

function assertOwner(plugin) {
  if (!plugin || plugin.id !== 'catalog-git' || plugin.source !== 'bundled') {
    throw Object.assign(new Error('Git catalog service is limited to the Git Catalog plugin'), { status: 403 });
  }
}

function publicConfig() {
  const settings = settingsStore.publicCatalogSettings().git;
  return {
    enabled: Boolean(settings.enabled),
    url: settings.url || '',
    branch: settings.branch || 'main',
    username: settings.username || '',
    tokenSet: Boolean(settings.tokenSet),
    subdir: settings.subdir || '',
    lastSync: settings.lastSync || '',
    fromEnv: Boolean(settings.fromEnv),
  };
}

function updateConfig(values = {}, { actor = 'local' } = {}) {
  if (typeof values.url === 'string' && values.url.trim()) {
    gitCatalog.assertRemoteUrl(values.url.trim());
  }
  if (typeof values.subdir === 'string' && values.subdir.includes('..')) {
    throw Object.assign(new Error('Catalog subdirectory cannot contain ".."'), { status: 400 });
  }
  if (typeof values.enabled === 'boolean') {
    settingsStore.set(settingsStore.KEYS.GIT_ENABLED, values.enabled ? '1' : '0');
  }
  if (typeof values.url === 'string') settingsStore.set(settingsStore.KEYS.GIT_URL, values.url.trim());
  if (typeof values.branch === 'string') {
    settingsStore.set(settingsStore.KEYS.GIT_BRANCH, values.branch.trim() || 'main');
  }
  if (typeof values.username === 'string') {
    settingsStore.set(settingsStore.KEYS.GIT_USERNAME, values.username.trim());
  }
  if (typeof values.subdir === 'string') {
    settingsStore.set(settingsStore.KEYS.GIT_SUBDIR, values.subdir.trim());
  }
  gitCatalog.entriesCache = null;
  pluginAudit.record('catalog.git.updated', {
    actor,
    targetType: 'catalog-source',
    targetId: 'git',
    detail: {
      enabled: typeof values.enabled === 'boolean' ? values.enabled : undefined,
      hasUrl: Boolean(String(values.url || '').trim()),
    },
  });
  return publicConfig();
}

async function testConnection(values = {}, { actor = 'local' } = {}) {
  const current = settingsStore.getGitConfig();
  const result = await gitCatalog.testConnection({
    url: (values.url && String(values.url).trim()) || current.url,
    branch: (values.branch && String(values.branch).trim()) || current.branch,
    username: (values.username && String(values.username).trim()) || current.username,
    token: pluginSecrets.readForStore('git_catalog_token') || current.token,
  });
  pluginAudit.record('catalog.git.tested', {
    actor,
    targetType: 'catalog-source',
    targetId: 'git',
    detail: { ok: true },
  });
  return result;
}

function startSync(reason = 'manual', { actor = 'local' } = {}) {
  if (!gitCatalog.canSync()) {
    throw Object.assign(new Error('Save settings with the Git catalog enabled and an access token to sync'), { status: 400 });
  }
  gitCatalog.startSync(reason).catch(() => {});
  pluginAudit.record('catalog.git.sync.started', {
    actor,
    targetType: 'catalog-source',
    targetId: 'git',
    detail: { reason },
  });
  return gitCatalog.getSyncStatus();
}

function syncStatus() {
  return gitCatalog.getSyncStatus();
}

function starterZip() {
  return {
    filename: gitCatalogTemplate.STARTER_FILENAME,
    buffer: gitCatalogTemplate.buildStarterZip(),
  };
}

function forPlugin(plugin) {
  assertOwner(plugin);
  return {
    publicConfig,
    updateConfig,
    testConnection,
    startSync,
    syncStatus,
    starterZip,
    isConfigured: () => gitCatalog.isConfigured(),
  };
}

module.exports = {
  forPlugin,
  publicConfig,
  startSync,
  starterZip,
  syncStatus,
  testConnection,
  updateConfig,
};
