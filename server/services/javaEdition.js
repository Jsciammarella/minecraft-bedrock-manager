const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const db = require('../db/connection');
const logger = require('./logger');
const platform = require('./platform');

const execFileAsync = promisify(execFile);

const KIND = 'java';
const DISPLAY_NAME = 'Java';
const JAR_NAME = 'server.jar';
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const EULA_URL = 'https://aka.ms/MinecraftEULA';
const DEFAULT_PORT = 25565;
const MAX_LISTED_VERSIONS = 30;
const RELEASES_DIR = path.join(__dirname, '../../data/java-edition/releases');
const INDEX_PATH = path.join(__dirname, '../../data/java-edition/index.json');

const BOOLEAN_KEYS = new Set([
  'pvp',
  'allow_nether',
  'allow_flight',
  'enable_command_block',
  'hardcore',
  'force_gamemode',
  'spawn_animals',
  'spawn_npcs',
  'spawn_monsters',
  'generate_structures',
  'hide_online_players',
  'enforce_whitelist',
  'require_resource_pack',
  'broadcast_console_to_ops',
  'enable_rcon',
  'enable_query',
  'sync_chunk_writes',
  'prevent_proxy_connections',
  'enforce_secure_profile',
  'enable_status',
]);

const DEFAULTS = {
  pvp: 1,
  spawn_protection: '16',
  simulation_distance: '10',
  allow_nether: 1,
  allow_flight: 0,
  enable_command_block: 0,
  hardcore: 0,
  force_gamemode: 0,
  spawn_animals: 1,
  spawn_npcs: 1,
  spawn_monsters: 1,
  generate_structures: 1,
  hide_online_players: 0,
  enforce_whitelist: 0,
  network_compression_threshold: '256',
  resource_pack: '',
  resource_pack_sha1: '',
  require_resource_pack: 0,
  function_permission_level: '2',
  op_permission_level: '4',
  broadcast_console_to_ops: 1,
  enable_rcon: 0,
  rcon_port: '25575',
  rcon_password: '',
  enable_query: 0,
  query_port: '',
  sync_chunk_writes: 1,
  prevent_proxy_connections: 0,
  entity_broadcast_range_percentage: '100',
  enforce_secure_profile: 1,
  level_type: 'minecraft:normal',
  max_world_size: '29999984',
  enable_status: 1,
  view_distance: '10',
  player_idle_timeout: '0',
};

const PROPERTY_MAP = {
  max_players: 'max-players',
  difficulty: 'difficulty',
  gamemode: 'gamemode',
  whitelist_mode: 'white-list',
  server_motd: 'motd',
  server_description: 'motd',
  online_mode: 'online-mode',
  view_distance: 'view-distance',
  player_idle_timeout: 'player-idle-timeout',
  level_seed: 'level-seed',
  pvp: 'pvp',
  spawn_protection: 'spawn-protection',
  simulation_distance: 'simulation-distance',
  allow_nether: 'allow-nether',
  allow_flight: 'allow-flight',
  enable_command_block: 'enable-command-block',
  hardcore: 'hardcore',
  force_gamemode: 'force-gamemode',
  spawn_animals: 'spawn-animals',
  spawn_npcs: 'spawn-npcs',
  spawn_monsters: 'spawn-monsters',
  generate_structures: 'generate-structures',
  hide_online_players: 'hide-online-players',
  enforce_whitelist: 'enforce-whitelist',
  network_compression_threshold: 'network-compression-threshold',
  resource_pack: 'resource-pack',
  resource_pack_sha1: 'resource-pack-sha1',
  require_resource_pack: 'require-resource-pack',
  function_permission_level: 'function-permission-level',
  op_permission_level: 'op-permission-level',
  broadcast_console_to_ops: 'broadcast-console-to-ops',
  enable_rcon: 'enable-rcon',
  rcon_port: 'rcon.port',
  rcon_password: 'rcon.password',
  enable_query: 'enable-query',
  query_port: 'query.port',
  sync_chunk_writes: 'sync-chunk-writes',
  prevent_proxy_connections: 'prevent-proxy-connections',
  entity_broadcast_range_percentage: 'entity-broadcast-range-percentage',
  enforce_secure_profile: 'enforce-secure-profile',
  level_type: 'level-type',
  max_world_size: 'max-world-size',
  enable_status: 'enable-status',
};

