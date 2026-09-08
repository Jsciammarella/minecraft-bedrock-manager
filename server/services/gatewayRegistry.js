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

const ALLOWED_TARGET_KINDS = new Set(['java', 'bedrock']);

function sanitizeName(value, fallback) {
  const text = String(value || fallback || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 80);
  return text || fallback || 'Gateway';
}

function sanitizeNotices(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').replace(/<[^>]*>/g, '').trim().slice(0, 400))
    .filter(Boolean)
    .slice(0, 8);
}

function sanitizeTargetKinds(value) {
  const list = Array.isArray(value) ? value : [];
  const kinds = [];
  for (const item of list) {
    const kind = String(item || '').trim().toLowerCase();
    if (ALLOWED_TARGET_KINDS.has(kind) && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

function sanitizePageId(value) {
  const page = String(value || 'home').trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,62}$/.test(page) ? page : 'home';
}

function sanitizeCreateWizard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = (raw, max) => String(raw || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, max);
  const label = text(value.label, 80);
  if (!label) return null;
  return {
    label,
    description: text(value.description, 400),
    recommendedOptionLabel: text(value.recommendedOptionLabel, 80),
    skipOptionLabel: text(value.skipOptionLabel, 80),
    laterOptionLabel: text(value.laterOptionLabel, 80),
  };
}

function publicMetadata(entry) {
  const meta = entry.provider.getMetadata ? entry.provider.getMetadata() : {};
  const supportsRecommend = Boolean(meta.supportsProspectiveTargetRecommendation)
    && typeof entry.provider.recommendProspectiveTarget === 'function';
  return {
    id: entry.id,
    type: 'gateway',
    name: sanitizeName(meta.name, entry.id),
    pluginId: entry.pluginId,
    managementPluginId: entry.pluginId,
    managementPage: sanitizePageId(meta.managementPage),
    targetKinds: sanitizeTargetKinds(meta.targetKinds),
    supportsCreateForTarget: Boolean(meta.supportsCreateForTarget),
    supportsProspectiveTargetRecommendation: supportsRecommend,
    supportsLanBroadcast: Boolean(meta.supportsLanBroadcast)
      && typeof entry.provider.getLanBroadcastTarget === 'function',
    lanBroadcastLabel: (() => {
      const label = String(meta.lanBroadcastLabel || '')
        .replace(/<[^>]*>/g, '')
        .replace(/[\u0000-\u001f]/g, '')
        .trim()
        .slice(0, 40);
      return label || undefined;
    })(),
    createWizard: sanitizeCreateWizard(meta.createWizard),
    notices: sanitizeNotices(meta.notices),
    downloadHosts: Array.isArray(meta.downloadHosts) ? meta.downloadHosts.map(String) : [],
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

function entries() {
  return [...gateways.values()];
}

function requireGateway(id) {
  const entry = get(id);
  if (!entry) {
    throw Object.assign(new Error(`Gateway provider "${id}" is not installed`), { status: 404 });
  }
  return entry;
}

module.exports = {
  ALLOWED_TARGET_KINDS,
  REQUIRED,
  clear,
  entries,
  get,
  list,
  publicMetadata,
  register,
  requireGateway,
  unregisterPlugins,
};
