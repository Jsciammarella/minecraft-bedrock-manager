const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/connection');
const logger = require('./logger');
const pluginAudit = require('./pluginAudit');
const gatewayRegistry = require('./gatewayRegistry');
const javaLoaderHost = require('./javaLoaderHost');
const javaRuntime = require('./javaRuntime');
const portRanges = require('./portRanges');
const { sanitizedChildEnv } = require('./childEnv');
const controlledFs = require('./controlledFs');
const pluginEvents = require('./pluginEvents');
const playerPresence = require('./playerPresence');

const BASE_DIR = path.join(__dirname, '../../data/gateways');
const ptySessions = new Map();
const lifecycleLocks = new Map();
const COMPAT_MODES = new Set(['direct', 'viaproxy']);
const RUNTIME_BACKUP_FILES = ['config.yml', 'viaproxy.yml', path.join('plugins', 'Geyser', 'config.yml')];
const BUSY_ERROR = 'Another lifecycle operation is already in progress for this gateway';

function withLifecycle(id, fn) {
  const key = String(id);
  if (lifecycleLocks.has(key)) {
    throw Object.assign(new Error(BUSY_ERROR), { status: 409, code: 'GATEWAY_BUSY' });
  }
  const token = {};
  lifecycleLocks.set(key, token);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (lifecycleLocks.get(key) === token) lifecycleLocks.delete(key);
    });
}

function assertLifecycleIdle(id) {
  if (lifecycleLocks.has(String(id))) {
    throw Object.assign(new Error(BUSY_ERROR), { status: 409, code: 'GATEWAY_BUSY' });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function consoleLogFile(dataPath) {
  return path.join(dataPath, 'console.log');
}

function persistGatewayLogs(dataPath, text) {
  if (!dataPath) return;
  try {
    fs.writeFileSync(consoleLogFile(dataPath), String(text || '').slice(-80000));
  } catch { /* ignore */ }
}

function readPersistedLogs(dataPath) {
  try {
    return fs.readFileSync(consoleLogFile(dataPath), 'utf8').slice(-80000);
  } catch {
    return '';
  }
}

function logSnippet(text, fallback) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  return (lines.slice(-12).join('\n') || fallback || '').slice(0, 1000);
}

function killJavaInDirectory(dir) {
  if (process.platform === 'win32' || !dir) return;
  const root = path.resolve(dir);
  if (!root || !fs.existsSync('/proc')) return;
  let pids = [];
  try { pids = fs.readdirSync('/proc'); } catch { return; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const comm = fs.readFileSync(path.join('/proc', pid, 'comm'), 'utf8').trim();
      if (comm !== 'java') continue;
      let belongs = false;
      try {
        belongs = path.resolve(fs.readlinkSync(path.join('/proc', pid, 'cwd'))) === root;
      } catch { /* ignore */ }
      if (!belongs) {
        const cmdline = fs.readFileSync(path.join('/proc', pid, 'cmdline'), 'utf8');
        belongs = cmdline.includes(root);
      }
      if (!belongs) continue;
      process.kill(Number(pid), 'SIGKILL');
    } catch { /* process vanished or is not ours */ }
  }
}

function removePluginBackups(dataPath) {
  const pluginsDir = path.join(dataPath, 'plugins');
  if (!fs.existsSync(pluginsDir)) return;
  for (const name of fs.readdirSync(pluginsDir)) {
    if (/\.bak$/i.test(name) || /\.jar\.bak$/i.test(name)) {
      try { fs.unlinkSync(path.join(pluginsDir, name)); } catch { /* ignore */ }
    }
  }
}

function publicRecord(row) {
  if (!row) return null;
  const entry = gatewayRegistry.get(row.provider_id);
  const sanitized = entry?.provider.sanitizePublicRecord
    ? entry.provider.sanitizePublicRecord(row)
    : { ...row, floodgate_key_path: undefined };
  delete sanitized.floodgate_key_path;
  delete sanitized.viaproxy_bind_port;
  let dashboardAttachment = null;
  try {
    const attachments = require('./serverPluginAttachments');
    const pluginId = attachments.pluginIdForProvider(row.provider_id) || 'gateway-geyser';
    const att = attachments.findByResource(pluginId, 'gateway', String(row.id));
    dashboardAttachment = att ? {
      id: att.id,
      serverId: att.server_id,
      primary: Boolean(att.primary_attachment),
    } : null;
  } catch { /* ignore */ }
  let floodgateCanStart = true;
  let floodgateStartReason = '';
  if (row.authentication === 'floodgate' && row.target_type === 'local-server'
    && typeof entry?.provider.inspectFloodgateReadiness === 'function') {
    const server = row.target_server_id
      ? db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(row.target_server_id, 'java')
      : null;
    const readiness = entry.provider.inspectFloodgateReadiness(server || {});
    floodgateCanStart = Boolean(readiness.ready);
    if (!floodgateCanStart) {
      floodgateStartReason = 'Install a compatible Floodgate backend before starting Geyser. ViaProxy cannot replace backend Floodgate.';
    }
  }
  return {
    ...sanitized,
    compatibilityMode: row.compatibility_mode === 'viaproxy' ? 'viaproxy' : 'direct',
    advertiseInBedrockConnect: Number(row.advertise_in_bedrock_connect) !== 0,
    health: row.health_status || row.status,
    viaproxyVersion: row.viaproxy_version || null,
    geyserViaProxyVersion: row.geyser_viaproxy_version || null,
    targetMinecraftVersion: row.target_minecraft_version || null,
    lastCompatibilityResult: row.last_compatibility_result || null,
    lastError: entry?.provider.explainLastError
      ? entry.provider.explainLastError(row.last_error)
      : (row.last_error || null),
    dashboardId: `gateway:${row.id}`,
    typeLabel: row.target_type === 'local-server' && row.target_server_id && Number(row.unresolved_target) !== 1
      ? 'Geyser'
      : 'Remote Java — Geyser',
    unresolvedTarget: Number(row.unresolved_target) === 1,
    unresolvedReason: row.unresolved_reason || null,
    dashboardAttachment,
    notices: entry ? (gatewayRegistry.publicMetadata(entry).notices || []) : [],
    floodgateCanStart,
    floodgateStartReason,
  };
}

function get(id) {
  return db.prepare('SELECT * FROM gateways WHERE id = ?').get(id);
}

function list() {
  return db.prepare('SELECT * FROM gateways ORDER BY name').all().map(publicRecord);
}

function takenPorts() {
  const fromServers = db.prepare('SELECT port, ipv6_port, pending_port, pending_ipv6_port FROM servers').all()
    .flatMap((row) => [row.port, row.ipv6_port, row.pending_port, row.pending_ipv6_port]);
  const fromUsage = db.prepare('SELECT port FROM port_usage WHERE in_use = 1').all().map((row) => row.port);
  const fromGateways = db.prepare('SELECT bedrock_udp_port FROM gateways').all().map((row) => row.bedrock_udp_port);
  return new Set([...fromServers, ...fromUsage, ...fromGateways].map(Number).filter(Boolean));
}

function allocateUdpPort(preferred) {
  const taken = takenPorts();
  taken.add(portRanges.DISCOVERY_IPV4);
  taken.add(portRanges.DISCOVERY_IPV6);
  const want = Number(preferred);
  if (want) {
    if (portRanges.isDiscoveryPort(want)) {
      throw Object.assign(new Error(`UDP ${want} is reserved for Bedrock LAN discovery / Bedrock Connect`), { status: 400 });
    }
    if (taken.has(want)) throw Object.assign(new Error(`UDP port ${want} is already in use`), { status: 400 });
    if (!portRanges.isIpv4GamePort(want) && want < 19132) {
      throw Object.assign(new Error(`UDP port ${want} is not in the game ranges`), { status: 400 });
    }
    return want;
  }
  for (const port of portRanges.ipv4Candidates()) {
    if (portRanges.isDiscoveryPort(port) || taken.has(port)) continue;
    if (port >= 25565 && port <= 25665) continue;
    return port;
  }
  throw new Error('No free UDP port is available for this gateway');
}

