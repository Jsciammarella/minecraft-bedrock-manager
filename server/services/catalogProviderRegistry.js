const logger = require('./logger');
const pluginAudit = require('./pluginAudit');
const {
  ALLOWED_CATALOG_EDITIONS,
  availableEditionsFromProviders,
  validateProviderEditions,
} = require('./catalogEditions');

const REQUIRED = [
  'getMetadata',
  'isAvailable',
  'getCategories',
  'search',
  'getDetails',
  'listDownloadFiles',
  'download',
];

const providers = new Map();

function publicMetadata(entry) {
  const meta = entry.provider.getMetadata ? entry.provider.getMetadata() : {};
  return {
    id: entry.id,
    type: 'catalog-source',
    name: meta.name || entry.id,
    source: meta.source || entry.id,
    editions: [...(entry.editions || [])],
    credentialProfile: meta.credentialProfile || null,
    homepage: meta.homepage || '',
    pluginId: entry.pluginId,
    core: Boolean(entry.core),
    notices: meta.notices || [],
  };
}

function assertBundled(plugin) {
  if (!plugin || plugin.source !== 'bundled') {
    throw Object.assign(new Error('Only bundled system-provider plugins may register catalog sources'), { status: 403 });
  }
  if (!(plugin.capabilities || []).includes('provider:catalog-source')) {
    throw Object.assign(new Error('Plugin is not allowed to register a catalog source'), { status: 403 });
  }
}

function wrap(provider) {
  const missing = REQUIRED.filter((name) => typeof provider[name] !== 'function');
  if (missing.length) {
    throw new Error(`Catalog provider is missing ${missing.join(', ')}`);
  }
  return provider;
}

function register(plugin, provider, { core = false } = {}) {
  if (!core) assertBundled(plugin);
  const wrapped = wrap(provider);
  const meta = wrapped.getMetadata() || {};
  const id = String(meta.id || provider.id || '').trim();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) {
    throw new Error('Catalog provider id must be a lowercase slug');
  }
  const editions = validateProviderEditions(meta);
  if (providers.has(id)) {
    throw new Error(`Catalog provider "${id}" is already registered`);
  }
  providers.set(id, {
    id,
    pluginId: plugin.id,
    core: Boolean(core),
    provider: wrapped,
    editions,
    downloadHosts: meta.downloadHosts || [],
  });
  pluginAudit.record('provider.register', {
    targetType: 'catalog-source',
    targetId: id,
    detail: { pluginId: plugin.id, core: Boolean(core), editions },
  });
  logger.info(`Registered catalog source ${id} from ${core ? 'core' : `plugin ${plugin.id}`}`);
  return publicMetadata(providers.get(id));
}

function unregisterPlugins(pluginIds) {
  const ids = new Set(pluginIds || []);
  const removed = [];
  for (const [id, entry] of [...providers.entries()]) {
    if (entry.core) continue;
    if (ids.has(entry.pluginId)) {
      removed.push(id);
      providers.delete(id);
      pluginAudit.record('provider.unregister', { targetType: 'catalog-source', targetId: id });
    }
  }
  try {
    require('./catalogDownloadPolicy').clearCacheForProviders(removed);
  } catch { /* ignore */ }
}

function clear() {
  providers.clear();
  try {
    require('./catalogDownloadPolicy').clearAvailabilityCache();
  } catch { /* ignore */ }
}

function get(id) {
  return providers.get(String(id || '')) || null;
}

function entries() {
  return [...providers.values()];
}

function list() {
  return entries().map(publicMetadata);
}

function availableEditions() {
  return availableEditionsFromProviders(list());
}

function requireProvider(id) {
  const entry = get(id);
  if (!entry) {
    throw Object.assign(new Error(`Catalog source "${id}" is not installed`), { status: 404 });
  }
  return entry;
}

module.exports = {
  ALLOWED_CATALOG_EDITIONS,
  REQUIRED,
  availableEditions,
  clear,
  entries,
  get,
  list,
  publicMetadata,
  register,
  requireProvider,
  unregisterPlugins,
};
