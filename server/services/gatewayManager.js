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

const BASE_DIR = path.join(__dirname, '../../data/gateways');
const ptySessions = new Map();

function publicRecord(row) {
  if (!row) return null;
  const entry = gatewayRegistry.get(row.provider_id);
  const sanitized = entry?.provider.sanitizePublicRecord
    ? entry.provider.sanitizePublicRecord(row)
    : { ...row, floodgate_key_path: undefined };
  delete sanitized.floodgate_key_path;
  return {
    ...sanitized,
    notices: entry ? (gatewayRegistry.publicMetadata(entry).notices || []) : [],
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

function registerGatewayPort(gatewayId, port) {
  db.prepare(`
    INSERT OR REPLACE INTO port_usage (port, server_id, gateway_id, protocol, family, in_use)
    VALUES (?, NULL, ?, 'udp', 'ipv4', 1)
  `).run(port, gatewayId);
}

function unregisterGatewayPort(gatewayId) {
  db.prepare('DELETE FROM port_usage WHERE gateway_id = ?').run(gatewayId);
}

function assertAuth(config) {
  const auth = String(config.authentication || 'online').toLowerCase();
  if (!['online', 'floodgate', 'offline'].includes(auth)) {
    throw Object.assign(new Error('Authentication must be online, floodgate, or offline'), { status: 400 });
  }
  if (auth === 'offline' && !config.confirmOffline) {
    throw Object.assign(new Error('Offline authentication requires an explicit security confirmation'), { status: 400 });
  }
  if (auth === 'floodgate' && config.targetType === 'remote-address' && !config.confirmFloodgate) {
    throw Object.assign(new Error('Remote Floodgate targets require confirmation that Floodgate is installed on the Java server'), { status: 400 });
  }
  return auth;
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

function writeFloodgateKey(dir) {
  const keyPath = path.join(dir, 'key.pem');
  const key = crypto.randomBytes(16).toString('base64');
  fs.writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* ignore */ }
  return keyPath;
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
  const dataPath = path.join(BASE_DIR, name.replace(/[^a-zA-Z0-9._-]/g, '_'));
  fs.mkdirSync(dataPath, { recursive: true });
  const result = db.prepare(`
    INSERT INTO gateways (
      provider_id, name, bedrock_listen_address, bedrock_udp_port, target_type,
      target_server_id, target_host, target_tcp_port, authentication, status, data_path,
      offline_confirmed, floodgate_confirmed, java_major
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, 21)
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
    dataPath,
    auth === 'offline' ? 1 : 0,
    auth === 'floodgate' ? 1 : 0
  );
  const id = result.lastInsertRowid;
  registerGatewayPort(id, port);
  try {
    const plan = await entry.provider.planInstallation({ geyserVersion: config.geyserVersion || 'latest' });
    await javaLoaderHost.executeInstallPlan(plan, {
      serverDir: dataPath,
      allowHosts: entry.downloadHosts,
      ownerId: id,
    });
    let floodgateKeyPath = null;
    if (auth === 'floodgate') floodgateKeyPath = writeFloodgateKey(dataPath);
    const row = get(id);
    const configurationPath = writeConfig({ ...row, floodgate_key_path: floodgateKeyPath }, entry.provider);
    db.prepare(`
      UPDATE gateways SET status = 'stopped', configuration_path = ?, floodgate_key_path = ?, geyser_version = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(configurationPath, floodgateKeyPath, plan.result?.geyserVersion || 'latest', id);
    pluginAudit.record('gateway.create', {
      targetType: 'gateway',
      targetId: String(id),
      detail: { name, providerId, targetType: target.targetType, authentication: auth, port },
    });
    return publicRecord(get(id));
  } catch (err) {
    unregisterGatewayPort(id);
    db.prepare('DELETE FROM gateways WHERE id = ?').run(id);
    throw err;
  }
}

function patch(id, config) {
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
  if (auth === 'floodgate' && !row.floodgate_key_path) {
    row.floodgate_key_path = writeFloodgateKey(row.data_path);
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
  writeConfig(next, entry.provider);
  pluginAudit.record('gateway.update', { targetType: 'gateway', targetId: String(id), detail: { authentication: auth } });
  return publicRecord(get(id));
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
  const row = get(id);
  if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
  if (row.status === 'running' || row.status === 'starting') {
    throw Object.assign(new Error('Gateway already running'), { status: 400 });
  }
  const entry = gatewayRegistry.requireGateway(row.provider_id);
  if (row.target_type === 'local-server') {
    const server = db.prepare('SELECT id FROM servers WHERE id = ? AND kind = ?').get(row.target_server_id, 'java');
    if (!server) {
      throw Object.assign(new Error('The associated Java server no longer exists. Choose a new target before starting this gateway.'), { status: 400 });
    }
  }
  const spec = entry.provider.getLaunchSpecification(row);
  if (spec.javaBin || spec.executable || spec.bin || spec.command || spec.shell) {
    throw Object.assign(new Error('Gateway providers cannot choose an executable path or shell command'), { status: 400 });
  }
  const validated = javaLoaderHost.validateLaunchSpec(spec, row.data_path);
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
  ptySessions.set(String(id), { pty, logs: '' });
  pty.onData((chunk) => {
    const session = ptySessions.get(String(id));
    if (!session) return;
    session.logs = `${session.logs}${chunk}`.slice(-80000);
    if (global.io) global.io.to(`gateway-${id}`).emit('gateway-output', { gatewayId: id, data: chunk });
  });
  pty.onExit(() => {
    ptySessions.delete(String(id));
    db.prepare(`UPDATE gateways SET status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    if (global.io) global.io.emit('gateway-status', { gatewayId: id, status: 'stopped' });
  });
  db.prepare(`UPDATE gateways SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  pluginAudit.record('gateway.start', { targetType: 'gateway', targetId: String(id) });
  return { success: true, message: 'Gateway starting...' };
}

function stop(id) {
  const session = ptySessions.get(String(id));
  if (session) {
    try { session.pty.kill(); } catch { /* ignore */ }
    ptySessions.delete(String(id));
  }
  db.prepare(`UPDATE gateways SET status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  pluginAudit.record('gateway.stop', { targetType: 'gateway', targetId: String(id) });
  return { success: true };
}

async function restart(id) {
  stop(id);
  return start(id);
}

function remove(id) {
  const row = get(id);
  if (!row) throw Object.assign(new Error('Gateway not found'), { status: 404 });
  stop(id);
  unregisterGatewayPort(id);
  db.prepare('DELETE FROM gateways WHERE id = ?').run(id);
  pluginAudit.record('gateway.delete', { targetType: 'gateway', targetId: String(id), detail: { name: row.name } });
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
  return { logs: session?.logs || '' };
}

function forServer(serverId) {
  return db.prepare(`SELECT * FROM gateways WHERE target_server_id = ?`).all(serverId).map(publicRecord);
}

function detachServer(serverId) {
  const rows = db.prepare(`SELECT * FROM gateways WHERE target_server_id = ?`).all(serverId);
  for (const row of rows) {
    try { stop(row.id); } catch { /* ignore */ }
    db.prepare(`
      UPDATE gateways
      SET target_server_id = NULL, updated_at = CURRENT_TIMESTAMP
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

function stopAll() {
  for (const id of [...ptySessions.keys()]) {
    try { stop(id); } catch { /* ignore */ }
  }
}

async function restoreRunning() {
  const rows = db.prepare(`SELECT id FROM gateways WHERE status IN ('running', 'starting')`).all();
  for (const row of rows) {
    db.prepare(`UPDATE gateways SET status = 'stopped' WHERE id = ?`).run(row.id);
    try { await start(row.id); } catch (err) {
      logger.warn(`Could not restore gateway ${row.id}: ${err.message}`);
    }
  }
}

module.exports = {
  allocateUdpPort,
  create,
  detachServer,
  forServer,
  get,
  integrationsForServer,
  list,
  logs,
  patch,
  publicRecord,
  remove,
  restart,
  restoreRunning,
  runningForPlugin,
  start,
  status,
  stop,
  stopAll,
  syncLocalTargetPort,
  takenPorts,
};
