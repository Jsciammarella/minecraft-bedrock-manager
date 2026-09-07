const connectHost = require('./connectHost');

const TAG_STYLES = new Set(['info', 'success', 'warning', 'danger', 'muted']);
const INDICATOR_STATES = new Set(['online', 'offline', 'starting', 'degraded', 'failed', 'plugin_disabled']);
const ACTION_PLACEMENTS = new Set(['primary-split', 'secondary']);
const ACTION_VARIANTS = new Set(['primary', 'secondary', 'danger', 'warning']);
const ACTION_STATES = new Set(['enabled', 'disabled']);
const ACTION_ICONS = new Set(['none', 'play', 'stop']);
const CONTROL_POLICIES = new Set(['normal', 'remote-plugin-lifecycle', 'plugin-disabled']);
const SUMMARY_KEYS = new Set([
  'mode', 'status', 'bedrockAddress', 'bedrockPort', 'viaProxyStatus', 'floodgateStatus', 'lastError',
  'compatibilityWarning',
]);
const MAX_TAGS = 6;
const MAX_INDICATORS = 4;
const MAX_ACTIONS = 4;
const MAX_LABEL = 48;
const MAX_SUMMARY_FIELDS = 8;

const diagnostics = [];

function recordDiagnostic(entry) {
  diagnostics.push({
    at: new Date().toISOString(),
    pluginId: entry.pluginId || '',
    serverId: entry.serverId || null,
    reason: String(entry.reason || 'invalid').slice(0, 200),
  });
  if (diagnostics.length > 80) diagnostics.splice(0, diagnostics.length - 80);
}

function lastDiagnostics() {
  return diagnostics.slice(-20);
}

function clearDiagnostics() {
  diagnostics.length = 0;
}

function stripText(value, max = MAX_LABEL) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/https?:\/\//gi, '')
    .replace(/javascript:/gi, '')
    .replace(/data:/gi, '')
    .trim()
    .slice(0, max);
}

function slug(value, max = 40) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, max);
}