function suggestUdpPort(preferred) {
  try {
    return allocateUdpPort(preferred);
  } catch (err) {
    throw Object.assign(err, { code: err.code || 'GATEWAY_PORT_UNAVAILABLE' });
  }
}

function registerGatewayPort(gatewayId, port) {
  db.prepare(`
    INSERT OR REPLACE INTO port_usage (port, server_id, gateway_id, protocol, family, in_use)
    VALUES (?, NULL, ?, 'udp', 'ipv4', 1)
  `).run(port, gatewayId);
}

function unregisterGatewayPort(gatewayId) {
  db.prepare('DELETE FROM port_usage WHERE gateway_id = ?').run(gatewayId);
}

function compatibilityModeOf(value) {
  return String(value || 'direct').toLowerCase() === 'viaproxy' ? 'viaproxy' : 'direct';
}

function allocateLoopbackTcpPort(preferred) {
  const taken = takenPorts();
  for (const row of db.prepare('SELECT viaproxy_bind_port, target_tcp_port FROM gateways').all()) {
    taken.add(Number(row.viaproxy_bind_port));
    taken.add(Number(row.target_tcp_port));
  }
  const want = Number(preferred);
  if (want >= 1024 && want <= 65535 && !taken.has(want) && want !== 25565) return want;
  for (let port = 25566; port <= 25700; port += 1) {
    if (!taken.has(port)) return port;
  }
  throw Object.assign(new Error('No free loopback TCP port is available for ViaProxy'), { status: 400 });
}

function persistGatewayExtras(id, fields) {
  const row = get(id);
  if (!row) return;
  db.prepare(`
    UPDATE gateways
    SET compatibility_mode = ?, advertise_in_bedrock_connect = ?, viaproxy_version = ?,
      geyser_viaproxy_version = ?, viaproxy_bind_port = ?, target_minecraft_version = ?,
      last_compatibility_check = ?, last_compatibility_result = ?, last_error = ?,
      health_status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    compatibilityModeOf(fields.compatibility_mode ?? row.compatibility_mode),
    fields.advertise_in_bedrock_connect != null ? (fields.advertise_in_bedrock_connect ? 1 : 0) : (row.advertise_in_bedrock_connect ?? 1),
    fields.viaproxy_version !== undefined ? fields.viaproxy_version : row.viaproxy_version,
    fields.geyser_viaproxy_version !== undefined ? fields.geyser_viaproxy_version : row.geyser_viaproxy_version,
    fields.viaproxy_bind_port !== undefined ? fields.viaproxy_bind_port : row.viaproxy_bind_port,
    fields.target_minecraft_version !== undefined ? fields.target_minecraft_version : row.target_minecraft_version,
    fields.last_compatibility_check !== undefined ? fields.last_compatibility_check : row.last_compatibility_check,
    fields.last_compatibility_result !== undefined ? fields.last_compatibility_result : row.last_compatibility_result,
    fields.last_error !== undefined ? fields.last_error : row.last_error,
    fields.health_status || row.health_status || row.status,
    id
  );
}

function writeRuntimeFiles(row, provider) {
  const dest = writeConfig(row, provider);
  if (typeof provider.getRuntimeFiles === 'function') {
    const files = provider.getRuntimeFiles(row) || [];
    for (const file of files) {
      const relative = controlledFs.assertRelative(file.destination);
      const full = path.join(row.data_path, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, String(file.contents || ''), { encoding: 'utf8' });
    }
  }
  if (typeof provider.prepareRuntime === 'function') provider.prepareRuntime(row);
  removePluginBackups(row.data_path);
  return dest;
}

function localTargetVersion(row) {
  if (row.target_type !== 'local-server' || !row.target_server_id) return row.target_minecraft_version || null;
  const server = db.prepare('SELECT minecraft_version, version FROM servers WHERE id = ?').get(row.target_server_id);
  return server?.minecraft_version || server?.version || row.target_minecraft_version || null;
}

function localTargetLoader(row) {
  if (row.target_type !== 'local-server' || !row.target_server_id) return null;
  const server = db.prepare('SELECT loader_provider_id FROM servers WHERE id = ?').get(row.target_server_id);
  return server?.loader_provider_id || null;
}

function checkCompatibility(id) {
  const row = get(id);
  if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
  const entry = gatewayRegistry.get(row.provider_id);
  const version = localTargetVersion(row);
  const loaderProviderId = localTargetLoader(row);
  row.target_minecraft_version = version;
  let result = {
    compatible: true,
    recommendedMode: 'direct',
    targetVersion: version,
    message: 'Direct Geyser can target this Java version.',
  };
  if (entry?.provider && typeof entry.provider.checkCompatibility === 'function') {
    result = {
      ...result,
      ...entry.provider.checkCompatibility(row, { minecraftVersion: version, loaderProviderId }),
    };
  }
  persistGatewayExtras(id, {
    target_minecraft_version: version,
    last_compatibility_check: new Date().toISOString(),
    last_compatibility_result: result.recommendedMode === 'viaproxy'
      ? (compatibilityModeOf(row.compatibility_mode) === 'viaproxy' ? 'viaproxy-active' : 'viaproxy-recommended')
      : 'direct-ok',
  });
  pluginAudit.record('gateway.compatibility.check', {
    targetType: 'gateway',
    targetId: String(id),
    detail: { recommendedMode: result.recommendedMode, targetVersion: version },
  });
  return { ...result, gateway: publicRecord(get(id)) };
}

async function installCompatibilityUnlocked(id, { confirmViaProxy = false, confirmModeSwitch = false } = {}) {
  const row = get(id);
  if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
  if (!confirmViaProxy) {
    throw Object.assign(new Error('ViaProxy compatibility components are not installed unless you confirm that choice'), { status: 400 });
  }
  if ((row.status === 'running' || row.status === 'starting') && !confirmModeSwitch) {
    throw Object.assign(new Error('Stop the gateway or confirm the mode switch before installing ViaProxy'), { status: 400 });
  }
  const entry = gatewayRegistry.requireGateway(row.provider_id);
  const wasRunning = row.status === 'running' || ptySessions.has(String(id));
  if (wasRunning) stopNow(id);
  if (typeof entry.provider.planCompatibilityInstallation !== 'function') {
    throw Object.assign(new Error('This gateway provider does not support ViaProxy compatibility'), { status: 400 });
  }
  const bindPort = allocateLoopbackTcpPort(row.viaproxy_bind_port);
  persistGatewayExtras(id, { compatibility_mode: 'viaproxy', viaproxy_bind_port: bindPort });
  const next = get(id);
  const backups = [];
  try {
    const plan = await entry.provider.planCompatibilityInstallation({ ...next, confirmViaProxy: true });
    const jarNames = (plan.downloads || []).map((item) => path.join(next.data_path, item.destination));
    const backupDir = path.join(next.data_path, '.backup');
    fs.mkdirSync(backupDir, { recursive: true });
    for (const jar of jarNames) {
      if (fs.existsSync(jar)) {
        const backup = path.join(backupDir, path.basename(jar));
        fs.copyFileSync(jar, backup);
        backups.push({ jar, backup });
      }
    }
    removePluginBackups(next.data_path);
    await javaLoaderHost.executeInstallPlan(plan, {
      serverDir: next.data_path,
      allowHosts: entry.downloadHosts,
      ownerId: id,
    });
    persistGatewayExtras(id, {
      compatibility_mode: 'viaproxy',
      viaproxy_bind_port: bindPort,
      viaproxy_version: plan.result?.viaproxyVersion || 'latest',
      geyser_viaproxy_version: plan.result?.geyserViaProxyVersion || plan.result?.geyserVersion || 'latest',
    });
    writeRuntimeFiles(get(id), entry.provider);
    pluginAudit.record('gateway.viaproxy.install', {
      targetType: 'gateway',
      targetId: String(id),
      detail: { viaproxyVersion: plan.result?.viaproxyVersion || 'latest' },
    });
    pluginEvents.emit('gateway.updated', { gatewayId: id });
    if (wasRunning) await startNow(id);
    return publicRecord(get(id));
  } catch (err) {
    for (const item of backups) {
      try { fs.copyFileSync(item.backup, item.jar); } catch { /* ignore */ }
    }
    persistGatewayExtras(id, { last_error: err.message, health_status: 'failed' });
    pluginAudit.record('gateway.viaproxy.rollback', {
      targetType: 'gateway',
      targetId: String(id),
      detail: { error: err.message },
    });
    if (wasRunning) {
      persistGatewayExtras(id, { compatibility_mode: row.compatibility_mode || 'direct' });
      try { await startNow(id); } catch { /* keep failed */ }
    }
    throw err;
  }
}

function installCompatibility(id, opts) {
  return withLifecycle(id, () => installCompatibilityUnlocked(id, opts));
}

async function removeCompatibilityUnlocked(id, { confirm = false } = {}) {
  const row = get(id);
  if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
  if (!confirm) throw Object.assign(new Error('Removing ViaProxy requires confirmation'), { status: 400 });
  if (row.status === 'running' || row.status === 'starting') {
    throw Object.assign(new Error('Stop the gateway before removing ViaProxy components'), { status: 400 });
  }
  const entry = gatewayRegistry.requireGateway(row.provider_id);
  for (const relative of ['ViaProxy.jar', path.join('plugins', 'Geyser-ViaProxy.jar')]) {
    const full = path.join(row.data_path, relative);
    try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch { /* ignore */ }
  }
  persistGatewayExtras(id, {
    compatibility_mode: 'direct',
    viaproxy_version: null,
    geyser_viaproxy_version: null,
    viaproxy_bind_port: null,
  });
  writeRuntimeFiles(get(id), entry.provider);
  pluginAudit.record('gateway.viaproxy.remove', { targetType: 'gateway', targetId: String(id) });
  pluginEvents.emit('gateway.updated', { gatewayId: id });
  return publicRecord(get(id));
}

function removeCompatibility(id, opts) {
  return withLifecycle(id, () => removeCompatibilityUnlocked(id, opts));
}

function normalizeAuth(value) {
  const auth = String(value || 'online').toLowerCase();
  if (!['online', 'floodgate', 'offline'].includes(auth)) {
    throw Object.assign(new Error('Authentication must be online, floodgate, or offline'), { status: 400 });
  }
  return auth;
}

function assertAuth(config) {
  const auth = normalizeAuth(config.authentication);
  if (auth === 'offline' && !config.confirmOffline) {
    throw Object.assign(new Error('Offline authentication requires an explicit security confirmation'), { status: 400 });
  }
  if (auth === 'floodgate' && config.targetType === 'remote-address' && !config.confirmFloodgate) {
    throw Object.assign(new Error('Remote Floodgate targets require confirmation that Floodgate is installed on the Java server'), { status: 400 });
  }
  return auth;
}

function snapshotRuntime(row) {
  const files = {};
  for (const rel of RUNTIME_BACKUP_FILES) {
    const full = path.join(row.data_path, rel);
    try {
      if (fs.existsSync(full)) files[rel] = fs.readFileSync(full);
    } catch { /* ignore */ }
  }
  return {
    files,
    db: {
      authentication: row.authentication,
      floodgate_key_path: row.floodgate_key_path,
      offline_confirmed: row.offline_confirmed,
      floodgate_confirmed: row.floodgate_confirmed,
      advertise_in_bedrock_connect: row.advertise_in_bedrock_connect,
      status: row.status,
      health_status: row.health_status,
    },
  };
}

function restoreRuntime(id, snap) {
  const row = get(id);
  if (!row || !snap) return;
  for (const rel of Object.keys(snap.files || {})) {
    const full = path.join(row.data_path, rel);
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, snap.files[rel]);
    } catch { /* ignore */ }
  }
  db.prepare(`
    UPDATE gateways
    SET authentication = ?, floodgate_key_path = ?, offline_confirmed = ?, floodgate_confirmed = ?,
      advertise_in_bedrock_connect = ?, status = ?, health_status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    snap.db.authentication,
    snap.db.floodgate_key_path,
    snap.db.offline_confirmed,
    snap.db.floodgate_confirmed,
    snap.db.advertise_in_bedrock_connect,
    snap.db.status === 'running' || snap.db.status === 'starting' ? 'stopped' : snap.db.status,
    snap.db.status === 'running' || snap.db.status === 'starting' ? 'stopped' : (snap.db.health_status || 'stopped'),
    id
  );
}

