const db = require('../db/connection');
const logger = require('./logger');
const serverEditionRegistry = require('./serverEditionRegistry');

const JAVA_EDITION = 'java';
const DISABLED_CODE = 'JAVA_HOSTING_DISABLED';
const CONFIRM_CODE = 'JAVA_HOSTING_DISABLE_CONFIRM';
const DISABLED_MESSAGE = 'Minecraft Java Hosting is not enabled.';

let disabling = false;
let disableLock = null;

function disabledError(action) {
  const err = new Error(DISABLED_MESSAGE);
  err.status = 409;
  err.code = DISABLED_CODE;
  err.action = action || null;
  return err;
}

function notFoundError() {
  const err = new Error('Server not found');
  err.status = 404;
  return err;
}

function isDisabling() {
  return disabling === true;
}

function isAvailable(editionId = JAVA_EDITION) {
  const id = String(editionId || '').trim().toLowerCase();
  if (id === 'bedrock' || id === 'remote') return true;
  if (id === JAVA_EDITION) return Boolean(serverEditionRegistry.get(JAVA_EDITION)) && !disabling;
  if (id === 'bedrock-connect' || id === 'bedrock_connect') {
    try {
      return require('./bedrockConnectPolicy').isBedrockConnectAvailable();
    } catch {
      return false;
    }
  }
  return Boolean(serverEditionRegistry.get(id));
}

function isJavaHostingAvailable() {
  return isAvailable(JAVA_EDITION);
}

function assertServerEditionAvailable(editionId, action) {
  if (isAvailable(editionId)) return true;
  throw disabledError(action);
}

function isHiddenServer(server) {
  if (!server) return false;
  if (String(server.kind || '') === 'java') return !isJavaHostingAvailable();
  if (String(server.kind || '') === 'bedrock_connect') {
    try {
      return !require('./bedrockConnectPolicy').isBedrockConnectAvailable();
    } catch {
      return true;
    }
  }
  return false;
}

function isHiddenGateway() {
  return !isJavaHostingAvailable();
}

function filterVisibleServers(servers) {
  return (servers || []).filter((server) => !isHiddenServer(server));
}

function assertServerVisible(server) {
  if (!server || isHiddenServer(server)) throw notFoundError();
  return server;
}

function listEditions() {
  const editions = serverEditionRegistry.CORE_EDITIONS.map((item) => ({ ...item }));
  for (const entry of serverEditionRegistry.listRegistered()) {
    const available = isAvailable(entry.id);
    if (!available) continue;
    editions.push({
      ...entry,
      available: true,
    });
  }
  return editions;
}