const SETTING_KEYS = Object.keys(DEFAULTS);

const PERMISSIONS = [
  {
    key: 'servers.create_java',
    category: 'servers',
    edition: 'java',
    name: 'Create a Java server',
    description: 'Allow the user to create a Minecraft Java Edition server',
  },
  {
    key: 'servers.start_java',
    category: 'servers',
    edition: 'java',
    name: 'Start a Java server',
    description: 'Allow the user to start a Minecraft Java Edition server',
  },
  {
    key: 'servers.stop_java',
    category: 'servers',
    edition: 'java',
    name: 'Stop a Java server',
    description: 'Allow the user to stop a Minecraft Java Edition server',
  },
  {
    key: 'servers.change_java_settings',
    category: 'servers',
    edition: 'java',
    name: 'Change Java-only settings',
    description: 'Allow the user to change Java Edition-only server properties (PvP, simulation distance, RCON, ops, and related options)',
  },
];

function isJava(server) {
  return Boolean(server && server.kind === KIND);
}

function ensureDirs() {
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
}

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return { versions: [] };
  }
}

function writeIndex(index) {
  ensureDirs();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

function jarPathFor(version) {
  const safe = String(version || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(RELEASES_DIR, `${safe}.jar`);
}

function jarPath(serverDir) {
  return path.join(serverDir, JAR_NAME);
}

function memoryFlag(name, fallback) {
  const raw = String(process.env[name] || fallback).trim();
  return raw || fallback;
}

function spawnArgs(serverDir) {
  return [
    `-Xms${memoryFlag('MC_MANAGER_JAVA_XMS', '1G')}`,
    `-Xmx${memoryFlag('MC_MANAGER_JAVA_XMX', '2G')}`,
    '-jar',
    jarPath(serverDir),
    'nogui',
  ];
}

function isTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function toStoredValue(key, value) {
  if (value == null) return null;
  if (BOOLEAN_KEYS.has(key)) return isTruthy(value) ? '1' : '0';
  return String(value);
}

function toFormValue(key, value) {
  if (BOOLEAN_KEYS.has(key)) return isTruthy(value) ? 1 : 0;
  return value == null ? DEFAULTS[key] : String(value);
}

function readSettings(serverId) {
  const rows = db.prepare(
    'SELECT setting_key, setting_value FROM server_settings WHERE server_id = ?'
  ).all(serverId);
  const stored = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
  const result = {};
  for (const key of SETTING_KEYS) {
    result[key] = toFormValue(key, stored[key] ?? DEFAULTS[key]);
  }
  return result;
}

function writeSettings(serverId, values = {}) {
  const upsert = db.prepare(`
    INSERT INTO server_settings (server_id, setting_key, setting_value)
    VALUES (?, ?, ?)
    ON CONFLICT(server_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value
  `);
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (!SETTING_KEYS.includes(key) || value == null) continue;
      upsert.run(serverId, key, toStoredValue(key, value));
    }
  });
  tx(Object.entries(values));
  return readSettings(serverId);
}

function attachFields(server) {
  if (!server) return server;
  return { ...DEFAULTS, ...readSettings(server.id), ...server };
}

async function fetchManifest() {
  const { data } = await axios.get(MANIFEST_URL, {
    timeout: 20000,
    headers: { 'User-Agent': 'minecraft-manager-java' },
  });
  return data;
}

function listedReleases(manifest) {
  const latest = manifest?.latest?.release;
  const releases = (manifest?.versions || []).filter((item) => item.type === 'release');
  const ids = [];
  if (latest) ids.push(latest);
  for (const item of releases) {
    if (!ids.includes(item.id)) ids.push(item.id);
    if (ids.length >= MAX_LISTED_VERSIONS) break;
  }
  return { latest, versions: ids };
}

async function listReleaseVersions() {
  const manifest = await fetchManifest();
  return listedReleases(manifest);
}