function planSettingsChange(row, config = {}) {
  const nextAuth = config.authentication != null ? normalizeAuth(config.authentication) : row.authentication;
  const nextAdvertise = config.advertiseInBedrockConnect != null
    ? Boolean(config.advertiseInBedrockConnect)
    : Number(row.advertise_in_bedrock_connect) !== 0;
  if (nextAuth === 'online' && compatibilityModeOf(row.compatibility_mode) === 'viaproxy') {
    throw Object.assign(
      new Error('ViaProxy CLI mode cannot join an online-mode Java server without Floodgate. Enable Floodgate on the Java server or use offline authentication (insecure).'),
      { status: 400, code: 'AUTH_INCOMPATIBLE' }
    );
  }

  const enteringOffline = nextAuth === 'offline' && row.authentication !== 'offline';
  const enteringFloodgate = nextAuth === 'floodgate' && row.authentication !== 'floodgate';
  const leavingFloodgate = row.authentication === 'floodgate' && nextAuth !== 'floodgate';
  let floodgateInstallRequired = false;
  let javaRestartRequired = false;
  let keySyncRequired = false;
  let remoteFloodgateConfirmRequired = false;

  if (nextAuth === 'floodgate' && row.target_type === 'local-server' && row.target_server_id) {
    const server = db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(row.target_server_id, 'java');
    if (!server) {
      throw Object.assign(new Error('The associated Java server no longer exists. Choose a new target before using Floodgate.'), { status: 400 });
    }
    keySyncRequired = true;
    const entry = gatewayRegistry.get(row.provider_id);
    if (typeof entry?.provider.inspectFloodgateReadiness === 'function') {
      floodgateInstallRequired = !entry.provider.inspectFloodgateReadiness(server).ready;
    } else {
      floodgateInstallRequired = !floodgatePresentOnServer(server.data_path);
    }
    javaRestartRequired = server.status === 'running' || server.status === 'starting';
  }
  if (enteringFloodgate && row.target_type === 'remote-address') {
    remoteFloodgateConfirmRequired = true;
  }

  const missingConfirmations = [];
  if (enteringOffline && !config.confirmOffline) missingConfirmations.push('confirmOffline');
  if (remoteFloodgateConfirmRequired && !config.confirmFloodgate) missingConfirmations.push('confirmFloodgate');
  if (floodgateInstallRequired && !config.confirmFloodgateInstall) missingConfirmations.push('confirmFloodgateInstall');

  return {
    authentication: nextAuth,
    advertiseInBedrockConnect: nextAdvertise,
    enteringOffline,
    enteringFloodgate,
    leavingFloodgate,
    floodgateInstallRequired,
    javaRestartRequired,
    keySyncRequired,
    remoteFloodgateConfirmRequired,
    keyExportAvailable: nextAuth === 'floodgate' && row.target_type === 'remote-address',
    missingConfirmations,
    changed: nextAuth !== row.authentication || nextAdvertise !== (Number(row.advertise_in_bedrock_connect) !== 0),
    wantsFloodgateInstall: nextAuth === 'floodgate' && row.target_type === 'local-server' && Boolean(config.confirmFloodgateInstall),
    wantsJavaRestart: nextAuth === 'floodgate' && row.target_type === 'local-server' && Boolean(config.confirmJavaRestart),
  };
}

