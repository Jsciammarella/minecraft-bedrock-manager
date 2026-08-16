const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const logger = require('./logger');
const connectHost = require('./connectHost');

const LIST_NAME = 'custom_servers.json';
const RELOAD_DELAY_MS = 750;

let reloadTimer = null;
let reloading = false;

function listPathFor(server) {
  if (!server?.data_path) return '';
  return path.join(server.data_path, LIST_NAME);
}

function gameServers() {
  return db.prepare(`
    SELECT id, name, port
    FROM servers
    WHERE kind IS NULL OR kind != 'bedrock_connect'
    ORDER BY name COLLATE NOCASE
  `).all();
}

function buildEntries() {
  const address = connectHost.resolve();
  return gameServers().map((server) => ({
    name: String(server.name || 'Bedrock Server'),
    address,
    port: Number(server.port),
  }));
}

function serialize(entries) {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

function writeList() {
  const serverManager = require('./serverManager');
  const bc = serverManager.getBedrockConnectServer();
  if (!bc) {
    return { written: false, changed: false, path: '', servers: [] };
  }

  fs.mkdirSync(bc.data_path, { recursive: true });
  const filePath = listPathFor(bc);
  const entries = buildEntries();
  const next = serialize(entries);
  let previous = '';
  try {
    previous = fs.readFileSync(filePath, 'utf8');
  } catch {
    previous = '';
  }
  const changed = previous !== next;
  if (changed) fs.writeFileSync(filePath, next);
  return { written: true, changed, path: filePath, servers: entries };
}

function spawnArgs(dataPath) {
  const filePath = path.join(dataPath, LIST_NAME);
  return [
    'nodb=true',
    'port=19132',
    'bindip=0.0.0.0',
    'featured_servers=false',
    'user_servers=true',
    `custom_servers=${filePath}`,
  ];
}

function canRestartRunning(bc, serverManager) {
  if (!bc || !serverManager.isBedrockConnect(bc)) return false;
  if (bc.status !== 'running') return false;
  return serverManager.ptySessions.has(String(bc.id));
}

async function reloadIfRunning() {
  const serverManager = require('./serverManager');
  const bc = serverManager.getBedrockConnectServer();
  if (!canRestartRunning(bc, serverManager) || reloading) return;
  reloading = true;
  try {
    const latest = serverManager.getBedrockConnectServer();
    if (!canRestartRunning(latest, serverManager)) return;
    logger.info('Restarting Bedrock Connect so the in-game server list matches the manager');
    await serverManager.restartServer(latest.id);
  } catch (err) {
    logger.warn(`Bedrock Connect list reload failed: ${err.message}`);
  } finally {
    reloading = false;
  }
}

function sync({ reload = true } = {}) {
  const result = writeList();
  if (!result.written || !result.changed || !reload) return result;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadIfRunning().catch((err) => {
      logger.warn(`Bedrock Connect list reload failed: ${err.message}`);
    });
  }, RELOAD_DELAY_MS);
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
  }, RELOAD_DELAY_MS);
}

module.exports = {
  LIST_NAME,
  buildEntries,
  listPathFor,
  spawnArgs,
  writeList,
  sync,
  scheduleSync,
};
