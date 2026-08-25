const settingsStore = require('./settingsStore');
const { SECRET_OWNERS, SECRET_STORAGE_KEYS } = require('./pluginSettingsSchema');
const pluginAudit = require('./pluginAudit');

const STORAGE = {
  curseforge_api_key: {
    key: settingsStore.KEYS.CURSEFORGE_API_KEY,
    env: 'CURSEFORGE_API_KEY',
  },
  git_catalog_token: {
    key: settingsStore.KEYS.GIT_TOKEN,
    env: 'GIT_CATALOG_TOKEN',
  },
  file_catalog_smb_password: {
    key: settingsStore.KEYS.FILE_SMB_PASSWORD,
    env: 'FILE_CATALOG_SMB_PASSWORD',
  },
};

function assertOwned(pluginId, storageKey) {
  if (!SECRET_STORAGE_KEYS.has(storageKey) || SECRET_OWNERS[storageKey] !== pluginId) {
    throw Object.assign(new Error('Plugin cannot access that secret'), { status: 403 });
  }
}

function storedValue(storageKey) {
  const spec = STORAGE[storageKey];
  if (!spec) return '';
  return settingsStore.getSecret(spec.key, process.env[spec.env] || '');
}

function fromEnvOnly(storageKey) {
  const spec = STORAGE[storageKey];
  if (!spec) return false;
  return !settingsStore.get(spec.key) && Boolean(String(process.env[spec.env] || '').trim());
}

function status(pluginId, storageKey) {
  assertOwned(pluginId, storageKey);
  const configured = Boolean(storedValue(storageKey));
  return {
    configured,
    fromEnv: configured && fromEnvOnly(storageKey),
  };
}

function setValue(pluginId, storageKey, value, { actor = 'local' } = {}) {
  assertOwned(pluginId, storageKey);
  const spec = STORAGE[storageKey];
  const next = String(value || '').trim();
  const had = Boolean(settingsStore.get(spec.key) || process.env[spec.env]);
  if (!next) {
    settingsStore.remove(spec.key);
    pluginAudit.record(had ? 'secret.cleared' : 'secret.cleared', {
      actor,
      targetType: 'secret',
      targetId: storageKey,
      detail: { pluginId, configured: false },
    });
    return status(pluginId, storageKey);
  }
  settingsStore.set(spec.key, next);
  pluginAudit.record(had ? 'secret.replaced' : 'secret.configured', {
    actor,
    targetType: 'secret',
    targetId: storageKey,
    detail: { pluginId, configured: true },
  });
  return status(pluginId, storageKey);
}

function clearValue(pluginId, storageKey, { actor = 'local' } = {}) {
  return setValue(pluginId, storageKey, '', { actor });
}

function applyPostedSecrets(pluginId, posted = {}, { persist = false, actor = 'local' } = {}) {
  const map = {};
  const statuses = {};
  if (!posted || typeof posted !== 'object' || Array.isArray(posted)) {
    return { overlay: map, statuses };
  }
  for (const [secretId, row] of Object.entries(posted)) {
    if (!row || typeof row !== 'object') continue;
    const storageKey = String(row.storageKey || '').trim();
    if (!storageKey) continue;
    assertOwned(pluginId, storageKey);
    if (row.clear) {
      map[storageKey] = '';
      if (persist) statuses[secretId] = clearValue(pluginId, storageKey, { actor });
      else statuses[secretId] = { configured: false, fromEnv: false };
      continue;
    }
    if (typeof row.value === 'string' && row.value.trim()) {
      map[storageKey] = row.value.trim();
      if (persist) statuses[secretId] = setValue(pluginId, storageKey, row.value, { actor });
      else statuses[secretId] = { configured: true, fromEnv: false };
    }
  }
  return { overlay: map, statuses };
}

function runWithOverlay(map, fn) {
  const translated = {};
  for (const [storageKey, value] of Object.entries(map || {})) {
    const spec = STORAGE[storageKey];
    if (spec) translated[spec.key] = value;
  }
  return settingsStore.runWithSecretOverlay(translated, fn);
}

function readForStore(storageKey) {
  return storedValue(storageKey);
}

module.exports = {
  STORAGE,
  applyPostedSecrets,
  clearValue,
  readForStore,
  runWithOverlay,
  setValue,
  status,
};
