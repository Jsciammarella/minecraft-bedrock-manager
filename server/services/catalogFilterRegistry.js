const logger = require('./logger');
const pluginAudit = require('./pluginAudit');

const REQUIRED = [
  'getMetadata',
  'isAvailable',
  'listOptions',
  'resolveSelection',
];

const filters = new Map();

function publicDescriptor(entry, context = {}, { includeOptions = false } = {}) {
  const meta = entry.provider.getMetadata ? entry.provider.getMetadata() : {};
  const available = typeof entry.provider.isAvailable === 'function'
    ? Boolean(entry.provider.isAvailable(context))
    : true;
  const descriptor = {
    id: entry.id,
    label: meta.label || entry.id,
    type: meta.type || 'multi-select',
    editions: [...(meta.editions || ['java'])],
    emptyLabel: meta.emptyLabel || 'All',
    pluginId: entry.pluginId,
    available,
    notices: available ? (meta.notices || []) : [
      ...(meta.notices || []),
      meta.unavailableNotice || 'This filter is currently unavailable.',
    ],
  };
  if (includeOptions) {
    descriptor.options = available && typeof entry.provider.listOptions === 'function'
      ? (entry.provider.listOptions(context) || [])
      : [];
  }
  return descriptor;
}

function assertBundled(plugin) {
  if (!plugin || plugin.source !== 'bundled') {
    throw Object.assign(new Error('Only bundled system-provider plugins may register catalog filters'), { status: 403 });
  }
  if (!(plugin.capabilities || []).includes('provider:catalog-filter')) {
    throw Object.assign(new Error('Plugin is not allowed to register a catalog filter'), { status: 403 });
  }
}

function wrap(provider) {
  const missing = REQUIRED.filter((name) => typeof provider[name] !== 'function');
  if (missing.length) {
    throw new Error(`Catalog filter provider is missing ${missing.join(', ')}`);
  }
  return provider;
}

function register(plugin, provider) {
  assertBundled(plugin);
  const wrapped = wrap(provider);
  const meta = wrapped.getMetadata() || {};
  const id = String(meta.id || provider.id || '').trim();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) {
    throw new Error('Catalog filter id must be a lowercase slug');
  }
  if (filters.has(id)) {
    const existing = filters.get(id);
    if (existing.pluginId !== plugin.id) {
      throw new Error(`Catalog filter "${id}" is already registered`);
    }
    filters.set(id, { id, pluginId: plugin.id, provider: wrapped });
    return publicDescriptor(filters.get(id));
  }
  filters.set(id, { id, pluginId: plugin.id, provider: wrapped });
  pluginAudit.record('provider.register', {
    targetType: 'catalog-filter',
    targetId: id,
    detail: { pluginId: plugin.id },
  });
  logger.info(`Registered catalog filter ${id} from plugin ${plugin.id}`);
  return publicDescriptor(filters.get(id));
}

function unregister(plugin, filterId) {
  const id = String(filterId || '').trim();
  const entry = filters.get(id);
  if (!entry) return false;
  if (!plugin || entry.pluginId !== plugin.id) {
    throw Object.assign(new Error('Plugins can only unregister their own catalog filters'), { status: 403 });
  }
  filters.delete(id);
  pluginAudit.record('provider.unregister', {
    targetType: 'catalog-filter',
    targetId: id,
    detail: { pluginId: plugin.id },
  });
  logger.info(`Unregistered catalog filter ${id} from plugin ${plugin.id}`);
  return true;
}

function unregisterPlugins(pluginIds) {
  const ids = new Set(pluginIds || []);
  for (const [id, entry] of [...filters.entries()]) {
    if (ids.has(entry.pluginId)) {
      filters.delete(id);
      pluginAudit.record('provider.unregister', { targetType: 'catalog-filter', targetId: id });
    }
  }
  try {
    require('./catalogDownloadPolicy').clearAvailabilityCache();
  } catch { /* ignore */ }
}

function clear() {
  filters.clear();
}

function get(id) {
  return filters.get(String(id || '')) || null;
}

function list(context = {}, { includeOptions = false } = {}) {
  return [...filters.values()].map((entry) => publicDescriptor(entry, context, { includeOptions }));
}

function staleFilterError(id) {
  const err = new Error('That catalog filter is not available.');
  err.status = 409;
  err.code = 'CATALOG_FILTER_UNAVAILABLE';
  err.filterId = id || null;
  return err;
}

function parseSubmitted(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      const err = new Error('Catalog filter selection is invalid.');
      err.status = 400;
      err.code = 'CATALOG_FILTER_INVALID';
      throw err;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  const err = new Error('Catalog filter selection is invalid.');
  err.status = 400;
  err.code = 'CATALOG_FILTER_INVALID';
  throw err;
}

function resolveSelection(submitted, context = {}) {
  const raw = parseSubmitted(submitted);
  const keys = Object.keys(raw).filter((key) => {
    const value = raw[key];
    if (value == null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim() !== '';
    return true;
  });
  const resolved = {};
  let compatibilityTargets = [];
  for (const id of keys) {
    const entry = get(id);
    if (!entry || !entry.provider.isAvailable(context)) throw staleFilterError(id);
    const values = Array.isArray(raw[id]) ? raw[id] : [raw[id]];
    const targets = entry.provider.resolveSelection(values.map(String), context) || [];
    resolved[id] = targets;
    compatibilityTargets = compatibilityTargets.concat(targets);
  }
  return {
    filters: resolved,
    compatibilityTargets,
  };
}

module.exports = {
  REQUIRED,
  clear,
  get,
  list,
  publicDescriptor,
  register,
  resolveSelection,
  staleFilterError,
  unregister,
  unregisterPlugins,
};
