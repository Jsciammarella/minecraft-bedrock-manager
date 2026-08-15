const db = require('../db/connection');

const KEYS = {
  CURSEFORGE_API_KEY: 'curseforge_api_key',
  GIT_ENABLED: 'git_catalog_enabled',
  GIT_URL: 'git_catalog_url',
  GIT_BRANCH: 'git_catalog_branch',
  GIT_USERNAME: 'git_catalog_username',
  GIT_TOKEN: 'git_catalog_token',
  GIT_SUBDIR: 'git_catalog_subdir',
  GIT_LAST_SYNC: 'git_catalog_last_sync',
};

const SECRET_KEYS = new Set([KEYS.CURSEFORGE_API_KEY, KEYS.GIT_TOKEN]);

function get(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : '';
}

function set(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value == null ? '' : String(value));
}

function remove(key) {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function fromEnv(name) {
  const value = process.env[name];
  return value == null ? '' : String(value);
}

function getSecret(key, envFallback = '') {
  return get(key) || envFallback || '';
}

function getCurseForgeApiKey() {
  return getSecret(KEYS.CURSEFORGE_API_KEY, fromEnv('CURSEFORGE_API_KEY'));
}

function getGitConfig() {
  const dbEnabled = get(KEYS.GIT_ENABLED);
  const enabled = dbEnabled
    ? isTruthy(dbEnabled)
    : isTruthy(fromEnv('GIT_CATALOG_ENABLED'));

  return {
    enabled,
    url: get(KEYS.GIT_URL) || fromEnv('GIT_CATALOG_URL'),
    branch: get(KEYS.GIT_BRANCH) || fromEnv('GIT_CATALOG_BRANCH') || 'main',
    username: get(KEYS.GIT_USERNAME) || fromEnv('GIT_CATALOG_USERNAME'),
    token: getSecret(KEYS.GIT_TOKEN, fromEnv('GIT_CATALOG_TOKEN')),
    subdir: get(KEYS.GIT_SUBDIR) || fromEnv('GIT_CATALOG_SUBDIR'),
    lastSync: get(KEYS.GIT_LAST_SYNC) || '',
  };
}

function publicCatalogSettings() {
  const git = getGitConfig();
  const curseforgeKey = getCurseForgeApiKey();
  return {
    curseforge: {
      configured: Boolean(curseforgeKey),
      apiKeySet: Boolean(curseforgeKey),
      fromEnv: !get(KEYS.CURSEFORGE_API_KEY) && Boolean(fromEnv('CURSEFORGE_API_KEY')),
    },
    git: {
      enabled: git.enabled,
      url: git.url,
      branch: git.branch || 'main',
      username: git.username,
      tokenSet: Boolean(git.token),
      subdir: git.subdir,
      lastSync: git.lastSync,
      fromEnv: !get(KEYS.GIT_URL) && Boolean(fromEnv('GIT_CATALOG_URL')),
    },
  };
}

module.exports = {
  KEYS,
  SECRET_KEYS,
  get,
  set,
  remove,
  isTruthy,
  getSecret,
  getCurseForgeApiKey,
  getGitConfig,
  publicCatalogSettings,
};
