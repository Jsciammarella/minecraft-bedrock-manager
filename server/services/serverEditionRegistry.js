const logger = require('./logger');
const pluginAudit = require('./pluginAudit');

const CORE_EDITIONS = Object.freeze([
  {
    id: 'bedrock',
    label: 'Bedrock',
    available: true,
    core: true,
  },
]);

const providers = new Map();

function stripLabel(value, fallback) {
  const text = String(value || fallback || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 40);
  return text || fallback || 'Edition';
}

function publicMetadata(entry, { available = true } = {}) {
  return {
    id: entry.id,
    label: stripLabel(entry.label, entry.id),
    available: Boolean(available),
    core: false,
    pluginId: entry.pluginId,
  };
}

function assertBundled(plugin) {
  if (!plugin || plugin.source !== 'bundled') {
    throw Object.assign(new Error('Only bundled system-provider plugins may register server editions'), { status: 403 });
  }
  if (!(plugin.capabilities || []).includes('provider:server-edition')) {
    throw Object.assign(new Error('Plugin is not allowed to register a server edition'), { status: 403 });
  }
}

function register(plugin, provider) {
  assertBundled(plugin);
  const meta = (provider && typeof provider.getMetadata === 'function' ? provider.getMetadata() : provider) || {};
  const id = String(meta.id || provider?.id || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) {
    throw new Error('Server edition id must be a lowercase slug');
  }
  if (id === 'bedrock' || id === 'remote') {
    throw new Error(`Server edition "${id}" is reserved for core`);
  }
  if (providers.has(id)) {
    throw new Error(`Server edition "${id}" is already registered`);
  }
  providers.set(id, {
    id,
    label: stripLabel(meta.label || meta.name, id),
    pluginId: plugin.id,
    provider: provider || meta,
  });
  pluginAudit.record('provider.register', {
    targetType: 'server-edition',
    targetId: id,
    detail: { pluginId: plugin.id },
  });
  logger.info(`Registered server edition ${id} from plugin ${plugin.id}`);
  return publicMetadata(providers.get(id));
}

function unregisterPlugins(pluginIds) {
  const ids = new Set(pluginIds || []);
  for (const [id, entry] of [...providers.entries()]) {
    if (ids.has(entry.pluginId)) {
      providers.delete(id);
      pluginAudit.record('provider.unregister', { targetType: 'server-edition', targetId: id });
    }
  }
}

function clear() {
  providers.clear();
}

function get(id) {
  return providers.get(String(id || '').trim().toLowerCase()) || null;
}

function listRegistered() {
  return [...providers.values()].map((entry) => publicMetadata(entry));
}

module.exports = {
  CORE_EDITIONS,
  clear,
  get,
  listRegistered,
  publicMetadata,
  register,
  unregisterPlugins,
};
