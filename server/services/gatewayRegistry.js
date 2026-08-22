const logger = require('./logger');
const pluginAudit = require('./pluginAudit');

const REQUIRED = [
  'getMetadata',
  'planInstallation',
  'planUpdate',
  'getLaunchSpecification',
  'getDefaultConfig',
  'sanitizePublicRecord',
];

const gateways = new Map();

function publicMetadata(entry) {
  const meta = entry.provider.getMetadata() || {};
  return {
    id: entry.id,
    type: 'gateway',
    name: meta.name || entry.id,
    pluginId: entry.pluginId,
    notices: meta.notices || [],
    downloadHosts: meta.downloadHosts || [],
    recommended: Boolean(meta.recommended),
  };
}

function assertBundled(plugin) {
  if (!plugin || plugin.source !== 'bundled') {
    throw Object.assign(new Error('Only bundled system-provider plugins may register gateways'), { status: 403 });
  }
  if (!(plugin.capabilities || []).includes('provider:gateway')) {
    throw Object.assign(new Error('Plugin is not allowed to register a gateway'), { status: 403 });
  }
}

function register(plugin, provider) {
  assertBundled(plugin);
  const missing = REQUIRED.filter((name) => typeof provider[name] !== 'function');
  if (missing.length) {
    throw new Error(`Gateway provider is missing ${missing.join(', ')}`);
  }
  const meta = provider.getMetadata() || {};
  const id = String(meta.id || provider.id || '').trim();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) {
    throw new Error('Gateway id must be a lowercase slug');
  }
  if (gateways.has(id)) {
    throw new Error(`Gateway "${id}" is already registered`);
  }
  gateways.set(id, {
    id,
    pluginId: plugin.id,
    provider,
    downloadHosts: meta.downloadHosts || [],
  });
  pluginAudit.record('provider.register', {
    targetType: 'gateway',
    targetId: id,
    detail: { pluginId: plugin.id },
  });
  logger.info(`Registered gateway ${id} from plugin ${plugin.id}`);
  return publicMetadata(gateways.get(id));
}

function unregisterPlugins(pluginIds) {
  const ids = new Set(pluginIds || []);
  for (const [id, entry] of [...gateways.entries()]) {
    if (ids.has(entry.pluginId)) {
      gateways.delete(id);
      pluginAudit.record('provider.unregister', { targetType: 'gateway', targetId: id });
    }
  }
}

function clear() {
  gateways.clear();
}

function get(id) {
  return gateways.get(String(id || '')) || null;
}

function list() {
  return [...gateways.values()].map(publicMetadata);
}

function requireGateway(id) {
  const entry = get(id);
  if (!entry) {
    throw Object.assign(new Error(`Gateway provider "${id}" is not installed`), { status: 404 });
  }
  return entry;
}

module.exports = {
  REQUIRED,
  clear,
  get,
  list,
  publicMetadata,
  register,
  requireGateway,
  unregisterPlugins,
};