function countNoun(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function disableImpact() {
  const javaServers = db.prepare(`SELECT id, name, status FROM servers WHERE kind = 'java'`).all();
  const gateways = db.prepare(`SELECT id, name, status FROM gateways`).all();
  const runningJava = javaServers.filter((row) => row.status === 'running' || row.status === 'starting');
  const runningGateways = gateways.filter((row) => row.status === 'running' || row.status === 'starting');
  const creatingJava = javaServers.filter((row) => row.status === 'creating');
  let message;
  if (runningJava.length === 0 && runningGateways.length === 0) {
    message = 'Disabling Minecraft Java Hosting will hide Java servers and Geyser gateways from the dashboard. No server data will be deleted.';
  } else {
    const parts = [];
    if (runningJava.length) parts.push(countNoun(runningJava.length, 'Java server', 'Java servers'));
    if (runningGateways.length) parts.push(countNoun(runningGateways.length, 'Geyser gateway', 'Geyser gateways'));
    message = `Disabling Minecraft Java Hosting will stop ${parts.join(' and ')} and hide them from the dashboard. No server data will be deleted.`;
  }
  return {
    pluginId: serverEditionRegistry.get(JAVA_EDITION)?.pluginId || 'server-edition-java',
    editionId: JAVA_EDITION,
    javaServers: javaServers.length,
    runningJavaServers: runningJava.length,
    creatingJavaServers: creatingJava.length,
    geyserGateways: gateways.length,
    runningGeyserGateways: runningGateways.length,
    javaNames: runningJava.map((row) => row.name),
    gatewayNames: runningGateways.map((row) => row.name),
    message,
  };
}

function confirmError(impact) {
  const err = new Error(impact.message);
  err.status = 409;
  err.code = CONFIRM_CODE;
  err.impact = impact;
  return err;
}

function failureError(failures) {
  const labels = failures.map((item) => item.name || `${item.type} ${item.id}`);
  const err = new Error(
    `Minecraft Java Hosting could not be disabled because these processes are still running: ${labels.join(', ')}.`
  );
  err.status = 409;
  err.code = 'JAVA_HOSTING_DISABLE_FAILED';
  err.failures = failures;
  return err;
}

function markDisabling() {
  disabling = true;
}

function clearDisabling() {
  disabling = false;
  disableLock = null;
}

async function cancelJavaProvisioning(serverManager) {
  if (typeof serverManager.cancelJavaProvisioning === 'function') {
    await serverManager.cancelJavaProvisioning();
  }
}

function stillActiveJava(serverManager, row) {
  if (!row) return false;
  if (serverManager.ptySessions?.has(String(row.id))) return true;
  const current = serverManager.getServer(row.id);
  return Boolean(current && (current.status === 'running' || current.status === 'starting'));
}

function stillActiveGateway(gatewayManager, row) {
  if (!row) return false;
  if (typeof gatewayManager.isActive === 'function' && gatewayManager.isActive(row.id)) return true;
  const current = typeof gatewayManager.get === 'function' ? gatewayManager.get(row.id) : null;
  return Boolean(current && (current.status === 'running' || current.status === 'starting'));
}

async function performDisable() {
  if (disableLock) return disableLock;
  const work = (async () => {
    markDisabling();
    const serverManager = require('./serverManager');
    const gatewayManager = require('./gatewayManager');
    const pluginEvents = require('./pluginEvents');
    const stopOrder = [];
    try {
      await cancelJavaProvisioning(serverManager);

      const gateways = db.prepare(`SELECT id, name, status FROM gateways`).all();
      const failures = [];
      for (const row of gateways) {
        if (row.status === 'stopped' && !(typeof gatewayManager.isActive === 'function' && gatewayManager.isActive(row.id))) {
          continue;
        }
        try {
          stopOrder.push(`gateway:${row.id}`);
          gatewayManager.stop(row.id);
        } catch (err) {
          failures.push({ type: 'gateway', id: row.id, name: row.name, error: err.message });
        }
      }

      const javaServers = db.prepare(`SELECT id, name, status FROM servers WHERE kind = 'java'`).all();
      for (const row of javaServers) {
        const current = serverManager.getServer(row.id);
        if (!current) continue;
        if (current.status === 'stopped' && !serverManager.ptySessions?.has(String(row.id))) continue;
        if (current.status === 'creating') continue;
        try {
          stopOrder.push(`java:${row.id}`);
          await serverManager.stopServer(row.id);
        } catch (err) {
          if (!/already stopped/i.test(err.message || '')) {
            failures.push({ type: 'java', id: row.id, name: row.name, error: err.message });
          }
        }
      }

      for (const row of db.prepare(`SELECT id, name, status FROM gateways`).all()) {
        if (stillActiveGateway(gatewayManager, row)) {
          failures.push({ type: 'gateway', id: row.id, name: row.name, error: 'Gateway process is still running' });
        }
      }
      for (const row of db.prepare(`SELECT id, name, status FROM servers WHERE kind = 'java'`).all()) {
        if (stillActiveJava(serverManager, row)) {
          failures.push({ type: 'java', id: row.id, name: row.name, error: 'Java server process is still running' });
        }
      }

      if (failures.length) {
        clearDisabling();
        throw failureError(failures);
      }

      try { require('./pluginDashboard').snapshotAllGateways(); } catch { /* ignore */ }
      pluginEvents.emit('java-hosting.disabled', { stopOrder });
      return { ok: true, stopOrder };
    } catch (err) {
      if (err.code !== 'JAVA_HOSTING_DISABLE_FAILED') clearDisabling();
      throw err;
    }
  })();
  disableLock = work;
  try {
    return await work;
  } finally {
    if (disableLock === work && !disabling) disableLock = null;
  }
}

function completeDisable() {
  disabling = false;
  disableLock = null;
}

async function reconcileOnStartup() {
  if (isJavaHostingAvailable()) return { available: true };
  const gatewayManager = require('./gatewayManager');
  const rows = db.prepare(`SELECT id, status FROM gateways`).all();
  for (const row of rows) {
    if (row.status === 'running' || row.status === 'starting') {
      try { gatewayManager.stop(row.id); } catch (err) {
        logger.warn(`Could not stop leftover gateway ${row.id} while Java Hosting is disabled: ${err.message}`);
      }
    }
  }
  db.prepare(`
    UPDATE gateways
    SET status = 'stopped', health_status = 'stopped', updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('running', 'starting')
  `).run();
  logger.info('Java Hosting is unavailable; leftover Geyser/ViaProxy processes will not autostart');
  return { available: false };
}

function resetForTests() {
  disabling = false;
  disableLock = null;
}

function redactPortName(serverKind, name) {
  if (serverKind === 'java' && !isJavaHostingAvailable()) return 'Reserved';
  return name;
}

module.exports = {
  CONFIRM_CODE,
  DISABLED_CODE,
  DISABLED_MESSAGE,
  JAVA_EDITION,
  assertServerEditionAvailable,
  assertServerVisible,
  clearDisabling,
  completeDisable,
  confirmError,
  disableImpact,
  disabledError,
  filterVisibleServers,
  isAvailable,
  isDisabling,
  isHiddenGateway,
  isHiddenServer,
  isJavaHostingAvailable,
  listEditions,
  markDisabling,
  performDisable,
  reconcileOnStartup,
  redactPortName,
  resetForTests,
};
