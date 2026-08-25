const fileCatalog = require('./fileCatalogClient');
const settingsStore = require('./settingsStore');
const pluginAudit = require('./pluginAudit');
const pluginSecrets = require('./pluginSecrets');
const fileCatalogTemplate = require('./fileCatalogTemplate');

function assertOwner(plugin) {
  if (!plugin || plugin.id !== 'catalog-file' || plugin.source !== 'bundled') {
    throw Object.assign(new Error('File catalog service is limited to the File Catalog plugin'), { status: 403 });
  }
}

function publicConfig() {
  const settings = settingsStore.publicCatalogSettings().files;
  let modCount = 0;
  try {
    modCount = fileCatalog.isConfigured() ? fileCatalog.loadEntries().length : 0;
  } catch {
    modCount = 0;
  }
  return {
    enabled: settings.enabled !== false,
    defaultLocalPath: fileCatalog.defaultLocalPath(),
    modCount,
    local: {
      enabled: settings.local?.enabled !== false,
      path: settings.local?.path || '',
    },
    smb: {
      enabled: Boolean(settings.smb?.enabled),
      path: settings.smb?.path || '',
      username: settings.smb?.username || '',
      passwordSet: Boolean(settings.smb?.passwordSet),
    },
    nfs: {
      enabled: Boolean(settings.nfs?.enabled),
      path: settings.nfs?.path || '',
    },
  };
}

function updateConfig(values = {}, { actor = 'local' } = {}) {
  if (typeof values.enabled === 'boolean') {
    settingsStore.set(settingsStore.KEYS.FILE_ENABLED, values.enabled ? '1' : '0');
  }
  if (typeof values.localEnabled === 'boolean') {
    settingsStore.set(settingsStore.KEYS.FILE_LOCAL_ENABLED, values.localEnabled ? '1' : '0');
  }
  if (typeof values.localPath === 'string') {
    fileCatalog.assertSafePath(values.localPath);
    settingsStore.set(settingsStore.KEYS.FILE_LOCAL_PATH, values.localPath.trim());
  }
  if (typeof values.smbEnabled === 'boolean') {
    settingsStore.set(settingsStore.KEYS.FILE_SMB_ENABLED, values.smbEnabled ? '1' : '0');
  }
  if (typeof values.smbPath === 'string') {
    fileCatalog.assertSafePath(values.smbPath);
    settingsStore.set(settingsStore.KEYS.FILE_SMB_PATH, values.smbPath.trim());
  }
  if (typeof values.smbUsername === 'string') {
    settingsStore.set(settingsStore.KEYS.FILE_SMB_USERNAME, values.smbUsername.trim());
  }
  if (typeof values.nfsEnabled === 'boolean') {
    settingsStore.set(settingsStore.KEYS.FILE_NFS_ENABLED, values.nfsEnabled ? '1' : '0');
  }
  if (typeof values.nfsPath === 'string') {
    fileCatalog.assertSafePath(values.nfsPath);
    settingsStore.set(settingsStore.KEYS.FILE_NFS_PATH, values.nfsPath.trim());
  }
  fileCatalog.invalidate();
  pluginAudit.record('catalog.file.updated', {
    actor,
    targetType: 'catalog-source',
    targetId: 'file',
    detail: {
      enabled: typeof values.enabled === 'boolean' ? values.enabled : undefined,
      local: typeof values.localEnabled === 'boolean' ? values.localEnabled : undefined,
      smb: typeof values.smbEnabled === 'boolean' ? values.smbEnabled : undefined,
      nfs: typeof values.nfsEnabled === 'boolean' ? values.nfsEnabled : undefined,
    },
  });
  return publicConfig();
}

async function testPath(kind, values = {}, { actor = 'local' } = {}) {
  const config = settingsStore.getFileCatalogConfig();
  const name = String(kind || 'local').toLowerCase();
  const current = config[name] || {};
  const payload = {
    kind: name,
    path: (values.path && String(values.path).trim()) || current.path,
    username: (values.username && String(values.username).trim()) || current.username,
    password: pluginSecrets.readForStore('file_catalog_smb_password') || current.password,
  };
  const result = await fileCatalog.testConnection(payload);
  pluginAudit.record('catalog.file.tested', {
    actor,
    targetType: 'catalog-source',
    targetId: 'file',
    detail: { kind: name, ok: true, modCount: result.modCount || 0 },
  });
  return result;
}

function starterZip() {
  return {
    filename: fileCatalogTemplate.STARTER_FILENAME,
    buffer: fileCatalogTemplate.buildStarterZip(),
  };
}

function forPlugin(plugin) {
  assertOwner(plugin);
  return {
    publicConfig,
    updateConfig,
    testPath,
    starterZip,
    isConfigured: () => fileCatalog.isConfigured(),
  };
}

module.exports = {
  forPlugin,
  publicConfig,
  starterZip,
  testPath,
  updateConfig,
};
