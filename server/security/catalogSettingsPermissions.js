const PLUGIN_ACTIONS = {
  'catalog-curseforge': {
    view: 'catalog.set_curseforge_key',
    save: 'catalog.set_curseforge_key',
    'test-connection': 'catalog.set_curseforge_key',
  },
  'catalog-git': {
    view: 'catalog.enable_git',
    save: 'catalog.enable_git',
    'test-connection': 'catalog.enable_git',
    'sync-now': 'catalog.enable_git',
    'download-template': 'catalog.download_mods',
  },
  'catalog-file': {
    view: 'catalog.enable_file',
    save: 'catalog.enable_file',
    'test-local-path': 'catalog.enable_file',
    'test-smb-path': 'catalog.enable_file',
    'test-nfs-path': 'catalog.enable_file',
    'download-template': 'catalog.download_mods',
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
