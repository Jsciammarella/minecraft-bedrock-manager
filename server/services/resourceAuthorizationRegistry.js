const logger = require('./logger');
const pluginAudit = require('./pluginAudit');

const REQUIRED = [
  'authorize',
  'getEffectivePermissions',
  'listAssignablePermissions',
  'getDisableImpact',
];

const providers = new Map();

function assertBundled(plugin) {
  if (!plugin || plugin.source !== 'bundled') {
    throw Object.assign(new Error('Only bundled first-party plugins may register a resource-authorization provider'), { status: 403 });
  }
  if (!(plugin.capabilities || []).includes('provider:resource-authorization')) {
    throw Object.assign(new Error('Plugin is not allowed to register a resource-authorization provider'), { status: 403 });
  }
}

function wrap(provider) {
  const missing = REQUIRED.filter((name) => typeof provider[name] !== 'function');
  if (missing.length) {
    throw new Error(`Resource authorization provider is missing ${missing.join(', ')}`);
  }
  return provider;
}

function publicMetadata(entry) {
  return {
    id: entry.id,
    resourceType: entry.resourceType,
    pluginId: entry.pluginId,
    available: true,
  };
}

function register(plugin, provider) {
  assertBundled(plugin);
  const wrapped = wrap(provider);
  const id = String(provider.id || plugin.id || '').trim();
  const resourceType = String(provider.resourceType || '').trim();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) {
    throw new Error('Resource authorization provider id must be a lowercase slug');
  }
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(resourceType)) {
    throw new Error('Resource type must be a lowercase identifier');
  }
  const existing = providers.get(resourceType);
  if (existing && existing.pluginId !== plugin.id) {
    throw new Error(`A resource-authorization provider for "${resourceType}" is already registered`);
  }
  const entry = {
    id,
    resourceType,
    pluginId: plugin.id,
    provider: wrapped,
  };
  providers.set(resourceType, entry);
  try {
    require('./resourceAuthorizationState').markActive(resourceType, id, plugin.id);
  } catch (err) {
    logger.warn(`Could not persist resource-authorization expectation: ${err.message}`);
  }
  pluginAudit.record('provider.register', {
    targetType: 'resource-authorization',
    targetId: id,
    detail: { pluginId: plugin.id, resourceType },
  });
  logger.info(`Registered resource-authorization provider ${id} for ${resourceType} from plugin ${plugin.id}`);
  return publicMetadata(entry);
}

function unregister(plugin, resourceType) {
  const type = String(resourceType || '').trim();
  const entry = providers.get(type);
  if (!entry) return false;
  if (!plugin || entry.pluginId !== plugin.id) {
    throw Object.assign(new Error('Plugins can only unregister their own resource-authorization providers'), { status: 403 });
  }
  providers.delete(type);
  pluginAudit.record('provider.unregister', {
    targetType: 'resource-authorization',
    targetId: entry.id,
    detail: { pluginId: plugin.id, resourceType: type },
  });
  logger.info(`Unregistered resource-authorization provider ${entry.id} for ${type}`);
  return true;
}

function unregisterPlugins(pluginIds) {
  const ids = new Set(pluginIds || []);
  const removed = [];
  for (const [type, entry] of [...providers.entries()]) {
    if (ids.has(entry.pluginId)) {
      providers.delete(type);
      removed.push(entry);
    }
  }
  return removed;
}

function get(resourceType) {
  const entry = providers.get(String(resourceType || '').trim());
  return entry ? entry.provider : null;
}

function getEntry(resourceType) {
  return providers.get(String(resourceType || '').trim()) || null;
}

function list() {
  return [...providers.values()].map(publicMetadata);
}

function available(resourceType) {
  return Boolean(get(resourceType));
}

function getDisableImpactForPlugin(pluginId) {
  const impacts = [];
  for (const entry of providers.values()) {
    if (entry.pluginId !== pluginId) continue;
    try {
      impacts.push(entry.provider.getDisableImpact() || { required: true });
    } catch (err) {
      impacts.push({ required: true, error: err.message });
    }
  }
  if (!impacts.length) return { required: false, pluginId };
  const merged = impacts.reduce((acc, item) => ({
    required: true,
    configuredServers: (acc.configuredServers || 0) + Number(item.configuredServers || 0),
    serverGroups: (acc.serverGroups || 0) + Number(item.serverGroups || 0),
    assignedUsers: (acc.assignedUsers || 0) + Number(item.assignedUsers || 0),
    allowAssignments: (acc.allowAssignments || 0) + Number(item.allowAssignments || 0),
    denyAssignments: (acc.denyAssignments || 0) + Number(item.denyAssignments || 0),
    restrictedServers: (acc.restrictedServers || 0) + Number(item.restrictedServers || 0),
  }), { required: true, pluginId });
  merged.message = 'Disabling this plugin returns affected servers to global permission rules and can broaden access.';
  return merged;
}

function confirmError(impact) {
  const err = new Error(impact?.message || 'Confirm disabling resource-authorization before continuing.');
  err.status = 409;
  err.code = 'RESOURCE_AUTHORIZATION_DISABLE_CONFIRM';
  err.impact = impact;
  return err;
}

function suspendProvidersForPlugin(pluginId) {
  for (const entry of providers.values()) {
    if (entry.pluginId !== pluginId) continue;
    try {
      require('./resourceAuthorizationState').markSuspended(entry.resourceType);
    } catch (err) {
      logger.warn(`Could not suspend resource-authorization expectation: ${err.message}`);
    }
  }
}

function resetForTests() {
  providers.clear();
}

module.exports = {
  register,
  unregister,
  unregisterPlugins,
  get,
  getEntry,
  list,
  available,
  getDisableImpactForPlugin,
  confirmError,
  suspendProvidersForPlugin,
  resetForTests,
};