async function resolveRelease(version) {
  const manifest = await fetchManifest();
  const latest = manifest?.latest?.release;
  const wanted = !version || version === 'latest' ? latest : String(version);
  const entry = (manifest.versions || []).find((item) => item.id === wanted);
  if (!entry?.url) {
    throw new Error(`Minecraft Java ${wanted} was not found in the Mojang version list`);
  }
  const { data } = await axios.get(entry.url, {
    timeout: 20000,
    headers: { 'User-Agent': 'minecraft-manager-java' },
  });
  const server = data?.downloads?.server;
  if (!server?.url) {
    throw new Error(`Minecraft Java ${wanted} does not publish a dedicated server jar`);
  }
  return { id: wanted, url: server.url, sha1: server.sha1 || '' };
}

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function rememberVersion(id, filePath) {
  const index = readIndex();
  const versions = (index.versions || []).filter((item) => item.id !== id);
  versions.unshift({
    id,
    path: filePath,
    downloadedAt: new Date().toISOString(),
  });
  if (versions.length > MAX_LISTED_VERSIONS) versions.length = MAX_LISTED_VERSIONS;
  writeIndex({ versions, latest: versions[0]?.id || id });
}

async function ensureJar(version) {
  const resolved = await resolveRelease(version);
  ensureDirs();
  const dest = jarPathFor(resolved.id);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    if (resolved.sha1) {
      const digest = await sha1File(dest);
      if (digest.toLowerCase() === resolved.sha1.toLowerCase()) {
        rememberVersion(resolved.id, dest);
        return { id: resolved.id, path: dest, downloaded: false };
      }
    } else {
      rememberVersion(resolved.id, dest);
      return { id: resolved.id, path: dest, downloaded: false };
    }
  }

  const response = await axios.get(resolved.url, {
    responseType: 'arraybuffer',
    timeout: 180000,
    maxRedirects: 5,
    headers: { 'User-Agent': 'minecraft-manager-java' },
  });
  fs.writeFileSync(dest, Buffer.from(response.data));
  if (fs.statSync(dest).size < 1000) {
    fs.unlinkSync(dest);
    throw new Error(`Downloaded Minecraft Java ${resolved.id} was too small`);
  }
  if (resolved.sha1) {
    const digest = await sha1File(dest);
    if (digest.toLowerCase() !== resolved.sha1.toLowerCase()) {
      fs.unlinkSync(dest);
      throw new Error(`Minecraft Java ${resolved.id} failed SHA-1 verification`);
    }
  }
  rememberVersion(resolved.id, dest);
  logger.info(`Downloaded Minecraft Java ${resolved.id}`);
  return { id: resolved.id, path: dest, downloaded: true };
}

function writeEula(serverDir) {
  fs.writeFileSync(
    path.join(serverDir, 'eula.txt'),
    `# By creating this server in Minecraft Manager you agreed to the Minecraft EULA.\n# ${EULA_URL}\neula=true\n`
  );
}

function createStubJar(serverDir) {
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(jarPath(serverDir), 'Minecraft Java Edition stub jar\n');
  writeEula(serverDir);
  fs.writeFileSync(path.join(serverDir, 'version.txt'), 'stub\n');
}

function installJarInto(serverDir, jarSource, version) {
  fs.mkdirSync(serverDir, { recursive: true });
  fs.copyFileSync(jarSource, jarPath(serverDir));
  writeEula(serverDir);
  fs.writeFileSync(path.join(serverDir, 'version.txt'), `${version}\n`);
  return { id: version, jarPath: jarPath(serverDir) };
}

function installedJar(serverDir) {
  const dest = jarPath(serverDir);
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1000) return null;
  let tag = '';
  try { tag = fs.readFileSync(path.join(serverDir, 'version.txt'), 'utf8').trim(); } catch { /* ignore */ }
  return { tag, jarPath: dest };
}

function isStubJar(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return /stub jar/i.test(text);
  } catch {
    return false;
  }
}

async function assertJavaAvailable() {
  try {
    await execFileAsync(platform.javaCommand(), ['-version'], { timeout: 8000, windowsHide: true });
  } catch (err) {
    const text = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n');
    if (/version/i.test(text)) return;
    throw new Error('Java 17 or newer is required to run Minecraft Java Edition. Install a JRE and restart the manager.');
  }
}

