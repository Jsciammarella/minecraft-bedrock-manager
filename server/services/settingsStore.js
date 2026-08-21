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
  FILE_ENABLED: 'file_catalog_enabled',
  FILE_LOCAL_ENABLED: 'file_catalog_local_enabled',
  FILE_LOCAL_PATH: 'file_catalog_local_path',
  FILE_SMB_ENABLED: 'file_catalog_smb_enabled',
  FILE_SMB_PATH: 'file_catalog_smb_path',
  FILE_SMB_USERNAME: 'file_catalog_smb_username',
  FILE_SMB_PASSWORD: 'file_catalog_smb_password',
  FILE_NFS_ENABLED: 'file_catalog_nfs_enabled',
  FILE_NFS_PATH: 'file_catalog_nfs_path',
  MULTI_FILE_MODE: 'catalog_multi_file_mode',
  BEDROCK_CONNECT_PENDING: 'bedrock_connect_pending',
  LAN_BROADCAST_PENDING: 'lan_broadcast_pending',
  BEDROCK_DNS_ENABLED: 'bedrock_dns_enabled',
  BEDROCK_DNS_UPSTREAMS: 'bedrock_dns_upstreams',
  BEDROCK_DNS_OVERRIDES: 'bedrock_dns_overrides',
};

const SECRET_KEYS = new Set([KEYS.CURSEFORGE_API_KEY, KEYS.GIT_TOKEN, KEYS.FILE_SMB_PASSWORD]);

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

function getFlag(key, envName, defaultValue = false) {
  const stored = get(key);
  if (stored) return isTruthy(stored);
  const envValue = fromEnv(envName);
  if (envValue) return isTruthy(envValue);
  return defaultValue;
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

function getMultiFileMode() {
  const stored = String(get(KEYS.MULTI_FILE_MODE) || '').trim().toLowerCase();
  if (stored === 'auto' || stored === 'manual') return stored;
  const envValue = String(fromEnv('CATALOG_MULTI_FILE_MODE') || '').trim().toLowerCase();
  if (envValue === 'auto' || envValue === 'manual') return envValue;
  return 'manual';
}

function setMultiFileMode(mode) {
  const value = String(mode || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual';
  set(KEYS.MULTI_FILE_MODE, value);
  return value;
}

function getFileCatalogConfig() {
  return {
    enabled: getFlag(KEYS.FILE_ENABLED, 'FILE_CATALOG_ENABLED', true),
    local: {
      enabled: getFlag(KEYS.FILE_LOCAL_ENABLED, 'FILE_CATALOG_LOCAL_ENABLED', true),
      path: get(KEYS.FILE_LOCAL_PATH) || fromEnv('FILE_CATALOG_LOCAL_PATH'),
    },
    smb: {
      enabled: getFlag(KEYS.FILE_SMB_ENABLED, 'FILE_CATALOG_SMB_ENABLED', false),
      path: get(KEYS.FILE_SMB_PATH) || fromEnv('FILE_CATALOG_SMB_PATH'),
      username: get(KEYS.FILE_SMB_USERNAME) || fromEnv('FILE_CATALOG_SMB_USERNAME'),
      password: getSecret(KEYS.FILE_SMB_PASSWORD, fromEnv('FILE_CATALOG_SMB_PASSWORD')),
    },
    nfs: {
      enabled: getFlag(KEYS.FILE_NFS_ENABLED, 'FILE_CATALOG_NFS_ENABLED', false),
      path: get(KEYS.FILE_NFS_PATH) || fromEnv('FILE_CATALOG_NFS_PATH'),
    },
  };
}

function publicCatalogSettings() {
  const git = getGitConfig();
  const files = getFileCatalogConfig();
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
    multiFileMode: getMultiFileMode(),
    files: {
      enabled: files.enabled,
      local: {
        enabled: files.local.enabled,
        path: files.local.path,
      },
      smb: {
        enabled: files.smb.enabled,
        path: files.smb.path,
        username: files.smb.username,
        passwordSet: Boolean(files.smb.password),
      },
      nfs: {
        enabled: files.nfs.enabled,
        path: files.nfs.path,
      },
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
  getFileCatalogConfig,
  getMultiFileMode,
  setMultiFileMode,
  publicCatalogSettings,
};