function resolveTarget(config) {
  const targetType = config.targetType || (config.targetServerId ? 'local-server' : 'remote-address');
  if (targetType === 'local-server') {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(config.targetServerId);
    if (!server || server.kind !== 'java') {
      throw Object.assign(new Error('Local gateway targets must be a managed Java server'), { status: 400 });
    }
    return {
      targetType,
      target_server_id: server.id,
      target_host: '127.0.0.1',
      target_tcp_port: Number(server.port),
    };
  }
  const host = String(config.targetHost || '').trim();
  const port = Number(config.targetTcpPort);
  if (!host || host.length > 253) throw Object.assign(new Error('Remote Java host is required'), { status: 400 });
  if (host.includes('://') || /\s/.test(host)) {
    throw Object.assign(new Error('Remote host must be a hostname or IP, not a URL'), { status: 400 });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('Remote Java TCP port is invalid'), { status: 400 });
  }
  return {
    targetType: 'remote-address',
    target_server_id: null,
    target_host: host,
    target_tcp_port: port,
  };
}

const FLOODGATE_KEY_BYTES = 16;

function writeFloodgateKey(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, 'key.pem');
  // Floodgate reads key.pem as raw AES-128 bytes. Base64 or a trailing newline
  // produces InvalidKeyException: Invalid AES key length (for example 25 bytes).
  fs.writeFileSync(keyPath, crypto.randomBytes(FLOODGATE_KEY_BYTES), { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* ignore */ }
  return keyPath;
}

function floodgateKeyIsValid(keyPath) {
  try {
    return fs.existsSync(keyPath) && fs.readFileSync(keyPath).length === FLOODGATE_KEY_BYTES;
  } catch {
    return false;
  }
}

function ensureFloodgateKey(dir) {
  const keyPath = path.join(dir, 'key.pem');
  if (floodgateKeyIsValid(keyPath)) return keyPath;
  if (fs.existsSync(keyPath)) {
    logger.warn('Floodgate key.pem is not a 16-byte AES key; regenerating');
  }
  return writeFloodgateKey(dir);
}

function listFloodgateJarKinds(serverDir) {
  const kinds = [];
  for (const rel of ['mods', 'plugins']) {
    const folder = path.join(serverDir, rel);
    let names;
    try { names = fs.readdirSync(folder); } catch { continue; }
    if (names.some((name) => /floodgate/i.test(name) && /\.jar$/i.test(name))) kinds.push(rel);
  }
  return kinds;
}

function floodgateKeyDestinations(serverDir) {
  const dests = new Set();
  const pluginDir = path.join(serverDir, 'plugins', 'floodgate');
  const configDir = path.join(serverDir, 'config', 'floodgate');
  const jarKinds = listFloodgateJarKinds(serverDir);
  if (jarKinds.includes('plugins') || fs.existsSync(pluginDir)) dests.add(pluginDir);
  if (jarKinds.includes('mods') || fs.existsSync(configDir)) dests.add(configDir);
  return [...dests];
}

function copyFloodgateKeyToLocalServer(keyPath, server) {
  if (!server?.data_path || !floodgateKeyIsValid(keyPath)) return [];
  const bytes = fs.readFileSync(keyPath);
  const copied = [];
  for (const destDir of floodgateKeyDestinations(server.data_path)) {
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, 'key.pem');
    fs.writeFileSync(dest, bytes, { mode: 0o600 });
    try { fs.chmodSync(dest, 0o600); } catch { /* ignore */ }
    copied.push(dest);
  }
  if (copied.length) {
    logger.info(`Copied Floodgate key onto Java server ${server.id}; restart that server if it is already running`);
  }
  return copied;
}

function syncFloodgateKey(row) {
  if (!row || row.authentication !== 'floodgate') return row?.floodgate_key_path || null;
  const keyPath = ensureFloodgateKey(row.data_path);
  if (row.target_type === 'local-server' && row.target_server_id) {
    const server = db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(row.target_server_id, 'java');
    copyFloodgateKeyToLocalServer(keyPath, server);
  }
  return keyPath;
}

function floodgatePresentOnServer(serverDir) {
  return listFloodgateJarKinds(serverDir).length > 0;
}

async function ensureFloodgateOnLocalServer(row, { restartJava = true } = {}) {
  require('./javaHostingPolicy').assertServerEditionAvailable('java', 'install-floodgate');
  if (!row || row.authentication !== 'floodgate' || row.target_type !== 'local-server' || !row.target_server_id) {
    return { installed: false, restarted: false };
  }
  const server = db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(row.target_server_id, 'java');
  if (!server?.data_path) {
    throw Object.assign(new Error('The associated Java server no longer exists. Choose a new target before using Floodgate.'), { status: 400 });
  }
  const entry = gatewayRegistry.requireGateway(row.provider_id);
  const alreadyReady = typeof entry.provider.inspectFloodgateReadiness === 'function'
    ? entry.provider.inspectFloodgateReadiness(server).ready
    : floodgatePresentOnServer(server.data_path);
  if (alreadyReady) {
    copyFloodgateKeyToLocalServer(ensureFloodgateKey(row.data_path), server);
    return { installed: false, restarted: false, alreadyPresent: true };
  }
  if (typeof entry.provider.planFloodgateInstallation !== 'function') {
    throw Object.assign(new Error('This gateway provider cannot install Floodgate onto the Java server'), { status: 400 });
  }
  const plan = await entry.provider.planFloodgateInstallation(server);
  const copyKey = () => copyFloodgateKeyToLocalServer(ensureFloodgateKey(row.data_path), server);
  if (plan.installMode === 'atomic' && typeof entry.provider.executeFloodgatePlan === 'function') {
    await entry.provider.executeFloodgatePlan(plan, {
      serverDir: server.data_path,
      allowHosts: entry.downloadHosts,
      copyKey,
    });
  } else {
    await javaLoaderHost.executeInstallPlan(plan, {
      serverDir: server.data_path,
      allowHosts: entry.downloadHosts,
      ownerId: server.id,
    });
    copyKey();
  }
  const running = server.status === 'running' || server.status === 'starting';
  let restarted = false;
  if (restartJava && running) {
    const serverManager = require('./serverManager');
    await serverManager.restartServer(server.id);
    restarted = true;
  }
  pluginAudit.record('gateway.floodgate.install', {
    targetType: 'gateway',
    targetId: String(row.id),
    detail: { serverId: server.id, restarted },
  });
  pluginEvents.emit('gateway.updated', { gatewayId: row.id });
  return { installed: true, restarted, alreadyPresent: false };
}

async function installFloodgate(id, opts) {
  return withLifecycle(id, () => installFloodgateUnlocked(id, opts));
}

async function installFloodgateUnlocked(id, { confirm = false, restartJava = true } = {}) {
  require('./javaHostingPolicy').assertServerEditionAvailable('java', 'install-floodgate');
  if (!confirm) {
    throw Object.assign(new Error('Floodgate is not installed onto the Java server unless you confirm that choice'), { status: 400 });
  }
  const row = get(id);
  if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
  if (row.authentication !== 'floodgate') {
    throw Object.assign(new Error('Switch this gateway to Floodgate authentication before installing Floodgate on the Java server'), { status: 400 });
  }
  const result = await ensureFloodgateOnLocalServer(row, { restartJava });
  return { ...publicRecord(get(id)), floodgateInstall: result };
}