function runtimeProperties(server, existing = {}, extras = {}) {
  const settings = { ...DEFAULTS, ...extras };
  const motd = server.server_motd || server.server_description || server.name || 'A Minecraft Server';
  const props = { ...existing };
  const mapped = {
    motd,
    'server-port': String(server.port),
    'max-players': String(server.max_players || 20),
    difficulty: server.difficulty || existing.difficulty || 'easy',
    gamemode: server.gamemode || existing.gamemode || 'survival',
    'online-mode': isTruthy(existing['online-mode'] ?? 1) ? 'true' : 'false',
    'white-list': isTruthy(server.whitelist_mode) ? 'true' : 'false',
    'level-name': existing['level-name'] || 'world',
    'level-seed': server.level_seed || existing['level-seed'] || '',
    'enable-jmx-monitoring': existing['enable-jmx-monitoring'] || 'false',
    'use-native-transport': existing['use-native-transport'] || 'true',
  };
  for (const [key, propKey] of Object.entries(PROPERTY_MAP)) {
    if (key === 'max_players' || key === 'difficulty' || key === 'gamemode' || key === 'whitelist_mode'
      || key === 'server_motd' || key === 'server_description' || key === 'level_seed') {
      continue;
    }
    if (key === 'online_mode') {
      mapped[propKey] = isTruthy(settings.online_mode ?? existing[propKey] ?? 1) ? 'true' : 'false';
      continue;
    }
    const value = settings[key];
    if (value == null || value === '') {
      if (key === 'query_port') {
        mapped[propKey] = String(server.port);
        continue;
      }
      continue;
    }
    mapped[propKey] = BOOLEAN_KEYS.has(key) ? (isTruthy(value) ? 'true' : 'false') : String(value);
  }
  if (!mapped['query.port']) mapped['query.port'] = String(server.port);
  return { ...props, ...mapped };
}

function applyMappedSettings(currentProps, values = {}) {
  const next = { ...currentProps };
  for (const [key, value] of Object.entries(values)) {
    const propKey = PROPERTY_MAP[key];
    if (!propKey || value == null) continue;
    next[propKey] = BOOLEAN_KEYS.has(key) || key === 'whitelist_mode' || key === 'online_mode'
      ? (isTruthy(value) ? 'true' : 'false')
      : String(value);
  }
  return next;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function syncAccessFiles(server, rows = []) {
  const opLevel = Number(readSettings(server.id).op_permission_level || 4);
  const whitelist = rows.filter((row) => row.is_whitelisted && !row.is_banned).map((row) => ({
    name: row.username,
  }));
  const ops = rows
    .filter((row) => row.has_custom_permission && row.permission === 'operator' && !row.is_banned)
    .map((row) => ({
      name: row.username,
      level: opLevel,
      bypassesPlayerLimit: false,
    }));
  const banned = rows.filter((row) => row.is_banned).map((row) => ({
    name: row.username,
    created: new Date().toISOString(),
    source: 'Minecraft Manager',
    expires: 'forever',
    reason: row.ban_reason || 'Banned by administrator',
  }));
  writeJson(path.join(server.data_path, 'whitelist.json'), whitelist);
  writeJson(path.join(server.data_path, 'ops.json'), ops);
  writeJson(path.join(server.data_path, 'banned-players.json'), banned);
}

function worldBackupDirs() {
  return ['world', 'world_nether', 'world_the_end', 'logs'];
}

function accessBackupFiles() {
  return ['whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json', 'eula.txt', 'server.properties', 'usercache.json'];
}

module.exports = {
  BOOLEAN_KEYS,
  DEFAULT_PORT,
  DEFAULTS,
  DISPLAY_NAME,
  EULA_URL,
  JAR_NAME,
  KIND,
  PERMISSIONS,
  PROPERTY_MAP,
  SETTING_KEYS,
  applyMappedSettings,
  assertJavaAvailable,
  attachFields,
  createStubJar,
  ensureJar,
  installJarInto,
  installedJar,
  isJava,
  isStubJar,
  isTruthy,
  jarPath,
  listReleaseVersions,
  readSettings,
  resolveRelease,
  runtimeProperties,
  spawnArgs,
  syncAccessFiles,
  worldBackupDirs,
  accessBackupFiles,
  writeEula,
  writeSettings,
};
