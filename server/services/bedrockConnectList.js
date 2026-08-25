const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const logger = require('./logger');
const connectHost = require('./connectHost');

const LIST_NAME = 'custom_servers.json';
const SERVER_LIMIT = 100;
const SERVER_LIMIT_ARG = `server_limit=${SERVER_LIMIT}`;
const DEFAULT_RELOAD_DELAY_MS = 750;

let reloadDelayMs = DEFAULT_RELOAD_DELAY_MS;
let reloadTimer = null;
let loopRunning = false;
let refreshPending = false;
let restartInProgress = false;
let desiredListGeneration = 0;
let loadedListGeneration = 0;
let lastHash = '';
let lastPath = '';
let lastCount = 0;

function listPathFor(server) {
  if (!server?.data_path) return '';
  return path.join(server.data_path, LIST_NAME);
}

function hashContent(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function gameServers() {
  return db.prepare(`
    SELECT id, name, port
    FROM servers
    WHERE (kind IS NULL OR kind NOT IN ('bedrock_connect', 'java'))
    ORDER BY name COLLATE NOCASE
  `).all();
}

function buildEntries() {
  const address = connectHost.resolve();
  const entries = gameServers().map((server) => ({
    name: String(server.name || 'Bedrock Server'),
    address,
    port: Number(server.port),
  }));
  const seen = new Set(entries.map((item) => `${String(item.address).toLowerCase()}:${item.port}`));
  try {
    const extra = require('./pluginAdvertisements').list();
    for (const endpoint of extra) {
      const key = `${String(endpoint.address).toLowerCase()}:${endpoint.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(endpoint);
    }
  } catch (err) {
    logger.warn(`Plugin Bedrock Connect advertisements skipped: ${err.message}`);
  }
  return entries;
}

function serialize(entries) {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

function selectEntries(entries) {
  if (entries.length <= SERVER_LIMIT) {
    return { entries, truncated: false, warning: null };
  }
  const warning = `Bedrock Connect supports at most ${SERVER_LIMIT} advertised servers; using the first ${SERVER_LIMIT} of ${entries.length} (sorted by name, then plugin advertisements)`;
  logger.warn(warning);
  return {
    entries: entries.slice(0, SERVER_LIMIT),
    truncated: true,
    warning,
  };
}

function writeList() {
  const serverManager = require('./serverManager');
  const bc = serverManager.getBedrockConnectServer();
  if (!bc) {
    return {
      written: false,
      changed: false,
      path: '',
      servers: [],
      hash: '',
      generation: desiredListGeneration,
      truncated: false,
      warning: null,
    };
  }

  fs.mkdirSync(bc.data_path, { recursive: true });
  const filePath = listPathFor(bc);
  const selected = selectEntries(buildEntries());
  const next = serialize(selected.entries);
  const nextHash = hashContent(next);
  let previous = '';
  try {
    previous = fs.readFileSync(filePath, 'utf8');
  } catch {
    previous = '';
  }
  const changed = previous !== next;
  if (changed) fs.writeFileSync(filePath, next);
  const generationChanged = changed || nextHash !== lastHash;
  if (generationChanged) desiredListGeneration += 1;
  lastHash = nextHash;
  lastPath = filePath;
  lastCount = selected.entries.length;
  if (generationChanged) {
    logger.info('Bedrock Connect list written', {
      generation: desiredListGeneration,
      hash: nextHash,
      count: selected.entries.length,
      path: filePath,
      truncated: selected.truncated,
    });
  }
  return {
    written: true,
    changed,
    path: filePath,
    servers: selected.entries,
    hash: nextHash,
    generation: desiredListGeneration,
    truncated: selected.truncated,
    warning: selected.warning,
  };
}

function spawnArgs(dataPath) {
  const filePath = path.join(dataPath, LIST_NAME);
  return [
    'nodb=true',
    'port=19132',
    'bindip=0.0.0.0',
    'featured_servers=false',
    'user_servers=true',
    SERVER_LIMIT_ARG,
    `custom_servers=${filePath}`,
  ];
}

function snapshot() {
  return {
    desiredListGeneration,
    loadedListGeneration,
    restartInProgress,
    refreshPending,
    loopRunning,
    lastHash,
    lastPath,
    lastCount,
  };
}

function recordLoaded(generation, hash) {
  loadedListGeneration = Number(generation) || loadedListGeneration;
  if (hash) lastHash = hash;
  logger.info('List generation loaded by the active process', {
    loadedListGeneration,
    hash: hash || lastHash,
    count: lastCount,
    path: lastPath,
  });
}

function setRestartInProgress(value) {
  restartInProgress = Boolean(value);
}

async function runSyncLoop() {
  if (loopRunning) {
    refreshPending = true;
    logger.info('Restart coalesced because one is already active', snapshot());
    return;
  }
  loopRunning = true;
  try {
    let iterations = 0;
    while (refreshPending && iterations < 8) {
      refreshPending = false;
      iterations += 1;
      const written = writeList();
      if (!written.written) return;
      const lifecycle = require('./bedrockConnectLifecycle');
      await lifecycle.syncRunningProcess(written);
      const latest = writeList();
      if (refreshPending) continue;
      const session = lifecycle.currentSession();
      if (session && session.listHash === latest.hash) {
        loadedListGeneration = session.listGeneration;
        return;
      }
      if (latest.hash !== written.hash) {
        refreshPending = true;
      }
    }
    if (iterations >= 8) {
      logger.warn('Bedrock Connect list sync stopped after repeated restarts', snapshot());
    }
  } catch (err) {
    logger.warn(`Bedrock Connect list reload failed: ${err.message}`);
  } finally {
    loopRunning = false;
    if (refreshPending) {
      setImmediate(() => {
        runSyncLoop().catch((err) => {
          logger.warn(`Bedrock Connect list reload failed: ${err.message}`);
        });
      });
    }
  }
}

function requestRefresh() {
  refreshPending = true;
  if (loopRunning) {
    logger.info('Restart coalesced because one is already active', snapshot());
    return;
  }
  runSyncLoop().catch((err) => {
    logger.warn(`Bedrock Connect list reload failed: ${err.message}`);
  });
}

function sync({ reload = true } = {}) {
  const result = writeList();
  if (!result.written || !reload) return result;
  if (!result.changed && loadedListGeneration === result.generation) return result;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => requestRefresh(), reloadDelayMs);
  return result;
}

function scheduleSync() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    try {
      sync({ reload: true });
    } catch (err) {
      logger.warn(`Bedrock Connect list sync failed: ${err.message}`);
    }
  }, reloadDelayMs);
}

function setReloadDelayMs(ms) {
  reloadDelayMs = Math.max(0, Number(ms) || 0);
}

function resetForTests() {
  clearTimeout(reloadTimer);
  reloadTimer = null;
  loopRunning = false;
  refreshPending = false;
  restartInProgress = false;
  desiredListGeneration = 0;
  loadedListGeneration = 0;
  lastHash = '';
  lastPath = '';
  lastCount = 0;
  reloadDelayMs = DEFAULT_RELOAD_DELAY_MS;
}

module.exports = {
  LIST_NAME,
  SERVER_LIMIT,
  SERVER_LIMIT_ARG,
  buildEntries,
  listPathFor,
  recordLoaded,
  requestRefresh,
  resetForTests,
  scheduleSync,
  setReloadDelayMs,
  setRestartInProgress,
  snapshot,
  spawnArgs,
  sync,
  writeList,
};