function writeConfig(row, provider) {
  const text = provider.getDefaultConfig({
    ...row,
    floodgate_key_file: row.authentication === 'floodgate' ? 'key.pem' : 'key.pem',
  });
  const dest = path.join(row.data_path, 'config.yml');
  fs.writeFileSync(dest, text);
  return dest;
}

async function create(config) {
  const providerId = String(config.providerId || '').trim();
  if (!providerId) {
    throw Object.assign(new Error('Gateway provider is required'), { status: 400 });
  }
  const entry = gatewayRegistry.requireGateway(providerId);
  const name = String(config.name || '').trim();
  if (!name) throw Object.assign(new Error('Gateway name is required'), { status: 400 });
  const auth = assertAuth(config);
  const target = resolveTarget(config);
  const port = allocateUdpPort(config.bedrockUdpPort);
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const result = db.prepare(`
    INSERT INTO gateways (
      provider_id, name, bedrock_listen_address, bedrock_udp_port, target_type,
      target_server_id, target_host, target_tcp_port, authentication, status, data_path,
      offline_confirmed, floodgate_confirmed, java_major, compatibility_mode, advertise_in_bedrock_connect
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, 21, ?, ?)
  `).run(
    providerId,
    name,
    String(config.bedrockListenAddress || '0.0.0.0'),
    port,
    target.targetType,
    target.target_server_id,
    target.target_host,
    target.target_tcp_port,
    auth,
    path.join(BASE_DIR, '_pending'),
    auth === 'offline' ? 1 : 0,
    auth === 'floodgate' ? 1 : 0,
    'direct',
    config.advertiseInBedrockConnect === false ? 0 : 1
  );
  const id = result.lastInsertRowid;
  const dataPath = path.join(BASE_DIR, String(id));
  fs.mkdirSync(dataPath, { recursive: true });
  db.prepare('UPDATE gateways SET data_path = ? WHERE id = ?').run(dataPath, id);
  registerGatewayPort(id, port);
  try {
    const plan = await entry.provider.planInstallation({ geyserVersion: config.geyserVersion || 'latest' });
    await javaLoaderHost.executeInstallPlan(plan, {
      serverDir: dataPath,
      allowHosts: entry.downloadHosts,
      ownerId: id,
    });
    let floodgateKeyPath = null;
    if (auth === 'floodgate') {
      floodgateKeyPath = writeFloodgateKey(dataPath);
      if (target.targetType === 'local-server') {
        const server = db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(target.target_server_id, 'java');
        copyFloodgateKeyToLocalServer(floodgateKeyPath, server);
      }
    }
    const row = get(id);
    const configurationPath = writeRuntimeFiles({ ...row, floodgate_key_path: floodgateKeyPath }, entry.provider);
    db.prepare(`
      UPDATE gateways SET status = 'stopped', configuration_path = ?, floodgate_key_path = ?, geyser_version = ?, health_status = 'stopped', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(configurationPath, floodgateKeyPath, plan.result?.geyserVersion || 'latest', id);
    pluginAudit.record('gateway.create', {
      targetType: 'gateway',
      targetId: String(id),
      detail: { name, providerId, targetType: target.targetType, authentication: auth, port, compatibilityMode: 'direct' },
    });
    try { require('./serverPluginAttachments').syncForGateway(get(id), { actor: 'system' }); } catch { /* ignore */ }
    pluginEvents.emit('gateway.created', { gatewayId: id });
    require('./pluginDashboard').snapshotAllGateways();
    return publicRecord(get(id));
  } catch (err) {
    unregisterGatewayPort(id);
    db.prepare('DELETE FROM gateways WHERE id = ?').run(id);
    try { fs.rmSync(dataPath, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function patchNow(id, config) {
  const row = get(id);
  if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
  if (row.status === 'running' || row.status === 'starting') {
    throw Object.assign(new Error('Stop the gateway before changing its configuration'), { status: 400 });
  }
  const entry = gatewayRegistry.requireGateway(row.provider_id);
  const auth = config.authentication ? assertAuth({ ...row, ...config, authentication: config.authentication }) : row.authentication;
  const target = (config.targetType || config.targetServerId || config.targetHost)
    ? resolveTarget({ ...row, ...config, targetType: config.targetType || row.target_type, targetServerId: config.targetServerId || row.target_server_id, targetHost: config.targetHost || row.target_host, targetTcpPort: config.targetTcpPort || row.target_tcp_port })
    : {
      targetType: row.target_type,
      target_server_id: row.target_server_id,
      target_host: row.target_host,
      target_tcp_port: row.target_tcp_port,
    };
  let port = row.bedrock_udp_port;
  if (config.bedrockUdpPort && Number(config.bedrockUdpPort) !== Number(row.bedrock_udp_port)) {
    unregisterGatewayPort(id);
    port = allocateUdpPort(config.bedrockUdpPort);
    registerGatewayPort(id, port);
  }
  if (auth === 'floodgate') {
    row.floodgate_key_path = ensureFloodgateKey(row.data_path);
    if (target.targetType === 'local-server' && target.target_server_id) {
      const server = db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(target.target_server_id, 'java');
      copyFloodgateKeyToLocalServer(row.floodgate_key_path, server);
    }
  }
  db.prepare(`
    UPDATE gateways
    SET bedrock_listen_address = ?, bedrock_udp_port = ?, target_type = ?, target_server_id = ?,
      target_host = ?, target_tcp_port = ?, authentication = ?, floodgate_key_path = ?,
      offline_confirmed = ?, floodgate_confirmed = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    config.bedrockListenAddress || row.bedrock_listen_address,
    port,
    target.targetType,
    target.target_server_id,
    target.target_host,
    target.target_tcp_port,
    auth,
    row.floodgate_key_path,
    auth === 'offline' ? 1 : row.offline_confirmed,
    auth === 'floodgate' ? 1 : row.floodgate_confirmed,
    id
  );
  const next = get(id);
  if (config.advertiseInBedrockConnect != null) {
    persistGatewayExtras(id, { advertise_in_bedrock_connect: config.advertiseInBedrockConnect ? 1 : 0 });
  }
  if (config.compatibilityMode === 'viaproxy' && compatibilityModeOf(row.compatibility_mode) !== 'viaproxy') {
    throw Object.assign(new Error('ViaProxy must be installed explicitly from the Geyser plugin before it can be used'), { status: 400 });
  }
  writeRuntimeFiles(get(id), entry.provider);
  const updated = get(id);
  const targetChanged = row.target_type !== updated.target_type
    || Number(row.target_server_id || 0) !== Number(updated.target_server_id || 0);
  try { require('./serverPluginAttachments').syncForGateway(updated, { actor: 'system' }); } catch { /* ignore */ }
  pluginAudit.record('gateway.update', { targetType: 'gateway', targetId: String(id), detail: { authentication: auth } });
  if (targetChanged) {
    pluginAudit.record('gateway.target.reassign', {
      targetType: 'gateway',
      targetId: String(id),
      detail: {
        fromType: row.target_type,
        toType: updated.target_type,
        fromServerId: row.target_server_id || null,
        toServerId: updated.target_server_id || null,
      },
    });
  }
  pluginEvents.emit('gateway.updated', { gatewayId: id });
  require('./pluginDashboard').snapshotAllGateways();
  return publicRecord(get(id));
}

function patch(id, config) {
  return withLifecycle(id, () => patchNow(id, config));
}

function exportFloodgateKey(id) {
  const row = get(id);
  if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
  if (row.authentication !== 'floodgate') {
    throw Object.assign(new Error('Floodgate is not the active authentication mode for this gateway'), { status: 400 });
  }
  const keyPath = row.floodgate_key_path || path.join(row.data_path, 'key.pem');
  if (!floodgateKeyIsValid(keyPath)) {
    throw Object.assign(new Error('A Floodgate key is not available for download yet'), { status: 404 });
  }
  return {
    filename: 'key.pem',
    bytes: fs.readFileSync(keyPath),
  };
}

async function waitUntilStopped(id, timeoutMs = 8000) {
  stopNow(id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!ptySessions.has(String(id))) {
      const row = get(id);
      if (!row || row.status === 'stopped' || row.status === 'failed') return;
    }
    await sleep(50);
  }
  if (ptySessions.has(String(id))) {
    throw Object.assign(new Error('Gateway did not stop before the configuration change'), { status: 500 });
  }
}

