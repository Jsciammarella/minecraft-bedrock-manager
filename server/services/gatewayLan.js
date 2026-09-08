'use strict';

const db = require('../db/connection');
const logger = require('./logger');
const connectHost = require('./connectHost');
const gatewayRegistry = require('./gatewayRegistry');
const lanBroadcast = require('./lanBroadcast');
const pluginAudit = require('./pluginAudit');

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 8;
const rateBuckets = new Map();
const HEALTHY = new Set(['running']);
const UNHEALTHY = new Set([
  'failed', 'auth_misconfigured', 'protocol_incompatible', 'target_unreachable', 'port_conflict',
]);

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function sanitizeText(value, max = 240) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/https?:\/\//gi, '')
    .trim()
    .slice(0, max);
}

function ownerKeyFor(gatewayId) {
  return lanBroadcast.ownerKey('gateway', gatewayId);
}

function getRow(id) {
  return db.prepare('SELECT * FROM gateways WHERE id = ?').get(id) || null;
}

function linkedJavaServer(row) {
  if (!row || row.target_type !== 'local-server' || !row.target_server_id) return null;
  if (Number(row.unresolved_target) === 1) return null;
  return db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(row.target_server_id, 'java') || null;
}

function requireEnabledProvider(row) {
  const entry = gatewayRegistry.get(row?.provider_id);
  if (!entry?.provider) {
    throw fail(404, 'GATEWAY_LAN_UNSUPPORTED', 'That gateway provider is not installed or is disabled.');
  }
  const meta = entry.provider.getMetadata ? entry.provider.getMetadata() : {};
  if (!meta.supportsLanBroadcast || typeof entry.provider.getLanBroadcastTarget !== 'function') {
    throw fail(400, 'GATEWAY_LAN_UNSUPPORTED', 'This gateway does not support LAN advertising.');
  }
  return { entry, meta };
}

function isLoopbackOnlyListen(address) {
  const value = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

function validateProviderTarget(raw, gateway, javaServer) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail(400, 'GATEWAY_TARGET_UNAVAILABLE', 'The gateway provider did not return a LAN target.');
  }
  if (String(raw.resourceType || '') !== 'gateway') {
    throw fail(400, 'GATEWAY_TARGET_UNAVAILABLE', 'LAN targets must identify a gateway resource.');
  }
  if (String(raw.resourceId || '') !== String(gateway.id)) {
    throw fail(400, 'GATEWAY_TARGET_UNAVAILABLE', 'LAN target resource does not match this gateway.');
  }
  if (String(raw.ownerKey || '') !== ownerKeyFor(gateway.id)) {
    throw fail(400, 'GATEWAY_TARGET_UNAVAILABLE', 'LAN target owner key is invalid.');
  }
  if (String(raw.protocol || '').toLowerCase() !== 'udp') {
    throw fail(400, 'GATEWAY_LAN_UNSUPPORTED', 'LAN advertising only supports UDP Bedrock endpoints.');
  }
  if (raw.localOnly !== true && raw.localOnly !== 1) {
    throw fail(400, 'GATEWAY_TARGET_UNAVAILABLE', 'LAN advertising is limited to local gateway endpoints.');
  }
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw fail(400, 'GATEWAY_TARGET_UNAVAILABLE', 'LAN target port must be between 1 and 65535.');
  }
  if (javaServer && Number(javaServer.port) === port) {
    throw fail(400, 'GATEWAY_TARGET_UNAVAILABLE', 'LAN advertising cannot target the Java server TCP port.');
  }
  if (Number(gateway.viaproxy_bind_port) === port) {
    throw fail(400, 'GATEWAY_TARGET_UNAVAILABLE', 'LAN advertising cannot target ViaProxy\'s loopback TCP bind port.');
  }
  if (isLoopbackOnlyListen(gateway.bedrock_listen_address)) {
    throw fail(400, 'GATEWAY_TARGET_UNAVAILABLE', 'This gateway only listens on loopback, so consoles cannot join it over LAN.');
  }
  return {
    resourceType: 'gateway',
    resourceId: String(gateway.id),
    ownerKey: ownerKeyFor(gateway.id),
    name: sanitizeText(raw.name || gateway.name, 80) || 'Gateway',
    protocol: 'udp',
    port,
    localOnly: true,
  };
}

