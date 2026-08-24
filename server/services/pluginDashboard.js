const db = require('../db/connection');
const gatewayRegistry = require('./gatewayRegistry');
const connectHost = require('./connectHost');

const KINDS = new Set(['geyser_gateway']);
const STATUSES = new Set([
  'stopped', 'starting', 'running', 'degraded', 'plugin_disabled',
  'target_unreachable', 'protocol_incompatible', 'auth_misconfigured',
  'port_conflict', 'failed',
]);
const MODES = new Set(['direct', 'viaproxy']);
const CONTROL_POLICIES = new Set(['normal', 'remote-plugin-lifecycle', 'plugin-disabled']);

function strip(value, max = 120) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, max);
}

function isLocallyAttached(row) {
  if (!row || Number(row.unresolved_target) === 1) return false;
  if (row.target_type !== 'local-server' || !row.target_server_id) return false;
  try {
    const att = require('./serverPluginAttachments').findByResource(
      require('./serverPluginAttachments').pluginIdForProvider(row.provider_id) || 'gateway-geyser',
      'gateway',
      String(row.id)
    );
    return Boolean(att);
  } catch {
    return false;
  }
}

function decorateEntity(entity, row, { pluginDisabled = false } = {}) {
  if (!entity) return null;
  const unresolved = Number(row?.unresolved_target) === 1;
  const remote = row?.target_type !== 'local-server' || unresolved || !row?.target_server_id;
  entity.projected = true;
  entity.unresolvedTarget = unresolved;
  entity.typeLabel = remote ? 'Remote Java — Geyser' : strip(entity.typeLabel || 'Geyser Server', 40);
  entity.controlPolicy = pluginDisabled ? 'plugin-disabled' : 'remote-plugin-lifecycle';
  entity.disabledReasonId = pluginDisabled ? 'plugin-disabled' : 'remote-java';
  entity.coreActionsDisabled = true;
  if (!CONTROL_POLICIES.has(entity.controlPolicy)) entity.controlPolicy = 'remote-plugin-lifecycle';
  try {
    const contribution = require('./pluginContributions').projectedContribution(row, entity);
    entity.pluginContributions = contribution ? [contribution] : [];
    if (contribution?.management?.href) {
      entity.managementUrl = pluginDisabled ? '/plugins' : contribution.management.href;
    }
  } catch {
    entity.pluginContributions = entity.pluginContributions || [];
  }
  return entity;
}

function sanitizeEntity(raw, fallback = {}) {
  const gatewayId = Number(raw?.gatewayId || fallback.gatewayId);
  if (!Number.isInteger(gatewayId) || gatewayId < 1) return null;
  const kind = KINDS.has(raw?.kind) ? raw.kind : (fallback.kind || 'geyser_gateway');
  const status = STATUSES.has(raw?.status) ? raw.status : (fallback.status || 'stopped');
  const compatibilityMode = MODES.has(raw?.compatibilityMode) ? raw.compatibilityMode : 'direct';
  const pluginId = strip(raw?.pluginId || fallback.pluginId || '', 80).replace(/[^a-z0-9-]/gi, '') || fallback.pluginId || '';
  const port = Number(raw?.port || fallback.port);
  const connectAddress = strip(raw?.connectAddress || fallback.connectAddress || connectHost.resolve(), 253);
  if (connectHost.isLoopbackHost(connectAddress)) {
    /* still show on dashboard; Bedrock Connect advertisement will omit loopback */
  }
  const entity = {
    id: `gateway:${gatewayId}`,
    kind,
    gatewayProvider: strip(raw?.gatewayProvider || fallback.gatewayProvider || 'geyser', 40),
    name: strip(raw?.name || fallback.name || 'Geyser Server', 80),
    typeLabel: 'Remote Java — Geyser',
    status,
    connectAddress,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : Number(fallback.port) || 0,
    targetSummary: strip(raw?.targetSummary || fallback.targetSummary || '', 160),
    compatibilityMode,
    managedByPlugin: true,
    readOnly: true,
    pluginId,
    pluginDisabled: Boolean(raw?.pluginDisabled || fallback.pluginDisabled),
    managementUrl: raw?.pluginDisabled || fallback.pluginDisabled
      ? '/plugins'
      : strip(raw?.managementUrl || `/plugins/${pluginId}?gatewayId=${gatewayId}`, 200),
    health: strip(raw?.health || fallback.health || status, 40),
    authentication: strip(raw?.authentication || fallback.authentication || '', 32),
    geyserVersion: strip(raw?.geyserVersion || fallback.geyserVersion || '', 32),
    viaproxyVersion: strip(raw?.viaproxyVersion || fallback.viaproxyVersion || '', 32),
    lastError: strip(raw?.lastError || fallback.lastError || '', 300),
  };
  delete entity.floodgateKeyPath;
  delete entity.internalPort;
  delete entity.viaproxyBindPort;
  return entity;
}

function snapshotEntity(pluginId, entity) {
  if (!entity?.id || !pluginId) return;
  const payload = { ...entity };
  delete payload.pluginContributions;
  db.prepare(`
    INSERT INTO plugin_dashboard_snapshots (entity_id, plugin_id, payload, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(entity_id) DO UPDATE SET plugin_id = excluded.plugin_id, payload = excluded.payload, updated_at = CURRENT_TIMESTAMP
  `).run(entity.id, pluginId, JSON.stringify(payload));
}