async function applySettings(id, config = {}) {
  return withLifecycle(id, async () => {
    const row = get(id);
    if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
    require('./javaHostingPolicy').assertServerEditionAvailable('java', 'update-gateway');
    const plan = planSettingsChange(row, config);
    if (plan.missingConfirmations.length) {
      throw Object.assign(new Error('This authentication change needs confirmation'), {
        status: 409,
        code: 'CONFIRMATION_REQUIRED',
        preview: {
          authentication: plan.authentication,
          floodgateInstallRequired: plan.floodgateInstallRequired,
          javaRestartRequired: plan.javaRestartRequired,
          remoteFloodgateConfirmRequired: plan.remoteFloodgateConfirmRequired,
          keyExportAvailable: plan.keyExportAvailable,
          leavingFloodgate: plan.leavingFloodgate,
          missingConfirmations: plan.missingConfirmations,
        },
      });
    }

    const wasRunning = row.status === 'running' || row.status === 'starting' || ptySessions.has(String(id));
    const actionOnly = !plan.changed && (plan.wantsFloodgateInstall || plan.wantsJavaRestart);
    if (plan.changed && wasRunning && !config.restartGateway) {
      throw Object.assign(
        new Error('Stop the gateway before changing its configuration, or set restartGateway to apply the change as one operation'),
        { status: 409, code: 'GATEWAY_RUNNING' }
      );
    }
    if (!plan.changed && !actionOnly) {
      return {
        ...publicRecord(get(id)),
        authentication: plan.authentication,
        gatewayRestarted: false,
        javaRestartRequired: plan.javaRestartRequired,
        javaRestarted: false,
        floodgateInstall: { installed: false, alreadyPresent: !plan.floodgateInstallRequired },
        keySynchronized: false,
        preservedInactive: [],
        warnings: [],
        errors: [],
      };
    }

    if (actionOnly) {
      const warnings = [];
      let floodgateInstall = { installed: false, alreadyPresent: false, restarted: false };
      let keySynchronized = false;
      let javaRestarted = false;
      if (plan.authentication === 'floodgate' && row.target_type === 'local-server') {
        const latest = get(id);
        if (plan.wantsFloodgateInstall) {
          floodgateInstall = await ensureFloodgateOnLocalServer(latest, {
            restartJava: plan.wantsJavaRestart,
          });
          javaRestarted = Boolean(floodgateInstall.restarted);
          keySynchronized = true;
        }
        if (plan.wantsJavaRestart && !javaRestarted) {
          const server = db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(row.target_server_id, 'java');
          if (server && (server.status === 'running' || server.status === 'starting')) {
            await require('./serverManager').restartServer(server.id);
            javaRestarted = true;
          }
        }
      }
      pluginAudit.record('gateway.update', {
        targetType: 'gateway',
        targetId: String(id),
        detail: {
          authentication: plan.authentication,
          floodgateInstall: Boolean(floodgateInstall.installed),
          javaRestarted,
        },
      });
      pluginEvents.emit('gateway.updated', { gatewayId: id });
      require('./pluginDashboard').snapshotAllGateways();
      return {
        ...publicRecord(get(id)),
        authentication: plan.authentication,
        gatewayRestarted: false,
        javaRestartRequired: plan.javaRestartRequired && !javaRestarted,
        javaRestarted,
        floodgateInstall,
        keySynchronized,
        keyExportAvailable: plan.keyExportAvailable,
        preservedInactive: [],
        warnings,
        errors: [],
      };
    }

    const backup = snapshotRuntime(row);
    const warnings = [];
    let floodgateInstall = { installed: false, alreadyPresent: false, restarted: false };
    let keySynchronized = false;
    let javaRestarted = false;
    let gatewayRestarted = false;
    try {
      if (wasRunning) await waitUntilStopped(id);
      const entry = gatewayRegistry.requireGateway(row.provider_id);
      let floodgateKeyPath = row.floodgate_key_path;
      if (plan.authentication === 'floodgate') {
        floodgateKeyPath = ensureFloodgateKey(row.data_path);
      }
      db.prepare(`
        UPDATE gateways
        SET authentication = ?, floodgate_key_path = ?, offline_confirmed = ?, floodgate_confirmed = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        plan.authentication,
        floodgateKeyPath,
        plan.authentication === 'offline' ? 1 : row.offline_confirmed,
        plan.authentication === 'floodgate' ? 1 : row.floodgate_confirmed,
        id
      );
      persistGatewayExtras(id, {
        advertise_in_bedrock_connect: plan.advertiseInBedrockConnect ? 1 : 0,
      });

      if (plan.authentication === 'floodgate' && row.target_type === 'local-server') {
        const latest = get(id);
        if (plan.floodgateInstallRequired) {
          floodgateInstall = await ensureFloodgateOnLocalServer(latest, {
            restartJava: Boolean(config.confirmJavaRestart),
          });
          javaRestarted = Boolean(floodgateInstall.restarted);
          keySynchronized = true;
        } else {
          const server = db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(row.target_server_id, 'java');
          const copied = copyFloodgateKeyToLocalServer(ensureFloodgateKey(row.data_path), server);
          keySynchronized = copied.length > 0;
          floodgateInstall = { installed: false, alreadyPresent: true, restarted: false };
          if (plan.javaRestartRequired && config.confirmJavaRestart && server) {
            await require('./serverManager').restartServer(server.id);
            javaRestarted = true;
          }
        }
      } else if (plan.authentication === 'floodgate' && row.target_type === 'remote-address') {
        ensureFloodgateKey(row.data_path);
        warnings.push('The manager cannot install Floodgate or copy the key onto a remote Java server. Download the gateway key and place it in the remote Floodgate folder.');
      }

      writeRuntimeFiles(get(id), entry.provider);
      try { require('./serverPluginAttachments').syncForGateway(get(id), { actor: 'system' }); } catch { /* ignore */ }
      if (row.authentication !== plan.authentication) {
        pluginAudit.record('gateway.authentication.change', {
          targetType: 'gateway',
          targetId: String(id),
          detail: {
            from: row.authentication,
            to: plan.authentication,
            advertiseInBedrockConnect: plan.advertiseInBedrockConnect,
            offlineConfirmed: Boolean(config.confirmOffline),
            floodgateConfirmed: Boolean(config.confirmFloodgate),
          },
        });
      }
      pluginAudit.record('gateway.update', { targetType: 'gateway', targetId: String(id), detail: { authentication: plan.authentication } });
      pluginEvents.emit('gateway.updated', { gatewayId: id });
      require('./pluginDashboard').snapshotAllGateways();

      if (wasRunning && config.restartGateway) {
        await startNow(id);
        gatewayRestarted = true;
        const latest = get(id);
        if (latest.status !== 'running' && latest.status !== 'starting') {
          throw Object.assign(new Error('Gateway did not start after the authentication change'), { status: 500 });
        }
      }

      const preservedInactive = plan.leavingFloodgate
        ? ['Floodgate JARs', 'Floodgate configuration', 'key.pem', 'ViaProxy helper files']
        : [];
      if (plan.leavingFloodgate) {
        warnings.push('Floodgate remains installed but inactive for this gateway. Files were not deleted.');
      }

      return {
        ...publicRecord(get(id)),
        authentication: plan.authentication,
        gatewayRestarted,
        javaRestartRequired: plan.javaRestartRequired && !javaRestarted,
        javaRestarted,
        floodgateInstall,
        keySynchronized,
        keyExportAvailable: plan.keyExportAvailable,
        preservedInactive,
        warnings,
        errors: [],
      };
    } catch (err) {
      try { restoreRuntime(id, backup); } catch { /* ignore */ }
      const latest = get(id);
      if (latest && (latest.status === 'running' || latest.status === 'starting') && !ptySessions.has(String(id))) {
        db.prepare(`UPDATE gateways SET status = 'stopped', health_status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(String(err.message || err), id);
      }
      throw err;
    }
  });
}