function sanitizeTags(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_TAGS) break;
    const id = slug(item?.id, 32);
    const label = stripText(item?.label, MAX_LABEL);
    if (!id || !label || seen.has(id)) continue;
    if (/[<>]|[{}`]|on\w+=/i.test(String(item?.label || ''))) continue;
    const style = TAG_STYLES.has(item?.style) ? item.style : 'info';
    seen.add(id);
    out.push({ id, label, style });
  }
  return out;
}

function sanitizeIndicators(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_INDICATORS) break;
    const id = slug(item?.id, 32);
    const label = stripText(item?.label, MAX_LABEL);
    const state = INDICATOR_STATES.has(item?.state) ? item.state : null;
    if (!id || !label || !state || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, state });
  }
  return out;
}

function sanitizeActions(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_ACTIONS) break;
    const id = slug(item?.id, 40);
    const label = stripText(item?.label, MAX_LABEL);
    const placement = ACTION_PLACEMENTS.has(item?.placement) ? item.placement : null;
    const variant = ACTION_VARIANTS.has(item?.variant) ? item.variant : 'secondary';
    const state = ACTION_STATES.has(item?.state) ? item.state : 'disabled';
    const icon = ACTION_ICONS.has(item?.icon) ? item.icon : 'none';
    if (!id || !label || !placement || seen.has(id)) continue;
    if (item?.url || item?.href || item?.command || item?.endpoint || item?.onClick) continue;
    seen.add(id);
    out.push({
      id,
      label,
      placement,
      variant,
      state,
      icon,
      confirmation: Boolean(item?.confirmation),
      disabledReason: stripText(item?.disabledReason, 160),
    });
  }
  return out;
}

function sanitizeSummary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out = [];
  for (const [key, value] of Object.entries(raw)) {
    if (out.length >= MAX_SUMMARY_FIELDS) break;
    if (!SUMMARY_KEYS.has(key)) continue;
    const valueText = stripText(value, key === 'lastError' || key === 'compatibilityWarning' ? 400 : 120);
    if (!valueText) continue;
    const label = key === 'mode' ? 'Mode'
      : key === 'status' ? 'Status'
        : key === 'bedrockAddress' ? 'Bedrock address'
          : key === 'bedrockPort' ? 'Bedrock UDP port'
            : key === 'viaProxyStatus' ? 'ViaProxy'
              : key === 'floodgateStatus' ? 'Floodgate'
                : key === 'compatibilityWarning' ? 'Compatibility'
                  : 'Last error';
    out.push({
      id: key,
      label,
      value: valueText,
    });
  }
  return out;
}

function sanitizeManagement(raw, pluginId, resourceId) {
  const page = slug(raw?.pluginPage || pluginId, 80);
  if (!page || page !== slug(pluginId, 80)) return null;
  const id = String(resourceId || raw?.resourceId || '').replace(/[^a-z0-9:_-]/gi, '').slice(0, 40);
  if (!id) return null;
  return {
    label: stripText(raw?.label || 'Manage plugin', MAX_LABEL),
    pluginPage: page,
    resourceId: id,
    href: `/plugins/${page}?gatewayId=${encodeURIComponent(id)}`,
  };
}

function sanitizeContribution(raw, ctx = {}) {
  const pluginId = slug(raw?.pluginId || ctx.pluginId, 80);
  const serverId = ctx.serverId == null ? null : Number(ctx.serverId);
  const attachmentId = stripText(raw?.attachmentId || ctx.attachmentId, 64);
  if (!pluginId || !attachmentId) {
    recordDiagnostic({ pluginId, serverId, reason: 'missing plugin or attachment id' });
    return null;
  }
  if (serverId != null && raw?.serverId != null && Number(raw.serverId) !== serverId) {
    recordDiagnostic({ pluginId, serverId, reason: 'contribution server id mismatch' });
    return null;
  }
  if (raw?.html || raw?.jsx || raw?.component || raw?.css || raw?.javascript || raw?.script) {
    recordDiagnostic({ pluginId, serverId, reason: 'executable ui rejected' });
    return null;
  }
  const controlPolicy = CONTROL_POLICIES.has(raw?.controlPolicy) ? raw.controlPolicy : (ctx.controlPolicy || 'normal');
  const tags = sanitizeTags(raw?.tags);
  const indicators = sanitizeIndicators(raw?.indicators);
  const actions = sanitizeActions(raw?.actions);
  const summary = sanitizeSummary(raw?.summary);
  const management = sanitizeManagement(raw?.management, pluginId, ctx.resourceId);
  if (!tags.length && !indicators.length && !actions.length && !summary.length) {
    recordDiagnostic({ pluginId, serverId, reason: 'empty contribution discarded' });
    return null;
  }
  return {
    pluginId,
    serverId,
    attachmentId,
    revision: Number(raw?.revision) > 0 ? Math.floor(Number(raw.revision)) : Date.now(),
    primary: Boolean(ctx.primary),
    controlPolicy,
    tags,
    indicators,
    actions,
    summary,
    management,
  };
}

function disabledContribution(att, extra = {}) {
  const tags = Array.isArray(extra.tags) && extra.tags.length
    ? extra.tags
    : [{ id: 'plugin-disabled', label: 'Plugin disabled', style: 'warning' }];
  return {
    pluginId: att.plugin_id,
    serverId: att.server_id,
    attachmentId: `${att.resource_type}:${att.resource_id}`,
    revision: Date.now(),
    tags,
    indicators: [{
      id: `${att.resource_type}-status`,
      label: extra.indicatorLabel || 'Plugin Disabled',
      state: 'plugin_disabled',
    }],
    actions: [],
    summary: extra.summary || [],
    management: {
      label: 'Open Plugins',
      pluginPage: att.plugin_id,
      resourceId: att.resource_id,
    },
    controlPolicy: 'plugin-disabled',
  };
}

function persistDisplay(att, contribution) {
  if (!att?.id || !contribution) return;
  const payload = {
    tags: contribution.tags,
    indicators: contribution.indicators.map((item) => (
      item.state === 'plugin_disabled' ? item : { id: item.id, label: item.label, state: 'offline' }
    )),
    summary: contribution.summary.filter((item) => item.id !== 'lastError' || item.value),
  };
  require('./serverPluginAttachments').setDisplay(att.id, payload);
}

function collectForAttachment(att, { javaServer = null, pluginDisabled = false, controlPolicy = 'normal' } = {}) {
  if (!att) return null;
  const pluginHost = require('./pluginHost');
  const gatewayRegistry = require('./gatewayRegistry');
  const plugin = pluginHost.getPlugin(att.plugin_id);
  const disabled = pluginDisabled || !plugin || !plugin.enabled;
  const stored = att.display_json ? (() => {
    try { return JSON.parse(att.display_json); } catch { return {}; }
  })() : {};
  let raw;
  if (disabled) {
    raw = disabledContribution(att, {
      tags: stored.tags,
      indicatorLabel: stored.disabledIndicator || 'Geyser Plugin Disabled',
      summary: stored.summary,
    });
  } else {
    const entry = gatewayRegistry.get(att.provider_id);
    if (typeof entry?.provider.getServerContribution !== 'function') {
      recordDiagnostic({ pluginId: att.plugin_id, serverId: att.server_id, reason: 'provider has no contribution' });
      return null;
    }
    try {
      raw = entry.provider.getServerContribution({
        attachment: att,
        javaServer,
        pluginDisabled: false,
      });
    } catch (err) {
      recordDiagnostic({ pluginId: att.plugin_id, serverId: att.server_id, reason: String(err.message || err).slice(0, 200) });
      return null;
    }
  }
  const sanitized = sanitizeContribution(raw, {
    pluginId: att.plugin_id,
    serverId: att.server_id,
    attachmentId: `${att.resource_type}:${att.resource_id}`,
    resourceId: att.resource_id,
    primary: Boolean(att.primary_attachment),
    controlPolicy,
  });
  if (sanitized && !disabled) persistDisplay(att, sanitized);
  if (sanitized && disabled) {
    sanitized.management = {
      label: 'Open Plugins',
      pluginPage: att.plugin_id,
      resourceId: att.resource_id,
      href: '/plugins',
    };
    sanitized.actions = [];
  }
  return sanitized;
}

function listForServer(server) {
  if (!server?.id) return [];
  if (!require('./javaHostingPolicy').isJavaHostingAvailable()) return [];
  const attachments = require('./serverPluginAttachments').listForServer(server.id);
  const out = [];
  for (const att of attachments) {
    if (!att.primary_attachment) continue;
    const contribution = collectForAttachment(att, { javaServer: server, controlPolicy: 'normal' });
    if (contribution) out.push(contribution);
  }
  return out;
}

function attachToServer(server) {
  if (!server) return server;
  return {
    ...server,
    pluginContributions: listForServer(server),
  };
}

function projectedContribution(row, entity) {
  const attachments = require('./serverPluginAttachments');
  const att = attachments.findByResource(entity.pluginId || 'gateway-geyser', 'gateway', String(row.id));
  const pluginHost = require('./pluginHost');
  const plugin = pluginHost.getPlugin(entity.pluginId);
  const disabled = Boolean(entity.pluginDisabled || !plugin || !plugin.enabled);
  if (att) {
    return collectForAttachment(att, {
      javaServer: null,
      pluginDisabled: disabled,
      controlPolicy: disabled ? 'plugin-disabled' : 'remote-plugin-lifecycle',
    });
  }
  const gatewayRegistry = require('./gatewayRegistry');
  const entry = gatewayRegistry.get(row.provider_id);
  let raw = null;
  if (!disabled && typeof entry?.provider.getServerContribution === 'function') {
    try {
      raw = entry.provider.getServerContribution({
        attachment: {
          plugin_id: entity.pluginId,
          provider_id: row.provider_id,
          server_id: null,
          resource_type: 'gateway',
          resource_id: String(row.id),
          primary_attachment: 1,
        },
        javaServer: null,
        pluginDisabled: false,
      });
    } catch { raw = null; }
  }
  if (disabled) {
    raw = {
      pluginId: entity.pluginId,
      attachmentId: `gateway:${row.id}`,
      tags: entity.tags || [{ id: 'plugin-disabled', label: 'Plugin disabled', style: 'warning' }],
      indicators: [{ id: 'geyser-status', label: 'Geyser Plugin Disabled', state: 'plugin_disabled' }],
      actions: [],
      management: { label: 'Open Plugins', pluginPage: entity.pluginId, resourceId: String(row.id) },
      controlPolicy: 'plugin-disabled',
    };
  }
  const sanitized = sanitizeContribution(raw, {
    pluginId: entity.pluginId,
    serverId: null,
    attachmentId: `gateway:${row.id}`,
    resourceId: String(row.id),
    primary: true,
    controlPolicy: disabled ? 'plugin-disabled' : 'remote-plugin-lifecycle',
  });
  if (sanitized && disabled) {
    sanitized.management = {
      label: 'Open Plugins',
      pluginPage: entity.pluginId,
      resourceId: String(row.id),
      href: '/plugins',
    };
    sanitized.actions = [];
  }
  return sanitized;
}

function managementHref(contribution) {
  if (!contribution?.management) return '/plugins';
  if (contribution.controlPolicy === 'plugin-disabled') return '/plugins';
  return contribution.management.href;
}

function advertisedAddressHint() {
  return connectHost.resolve();
}

function persistEnabledContributions(pluginId) {
  const attachments = require('./serverPluginAttachments').listAllForPlugin(pluginId);
  for (const att of attachments) {
    if (!att.primary_attachment) continue;
    collectForAttachment(att, { javaServer: { id: att.server_id, status: 'unknown' } });
  }
}

module.exports = {
  ACTION_ICONS,
  ACTION_PLACEMENTS,
  ACTION_VARIANTS,
  CONTROL_POLICIES,
  INDICATOR_STATES,
  TAG_STYLES,
  advertisedAddressHint,
  attachToServer,
  clearDiagnostics,
  collectForAttachment,
  lastDiagnostics,
  listForServer,
  managementHref,
  persistEnabledContributions,
  projectedContribution,
  sanitizeContribution,
  stripText,
};