function snapshotPlugin(pluginId) {
  const entities = listLive(pluginId);
  for (const entity of entities) snapshotEntity(pluginId, { ...entity, pluginDisabled: false });
}

function snapshotAllGateways() {
  const pluginHost = require('./pluginHost');
  const rows = db.prepare('SELECT * FROM gateways').all();
  for (const row of rows) {
    const entity = entityFromRow(row, { pluginDisabled: false });
    if (entity?.pluginId) snapshotEntity(entity.pluginId, entity);
  }
  return pluginHost;
}

function entityFromRow(row, { pluginDisabled = false } = {}) {
  if (!row) return null;
  const entry = gatewayRegistry.get(row.provider_id);
  const pluginId = entry?.pluginId || '';
  const targetSummary = row.target_type === 'local-server'
    ? `Local Java ${row.target_host || '127.0.0.1'}:${row.target_tcp_port || ''}`
    : `Remote Java ${row.target_host || ''}:${row.target_tcp_port || ''}`;
  const raw = {
    gatewayId: row.id,
    kind: 'geyser_gateway',
    gatewayProvider: row.provider_id,
    name: row.name,
    status: pluginDisabled ? 'plugin_disabled' : (row.health_status || row.status || 'stopped'),
    connectAddress: connectHost.resolve(),
    port: row.bedrock_udp_port,
    targetSummary,
    compatibilityMode: row.compatibility_mode === 'viaproxy' ? 'viaproxy' : 'direct',
    pluginId: pluginId || 'gateway-geyser',
    pluginDisabled,
    managementUrl: pluginDisabled ? '/plugins' : `/plugins/${pluginId || 'gateway-geyser'}?gatewayId=${row.id}`,
    health: pluginDisabled ? 'plugin_disabled' : (row.health_status || row.status),
    authentication: row.authentication,
    geyserVersion: row.geyser_version,
    viaproxyVersion: row.viaproxy_version,
    lastError: row.last_error,
  };
  if (entry?.provider && typeof entry.provider.getDashboardEntity === 'function' && !pluginDisabled) {
    try {
      Object.assign(raw, entry.provider.getDashboardEntity(row) || {});
    } catch { /* ignore provider dashboard errors */ }
  }
  return sanitizeEntity(raw, raw);
}

function listLive(onlyPluginId = null) {
  const rows = db.prepare('SELECT * FROM gateways ORDER BY name').all();
  const out = [];
  for (const row of rows) {
    const entry = gatewayRegistry.get(row.provider_id);
    if (onlyPluginId && entry?.pluginId !== onlyPluginId) continue;
    const entity = entityFromRow(row, { pluginDisabled: false });
    if (entity) out.push(entity);
  }
  return out;
}

function buildEntity(row, { pluginDisabled = false, enabledPlugins = null } = {}) {
  const pluginHost = require('./pluginHost');
  const enabled = enabledPlugins || new Set(
    (pluginHost.getPlugins() || []).filter((plugin) => plugin.enabled).map((plugin) => plugin.id)
  );
  const entry = gatewayRegistry.get(row.provider_id);
  const pluginId = entry?.pluginId;
  const disabled = pluginDisabled || !pluginId || !enabled.has(pluginId);
  let entity = entityFromRow(row, { pluginDisabled: disabled });
  if (disabled) {
    const snap = db.prepare('SELECT payload FROM plugin_dashboard_snapshots WHERE entity_id = ?').get(`gateway:${row.id}`);
    if (snap?.payload) {
      try {
        entity = sanitizeEntity({ ...JSON.parse(snap.payload), pluginDisabled: true, status: 'plugin_disabled', managementUrl: '/plugins' }, entity);
      } catch { /* keep live fallback */ }
    }
    if (entity) {
      entity.pluginDisabled = true;
      entity.status = 'plugin_disabled';
      entity.managementUrl = '/plugins';
    }
  } else if (entity && pluginId) {
    snapshotEntity(pluginId, entity);
  }
  return decorateEntity(entity, row, { pluginDisabled: disabled });
}

function list({ projectedOnly = true } = {}) {
  const pluginHost = require('./pluginHost');
  const enabledPlugins = new Set(
    (pluginHost.getPlugins() || []).filter((plugin) => plugin.enabled).map((plugin) => plugin.id)
  );
  const rows = db.prepare('SELECT * FROM gateways ORDER BY name').all();
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (projectedOnly && isLocallyAttached(row)) continue;
    const entity = buildEntity(row, { enabledPlugins });
    if (entity && !seen.has(entity.id)) {
      seen.add(entity.id);
      out.push(entity);
    }
  }
  return out;
}

function get(id) {
  const raw = String(id || '');
  const num = raw.startsWith('gateway:') ? Number(raw.slice(8)) : Number(raw);
  if (!Number.isInteger(num) || num < 1) return null;
  const row = db.prepare('SELECT * FROM gateways WHERE id = ?').get(num);
  if (!row) return null;
  return buildEntity(row);
}

function collisionsWithServers() {
  const servers = db.prepare('SELECT id FROM servers').all().map((row) => String(row.id));
  return list({ projectedOnly: false }).filter((entity) => servers.includes(entity.id));
}

module.exports = {
  collisionsWithServers,
  collisionsWithServers: collisionsWithServers,
  entityFromRow,
  get,
  isLocallyAttached,
  list,
  sanitizeEntity,
  snapshotAllGateways,
  snapshotPlugin,
};