function syncLocalTargetPort(serverId, tcpPort) {
  const rows = db.prepare(`SELECT * FROM gateways WHERE target_type = 'local-server' AND target_server_id = ?`).all(serverId);
  for (const row of rows) {
    db.prepare('UPDATE gateways SET target_tcp_port = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Number(tcpPort), row.id);
    const entry = gatewayRegistry.get(row.provider_id);
    if (entry) writeConfig({ ...row, target_tcp_port: Number(tcpPort) }, entry.provider);
  }
}

async function start(id) {
  return withLifecycle(id, () => startNow(id));
}

function isActive(id) {
  return ptySessions.has(String(id));
}

async function startNow(id) {
  require('./javaHostingPolicy').assertServerEditionAvailable('java', 'start-gateway');
  const row = get(id);
  if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
  if (ptySessions.has(String(id))) {
    throw Object.assign(new Error('Gateway already running'), { status: 400 });
  }
  if (row.status === 'running' || row.status === 'starting') {
    killJavaInDirectory(row.data_path);
    db.prepare(`UPDATE gateways SET status = 'stopped', health_status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  }
  const entry = gatewayRegistry.requireGateway(row.provider_id);
  if (row.target_type === 'local-server') {
    const server = db.prepare('SELECT id, status FROM servers WHERE id = ? AND kind = ?').get(row.target_server_id, 'java');
    if (!server) {
      throw Object.assign(new Error('The associated Java server no longer exists. Choose a new target before starting this gateway.'), { status: 400 });
    }
    if (server.status !== 'running') {
      throw Object.assign(new Error('Start the Java server before starting Geyser.'), { status: 400, code: 'JAVA_PREREQUISITE' });
    }
  }
  db.prepare(`UPDATE gateways SET status = 'starting', health_status = 'starting', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  if (global.io) global.io.emit('gateway-status', { gatewayId: id, status: 'starting' });
  pluginEvents.emit('gateway.updated', { gatewayId: id });
  try {
    if (row.authentication === 'floodgate') {
      if (row.target_type === 'local-server') {
        const server = db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(row.target_server_id, 'java');
        if (typeof entry.provider.preflightFloodgateStart === 'function') {
          const blocked = entry.provider.preflightFloodgateStart({
            server,
            gateway: get(id),
            skipKeys: true,
          });
          if (blocked) throw blocked;
        }
      }
      row.floodgate_key_path = syncFloodgateKey(get(id));
      db.prepare(`UPDATE gateways SET floodgate_key_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(row.floodgate_key_path, id);
      if (row.target_type === 'local-server' && typeof entry.provider.preflightFloodgateStart === 'function') {
        const server = db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(row.target_server_id, 'java');
        const blocked = entry.provider.preflightFloodgateStart({
          server,
          gateway: get(id),
          keysOnly: true,
        });
        if (blocked) throw blocked;
      }
    }
    if (typeof entry.provider.validateLaunch === 'function') {
      entry.provider.validateLaunch(get(id));
    }
    const current = get(id);
    if (compatibilityModeOf(current.compatibility_mode) !== 'viaproxy'
      && typeof entry.provider.checkCompatibility === 'function') {
      const version = localTargetVersion(current);
      if (version) {
        const compat = entry.provider.checkCompatibility(current, { minecraftVersion: version });
        if (compat.recommendedMode === 'viaproxy') {
          throw Object.assign(new Error(compat.message), { status: 400, code: 'PROTOCOL_INCOMPATIBLE' });
        }
      }
    }
    if (compatibilityModeOf(current.compatibility_mode) === 'viaproxy') {
      const wanted = typeof entry.provider.getMetadata === 'function'
        ? entry.provider.getMetadata().viaproxyVersion
        : null;
      const jar = path.join(current.data_path, 'ViaProxy.jar');
      if (wanted && (!fs.existsSync(jar) || String(current.viaproxy_version || '') !== String(wanted))) {
        await installCompatibilityUnlocked(id, { confirmViaProxy: true, confirmModeSwitch: true });
      } else if (!fs.existsSync(jar)) {
        throw Object.assign(new Error('ViaProxy is not installed for this gateway. Install compatibility mode from the Geyser plugin first.'), { status: 400 });
      }
    }
    writeRuntimeFiles(get(id), entry.provider);
    removePluginBackups(get(id).data_path);
    killJavaInDirectory(get(id).data_path);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const spec = entry.provider.getLaunchSpecification(get(id));
    if (Array.isArray(spec.jvmArguments) && spec.jvmArguments.length) {
      throw Object.assign(new Error('Gateway providers cannot supply extra JVM arguments'), { status: 400 });
    }
    if (spec.javaBin || spec.executable || spec.bin || spec.command || spec.shell) {
      throw Object.assign(new Error('Gateway providers cannot choose an executable path or shell command'), { status: 400 });
    }
    const latest = get(id);
    const validated = javaLoaderHost.validateLaunchSpec(spec, latest.data_path);
    const javaBin = await javaRuntime.ensureJava({ major: spec.javaMajor || 21 });
    const args = javaLoaderHost.buildJavaArgs(spec);
    const { spawn: spawnPty } = require('node-pty');
    const pty = spawnPty(javaBin, args, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: validated.cwd,
      env: sanitizedChildEnv({
        ...(spec.environment || {}),
        JAVA_HOME: javaRuntime.javaHomeFromBin(javaBin),
      }),
    });
    persistGatewayLogs(latest.data_path, '');
    ptySessions.set(String(id), { pty, logs: '', stopping: false });
    pty.onData((chunk) => {
      const session = ptySessions.get(String(id));
      if (!session) return;
      const text = playerPresence.stripAnsi(chunk);
      session.logs = `${session.logs}${text}`.slice(-80000);
      persistGatewayLogs(latest.data_path, session.logs);
      if (global.io) global.io.to(`gateway-${id}`).emit('gateway-output', { gatewayId: id, data: text });
    });
    const exitSeen = new Promise((resolve) => {
      pty.onExit((info) => {
        const session = ptySessions.get(String(id));
        const stopping = Boolean(session?.stopping);
        const logText = session?.logs || readPersistedLogs(latest.data_path);
        persistGatewayLogs(latest.data_path, logText);
        ptySessions.delete(String(id));
        killJavaInDirectory(latest.data_path);
        if (stopping) {
          db.prepare(`UPDATE gateways SET status = 'stopped', health_status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
        } else {
          const message = logSnippet(logText, `Gateway process exited (code ${info?.exitCode ?? 'unknown'})`);
          db.prepare(`UPDATE gateways SET status = 'stopped', health_status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(message, id);
        }
        if (global.io) global.io.emit('gateway-status', { gatewayId: id, status: 'stopped' });
        pluginEvents.emit('gateway.stopped', { gatewayId: id });
        resolve(info || {});
      });
    });
    db.prepare(`UPDATE gateways SET status = 'running', health_status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    pluginAudit.record('gateway.start', { targetType: 'gateway', targetId: String(id), detail: { compatibilityMode: compatibilityModeOf(latest.compatibility_mode) } });
    pluginEvents.emit('gateway.started', { gatewayId: id });
    if (global.io) global.io.emit('gateway-status', { gatewayId: id, status: 'running' });
    const earlyExit = await Promise.race([
      exitSeen,
      new Promise((resolve) => setTimeout(() => resolve(null), 800)),
    ]);
    if (earlyExit) {
      const persisted = readPersistedLogs(latest.data_path);
      throw Object.assign(
        new Error(logSnippet(persisted, `Gateway process exited immediately (code ${earlyExit.exitCode ?? 'unknown'})`)),
        { status: 500 }
      );
    }
    return { success: true, message: 'Gateway starting...' };
  } catch (err) {
    db.prepare(`UPDATE gateways SET status = 'stopped', health_status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(String(err.message || err), id);
    if (global.io) global.io.emit('gateway-status', { gatewayId: id, status: 'stopped' });
    pluginEvents.emit('gateway.updated', { gatewayId: id });
    throw err;
  }
}

function stopNow(id) {
  const row = get(id);
  const session = ptySessions.get(String(id));
  if (session) {
    session.stopping = true;
    persistGatewayLogs(row?.data_path, session.logs);
    try { session.pty.kill(); } catch { /* ignore */ }
  }
  if (row?.data_path) killJavaInDirectory(row.data_path);
  db.prepare(`UPDATE gateways SET status = 'stopped', health_status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  pluginAudit.record('gateway.stop', { targetType: 'gateway', targetId: String(id) });
  pluginEvents.emit('gateway.stopped', { gatewayId: id });
  if (global.io) global.io.emit('gateway-status', { gatewayId: id, status: 'stopped' });
  return { success: true };
}

function stop(id) {
  assertLifecycleIdle(id);
  return stopNow(id);
}

async function restart(id) {
  return withLifecycle(id, async () => {
    stopNow(id);
    return startNow(id);
  });
}

function remove(id) {
  assertLifecycleIdle(id);
  const row = get(id);
  if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
  stopNow(id);
  unregisterGatewayPort(id);
  try {
    const attachments = require('./serverPluginAttachments');
    const pluginId = attachments.pluginIdForProvider(row.provider_id) || 'gateway-geyser';
    attachments.detachResource(pluginId, 'gateway', String(id));
  } catch { /* ignore */ }
  db.prepare('DELETE FROM gateways WHERE id = ?').run(id);
  db.prepare('DELETE FROM plugin_dashboard_snapshots WHERE entity_id = ?').run(`gateway:${id}`);
  try { fs.rmSync(row.data_path, { recursive: true, force: true }); } catch { /* ignore */ }
  pluginAudit.record('gateway.delete', { targetType: 'gateway', targetId: String(id), detail: { name: row.name } });
  pluginEvents.emit('gateway.deleted', { gatewayId: id });
  return { success: true };
}

function status(id) {
  const row = get(id);
  if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
  return {
    ...publicRecord(row),
    running: Boolean(ptySessions.get(String(id))),
  };
}

function logs(id) {
  const session = ptySessions.get(String(id));
  if (session?.logs) return { logs: session.logs };
  const row = get(id);
  return { logs: row?.data_path ? readPersistedLogs(row.data_path) : '' };
}

function forServer(serverId) {
  return db.prepare(`SELECT * FROM gateways WHERE target_server_id = ?`).all(serverId).map(publicRecord);
}

function detachServer(serverId) {
  try {
    return require('./serverPluginAttachments').detachServer(serverId);
  } catch {
    const rows = db.prepare(`SELECT * FROM gateways WHERE target_server_id = ?`).all(serverId);
    for (const row of rows) {
      try { stop(row.id); } catch { /* ignore */ }
      db.prepare(`
        UPDATE gateways
        SET target_server_id = NULL, unresolved_target = 1, unresolved_reason = 'server-deleted', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(row.id);
      pluginAudit.record('gateway.target.detached', {
        targetType: 'gateway',
        targetId: String(row.id),
        detail: { serverId },
      });
    }
    return rows.length;
  }
}

function runningForPlugin(pluginId) {
  const ids = new Set(
    gatewayRegistry.entries()
      .filter((entry) => entry.pluginId === pluginId)
      .map((entry) => entry.id)
  );
  return db.prepare('SELECT id, name, provider_id, status FROM gateways').all()
    .filter((row) => ids.has(row.provider_id) && (
      row.status === 'running'
      || row.status === 'starting'
      || ptySessions.has(String(row.id))
    ));
}

function integrationsForServer(server) {
  if (!server || server.kind !== 'java') return [];
  const associated = forServer(server.id);
  const items = [];
  for (const meta of gatewayRegistry.list()) {
    if (!(meta.targetKinds || []).includes('java')) continue;
    const pluginId = meta.managementPluginId || meta.pluginId;
    if (!pluginId) continue;
    const page = meta.managementPage && meta.managementPage !== 'home'
      ? `/${meta.managementPage}`
      : '';
    const mine = associated.filter((row) => row.provider_id === meta.id);
    if (mine.length) {
      for (const gateway of mine) {
        items.push({
          id: meta.id,
          name: meta.name,
          configured: true,
          status: gateway.status,
          summary: `Bedrock UDP ${gateway.bedrock_udp_port}`,
          action: 'manage',
          href: `/plugins/${pluginId}${page}?gatewayId=${encodeURIComponent(gateway.id)}`,
        });
      }
    } else if (meta.supportsCreateForTarget) {
      items.push({
        id: meta.id,
        name: meta.name,
        configured: false,
        status: null,
        summary: 'Bedrock gateway not configured',
        action: 'configure',
        href: `/plugins/${pluginId}${page}?targetServerId=${encodeURIComponent(server.id)}`,
      });
    }
  }
  return items;
}

async function floodgateStatus(id) {
  const row = get(id);
  if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
  const entry = gatewayRegistry.requireGateway(row.provider_id);
  const server = row.target_type === 'local-server' && row.target_server_id
    ? db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(row.target_server_id, 'java')
    : null;
  if (typeof entry.provider.floodgateStatus !== 'function') {
    return { canStart: true, summary: [], target: {} };
  }
  return entry.provider.floodgateStatus({ gateway: row, server });
}

function stopAll() {
  for (const id of [...ptySessions.keys()]) {
    try { stop(id); } catch { /* ignore */ }
  }
}

async function restoreRunning() {
  const javaHostingPolicy = require('./javaHostingPolicy');
  const rows = db.prepare(`SELECT id FROM gateways WHERE status IN ('running', 'starting')`).all();
  if (!javaHostingPolicy.isJavaHostingAvailable()) {
    for (const row of rows) {
      try { stop(row.id); } catch (err) {
        logger.warn(`Could not stop leftover gateway ${row.id} while Java Hosting is disabled: ${err.message}`);
      }
      db.prepare(`UPDATE gateways SET status = 'stopped', health_status = 'stopped' WHERE id = ?`).run(row.id);
    }
    return;
  }
  for (const row of rows) {
    db.prepare(`UPDATE gateways SET status = 'stopped' WHERE id = ?`).run(row.id);
    try { await start(row.id); } catch (err) {
      logger.warn(`Could not restore gateway ${row.id}: ${err.message}`);
    }
  }
}

module.exports = {
  allocateUdpPort,
  suggestUdpPort,
  checkCompatibility,
  copyFloodgateKeyToLocalServer,
  create,
  detachServer,
  ensureFloodgateKey,
  floodgateStatus,
  forServer,
  get,
  installCompatibility,
  installFloodgate,
  integrationsForServer,
  list,
  logs,
  patch,
  publicRecord,
  remove,
  removeCompatibility,
  restart,
  isActive,
  restoreRunning,
  runningForPlugin,
  start,
  status,
  stop,
  stopAll,
  syncLocalTargetPort,
  takenPorts,
  writeFloodgateKey,
  applySettings,
  exportFloodgateKey,
  planSettingsChange,
};
