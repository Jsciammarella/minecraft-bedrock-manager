const logger = require('./logger');
const pluginAudit = require('./pluginAudit');

const REQUIRED = [
  'getMetadata',
  'listMinecraftVersions',
  'listLoaderVersions',
  'resolveInstallation',
  'planInstallation',
  'planUpdate',
  'getLaunchSpecification',
  'getModSupport',
  'validateMod',
  'getBackupPaths',
  'getHealthInformation',
];

const loaders = new Map();

function publicMetadata(entry) {
  const meta = entry.provider.getMetadata ? entry.provider.getMetadata() : {};
  return {
    id: entry.id,
    type: 'java-loader',
    name: meta.name || entry.id,
    edition: 'java',
    pluginId: entry.pluginId,
    supportsMods: Boolean(meta.supportsMods ?? entry.provider.getModSupport?.()?.supportsMods),
    notices: meta.notices || [],
    downloadHosts: meta.downloadHosts || [],
  };
}

function assertBundled(plugin) {
  if (!plugin || plugin.source !== 'bundled') {
    throw Object.assign(new Error('Only bundled system-provider plugins may register Java loaders'), { status: 403 });
  }
  const caps = plugin.capabilities || [];
  if (!caps.includes('provider:java-loader')) {
    throw Object.assign(new Error('Plugin is not allowed to register a Java loader'), { status: 403 });
  }
}

function wrap(provider) {
  const missing = REQUIRED.filter((name) => typeof provider[name] !== 'function');
  if (missing.length) {
    throw new Error(`Java loader is missing ${missing.join(', ')}`);
  }
  return provider;
}

function register(plugin, provider) {
  assertBundled(plugin);
  const wrapped = wrap(provider);
  const meta = wrapped.getMetadata() || {};
  const id = String(meta.id || provider.id || '').trim();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) {
    throw new Error('Java loader id must be a lowercase slug');
  }
  if (loaders.has(id)) {
    throw new Error(`Java loader "${id}" is already registered`);
  }
  loaders.set(id, {
    id,
    pluginId: plugin.id,
    provider: wrapped,
    downloadHosts: meta.downloadHosts || [],
  });
  pluginAudit.record('provider.register', {
    targetType: 'java-loader',
    targetId: id,
    detail: { pluginId: plugin.id },
  });
  logger.info(`Registered Java loader ${id} from plugin ${plugin.id}`);
  return publicMetadata(loaders.get(id));
}

function unregisterPlugins(pluginIds) {
  const ids = new Set(pluginIds || []);
  for (const [id, entry] of [...loaders.entries()]) {
    if (ids.has(entry.pluginId)) {
      loaders.delete(id);
      pluginAudit.record('provider.unregister', { targetType: 'java-loader', targetId: id });
    }
  }
}

function clear() {
  loaders.clear();
}

function get(id) {
  return loaders.get(String(id || '')) || null;
}

function list() {
  return [...loaders.values()].map(publicMetadata);
}

function requireLoader(id) {
  const entry = get(id);
  if (!entry) {
    throw Object.assign(new Error(`Java loader "${id}" is not installed`), { status: 404 });
  }
  return entry;
}

function repairPersistedRecords(options) {
  const summaries = [];
  for (const entry of loaders.values()) {
    if (typeof entry.provider.repairPersistedRecords !== 'function') continue;
    summaries.push({
      loader: entry.id,
      result: entry.provider.repairPersistedRecords(options),
    });
  }
  return summaries;
}

module.exports = {
  REQUIRED,
  clear,
  get,
  list,
  publicMetadata,
  register,
  repairPersistedRecords,
  requireLoader,
  unregisterPlugins,
};
