const PLUGIN_ACTIONS = {
  'catalog-curseforge': {
    view: 'catalog.curseforge.configure',
    save: 'catalog.curseforge.configure',
    'test-connection': 'catalog.curseforge.configure',
  },
  'catalog-git': {
    view: 'catalog.git.configure',
    save: 'catalog.git.configure',
    'test-connection': 'catalog.git.configure',
    'sync-now': 'catalog.git.sync',
    'download-template': 'catalog.download_to_library',
  },
  'catalog-file': {
    view: 'catalog.file.configure',
    save: 'catalog.file.configure',
    'test-local-path': 'catalog.file.configure',
    'test-smb-path': 'catalog.file.configure',
    'test-nfs-path': 'catalog.file.configure',
    'download-template': 'catalog.download_to_library',
  },
};

function permissionFor(pluginId, actionId) {
  const table = PLUGIN_ACTIONS[String(pluginId || '')];
  if (!table) return null;
  const id = String(actionId || '').trim();
  if (table[id]) return table[id];
  if (id === 'clear' || id === 'replace' || id.includes('secret')) {
    return table.save || null;
  }
  return null;
}

module.exports = {
  PLUGIN_ACTIONS,
  permissionFor,
};