function resolveLanTarget(row, javaServer) {
  const { entry } = requireEnabledProvider(row);
  const raw = entry.provider.getLanBroadcastTarget(row, javaServer);
  return validateProviderTarget(raw, row, javaServer);
}

function bedrockConnectActive() {
  try {
    return require('./serverManager').isBedrockConnectActive();
  } catch {
    return false;
  }
}

function gatewayProcessRunning(id) {
  try {
    return require('./gatewayManager').isActive(id);
  } catch {
    return false;
  }
}

function healthOf(row) {
  return String(row?.health_status || row?.status || 'stopped');
}

function isHealthy(row, id) {
  return HEALTHY.has(healthOf(row)) && gatewayProcessRunning(id) && !UNHEALTHY.has(healthOf(row));
}

function enforceRateLimit(id) {
  const now = Date.now();
  const key = String(id);
  const bucket = (rateBuckets.get(key) || []).filter((at) => now - at < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX) {
    throw fail(429, 'GATEWAY_LAN_RATE_LIMITED', 'Too many LAN advertising requests. Wait a moment and try again.');
  }
  bucket.push(now);
  rateBuckets.set(key, bucket);
}

function persistPreference(id, { enabled, proxyPort, error }) {
  const fields = ['updated_at = CURRENT_TIMESTAMP'];
  const values = [];
  if (enabled != null) {
    fields.unshift('lan_broadcast = ?');
    values.push(enabled ? 1 : 0);
  }
  if (proxyPort !== undefined) {
    fields.unshift('lan_proxy_port = ?');
    values.push(proxyPort == null ? null : Number(proxyPort));
  }
  if (error !== undefined) {
    fields.unshift('lan_last_error = ?');
    values.push(error ? sanitizeText(error, 240) : null);
  }
  values.push(id);
  db.prepare(`UPDATE gateways SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function stopProcess(id) {
  lanBroadcast.stopByOwner(ownerKeyFor(id));
}

function nativeEligible(row, target) {
  return Number(target.port) === lanBroadcast.DISCOVERY_PORT;
}

async function udpListenerPresent(port) {
  try {
    const serverManager = require('./serverManager');
    const free = await serverManager.isUdpPortAvailable(port);
    return !free;
  } catch {
    return false;
  }
}

async function assertReadyToAdvertise(row, javaServer, target) {
  if (!javaServer) {
    throw fail(400, 'GATEWAY_NOT_LINKED', 'This gateway is not linked to a Java server.');
  }
  if (bedrockConnectActive()) {
    throw fail(409, 'BEDROCK_CONNECT_LAN_CONFLICT', 'Bedrock Connect is using UDP 19132. Stop Bedrock Connect before enabling LAN advertising.');
  }
  if (!isHealthy(row, row.id)) {
    if (UNHEALTHY.has(healthOf(row))) {
      throw fail(400, 'GATEWAY_NOT_HEALTHY', 'Start a healthy Geyser gateway before enabling LAN advertising.');
    }
    throw fail(400, 'GATEWAY_NOT_RUNNING', 'Start Geyser before enabling LAN advertising.');
  }
  if (isLoopbackOnlyListen(row.bedrock_listen_address)) {
    throw fail(400, 'GATEWAY_TARGET_UNAVAILABLE', 'This gateway only listens on loopback, so consoles cannot join it over LAN.');
  }
  const lan = connectHost.detectLanIPv4();
  if (!lan) {
    throw fail(400, 'GATEWAY_TARGET_UNAVAILABLE', 'Could not detect a LAN address to advertise.');
  }
  const listening = await udpListenerPresent(target.port);
  if (!listening) {
    throw fail(400, 'GATEWAY_NOT_HEALTHY', 'The gateway Bedrock UDP port is not listening yet.');
  }
  return lan;
}

function nativeAdvertised(row, extra = {}) {
  if (Object.prototype.hasOwnProperty.call(extra, 'native')) return Boolean(extra.native);
  if (Number(row?.lan_broadcast) !== 1) return false;
  if (!isHealthy(row, row.id)) return false;
  return Number(row.bedrock_udp_port) === lanBroadcast.DISCOVERY_PORT;
}

function broadcastLinked(row) {
  const serverId = row?.target_server_id;
  if (!serverId) return;
  try { require('./serverManager').broadcastServerStatus(serverId); } catch { /* ignore */ }
}

function publicState(row, extra = {}) {
  if (!row) return null;
  const key = ownerKeyFor(row.id);
  const enabled = Number(row.lan_broadcast) === 1;
  const native = nativeAdvertised(row, extra);
  const active = native || lanBroadcast.isActiveForOwner(key);
  const error = sanitizeText(row.lan_last_error || lanBroadcast.getErrorForOwner(key), 240) || null;
  const waiting = enabled && !active;
  return {
    lanBroadcastEnabled: enabled,
    lanBroadcastActive: active,
    lanBroadcastWaiting: waiting,
    lanBroadcastNative: native,
    lanProxyPort: row.lan_proxy_port || lanBroadcast.getProxyPortForOwner(key) || null,
    lanDiscoveryPort: lanBroadcast.DISCOVERY_PORT,
    lanLastError: error,
  };
}

function buttonState(row, javaServer, extra = {}) {
  const state = publicState(row, extra) || {};
  const providerOk = (() => {
    try {
      requireEnabledProvider(row);
      return true;
    } catch {
      return false;
    }
  })();
  if (!providerOk) {
    return {
      ...state,
      show: false,
      disabled: true,
      disabledReason: '',
    };
  }
  if (!javaServer) {
    return {
      ...state,
      show: true,
      disabled: true,
      disabledReason: 'This gateway is not linked to a Java server.',
      code: 'GATEWAY_NOT_LINKED',
    };
  }
  if (bedrockConnectActive()) {
    return {
      ...state,
      show: true,
      disabled: true,
      disabledReason: 'Bedrock Connect is using UDP 19132. Stop Bedrock Connect before enabling LAN advertising.',
      code: 'BEDROCK_CONNECT_LAN_CONFLICT',
    };
  }
  if (extra.ambiguousPrimary) {
    return {
      ...state,
      show: true,
      disabled: true,
      disabledReason: 'Multiple gateways are attached. Manage LAN advertising from the gateway page.',
    };
  }
  const running = isHealthy(row, row.id);
  if (!running && !state.lanBroadcastEnabled) {
    return {
      ...state,
      show: true,
      disabled: true,
      disabledReason: 'Start Geyser before enabling LAN advertising.',
      code: 'GATEWAY_NOT_RUNNING',
    };
  }
  if (!running && state.lanBroadcastEnabled) {
    return {
      ...state,
      show: true,
      disabled: false,
      waiting: true,
      disabledReason: UNHEALTHY.has(healthOf(row))
        ? (state.lanLastError || 'LAN advertising is paused until the gateway is healthy.')
        : 'LAN advertising will resume when Geyser starts.',
    };
  }
  return {
    ...state,
    show: true,
    disabled: false,
    disabledReason: state.lanLastError || '',
  };
}

async function startAdvertiser(row, javaServer, target) {
  if (nativeEligible(row, target)) {
    const listening = await udpListenerPresent(target.port);
    if (!listening) {
      throw fail(400, 'GATEWAY_NOT_HEALTHY', 'Native UDP 19132 LAN discovery is not active on this gateway.');
    }
    persistPreference(row.id, { enabled: true, error: null });
    return { native: true, session: null };
  }
  const lan = await assertReadyToAdvertise(row, javaServer, target);
  const session = await lanBroadcast.startAndWaitForTarget({
    ownerKey: ownerKeyFor(row.id),
    name: target.name,
    targetAddress: lan,
    targetPort: target.port,
    protocol: 'udp',
    preferredProxyPort: row.lan_proxy_port,
    bindPort: lanBroadcast.allocateProxyPort(row.lan_proxy_port),
    removePorts: false,
    ipv6: true,
    allowLoopbackTarget: false,
  });
  persistPreference(row.id, { enabled: true, proxyPort: session.proxyPort, error: null });
  return { native: false, session };
}

async function setEnabled(id, enabled, { nested = false } = {}) {
  enforceRateLimit(id);
  const run = async () => {
    const row = getRow(id);
    if (!row) throw fail(404, 'GATEWAY_TARGET_UNAVAILABLE', 'Gateway not found.');
    requireEnabledProvider(row);
    const javaServer = linkedJavaServer(row);
    if (!enabled) {
      stopProcess(id);
      persistPreference(id, { enabled: false, error: null });
      pluginAudit.record('gateway.lan.disable', { targetType: 'gateway', targetId: String(id) });
      broadcastLinked(row);
      return status(id);
    }
    if (!javaServer) throw fail(400, 'GATEWAY_NOT_LINKED', 'This gateway is not linked to a Java server.');
    const target = resolveLanTarget(row, javaServer);
    try {
      await startAdvertiser(getRow(id), javaServer, target);
    } catch (err) {
      if ([
        'GATEWAY_NOT_RUNNING',
        'GATEWAY_NOT_HEALTHY',
        'GATEWAY_NOT_LINKED',
        'BEDROCK_CONNECT_LAN_CONFLICT',
        'GATEWAY_LAN_UNSUPPORTED',
      ].includes(err.code)) {
        throw err;
      }
      persistPreference(id, { enabled: true, error: err.message });
      broadcastLinked(row);
      throw err;
    }
    pluginAudit.record('gateway.lan.enable', {
      targetType: 'gateway',
      targetId: String(id),
      detail: { port: target.port },
    });
    broadcastLinked(getRow(id) || row);
    return status(id);
  };
  if (nested) return run();
  return require('./gatewayManager').withLifecycle(id, run);
}

async function restoreIfWanted(id, { nested = false } = {}) {
  const run = async () => {
    const row = getRow(id);
    if (!row || Number(row.lan_broadcast) !== 1) return null;
    if (bedrockConnectActive()) {
      stopProcess(id);
      persistPreference(id, { error: 'Bedrock Connect is using UDP 19132. LAN advertising is waiting.' });
      broadcastLinked(row);
      return status(id);
    }
    try {
      const javaServer = linkedJavaServer(row);
      const target = resolveLanTarget(row, javaServer);
      await startAdvertiser(row, javaServer, target);
      broadcastLinked(getRow(id) || row);
      return status(id);
    } catch (err) {
      stopProcess(id);
      persistPreference(id, { enabled: true, error: err.message });
      broadcastLinked(row);
      logger.warn(`Gateway LAN restore for ${id} deferred: ${err.message}`);
      return status(id);
    }
  };
  if (nested) return run();
  return require('./gatewayManager').withLifecycle(id, run);
}

function pause(id, message) {
  stopProcess(id);
  const row = getRow(id);
  if (row && Number(row.lan_broadcast) === 1) {
    persistPreference(id, { error: message || null });
    broadcastLinked(row);
  }
}

function pauseForServer(serverId, message) {
  const rows = db.prepare(`SELECT id FROM gateways WHERE target_server_id = ?`).all(serverId);
  for (const row of rows) pause(row.id, message);
}

async function restoreForServer(serverId) {
  const rows = db.prepare(`SELECT id FROM gateways WHERE target_server_id = ? AND lan_broadcast = 1`).all(serverId);
  for (const row of rows) {
    try { await restoreIfWanted(row.id); } catch { /* recorded */ }
  }
}

async function restoreAll() {
  if (bedrockConnectActive()) return;
  const rows = db.prepare('SELECT id FROM gateways WHERE lan_broadcast = 1').all();
  for (const row of rows) {
    try { await restoreIfWanted(row.id); } catch { /* recorded */ }
  }
}

function stopAllForPlugin(pluginId) {
  const ids = new Set(
    gatewayRegistry.entries()
      .filter((entry) => String(entry.pluginId) === String(pluginId))
      .map((entry) => entry.id)
  );
  const rows = db.prepare('SELECT id, provider_id FROM gateways').all();
  for (const row of rows) {
    if (!ids.has(row.provider_id)) continue;
    stopProcess(row.id);
  }
}

function status(id) {
  const row = getRow(id);
  if (!row) throw fail(404, 'GATEWAY_TARGET_UNAVAILABLE', 'Gateway not found.');
  let native = false;
  try {
    const javaServer = linkedJavaServer(row);
    const target = resolveLanTarget(row, javaServer);
    native = nativeEligible(row, target) && Number(row.lan_broadcast) === 1 && isHealthy(row, row.id);
  } catch {
    native = false;
  }
  const state = publicState(row, { native });
  return {
    success: true,
    enabled: state.lanBroadcastEnabled,
    active: state.lanBroadcastActive,
    waiting: state.lanBroadcastWaiting,
    native: state.lanBroadcastNative,
    gatewayId: Number(row.id),
    discoveryPort: state.lanDiscoveryPort,
    proxyPort: state.lanProxyPort,
    error: state.lanLastError,
  };
}

function attachmentLanRole(attachment, javaServer) {
  if (!javaServer?.id) return { include: false, ambiguousPrimary: false };
  const siblings = require('./serverPluginAttachments').listForServer(javaServer.id)
    .filter((item) => item.resource_type === 'gateway' || item.resourceType === 'gateway');
  if (siblings.length <= 1) return { include: true, ambiguousPrimary: false };
  const primaries = siblings.filter((item) => item.primary_attachment || item.primary);
  if (primaries.length !== 1) {
    return { include: Number(attachment?.id) === Number(siblings[0]?.id), ambiguousPrimary: true };
  }
  return {
    include: Number(attachment?.id) === Number(primaries[0].id),
    ambiguousPrimary: false,
  };
}

function lanActionFor(row, javaServer, attachment, actionId = 'gateway-lan') {
  const role = attachmentLanRole(attachment, javaServer);
  if (!role.include) return null;
  const button = buttonState(row, javaServer, { ambiguousPrimary: role.ambiguousPrimary });
  if (!button.show) return null;
  return {
    id: String(actionId || 'gateway-lan').slice(0, 40),
    label: 'LAN',
    kind: 'toggle',
    placement: 'lan-toggle',
    variant: 'secondary',
    state: button.disabled ? 'disabled' : 'enabled',
    active: Boolean(button.lanBroadcastActive),
    waiting: Boolean(button.lanBroadcastWaiting || button.waiting),
    icon: 'none',
    confirmation: false,
    permission: 'servers.manage_lan_broadcast',
    disabledReason: button.disabledReason || '',
  };
}

function clearCaches() {
  rateBuckets.clear();
}

module.exports = {
  attachmentLanRole,
  buttonState,
  clearCaches,
  lanActionFor,
  nativeEligible,
  ownerKeyFor,
  pause,
  pauseForServer,
  publicState,
  requireEnabledProvider,
  resolveLanTarget,
  restoreAll,
  restoreForServer,
  restoreIfWanted,
  setEnabled,
  status,
  stopAllForPlugin,
  stopProcess,
  validateProviderTarget,
};
