const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.MC_MANAGER_DB_PATH
  ? path.resolve(process.env.MC_MANAGER_DB_PATH)
  : path.join(__dirname, '../../data/servers/mc_manager.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  -- Servers table
  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    version TEXT NOT NULL DEFAULT 'latest',
    port INTEGER UNIQUE NOT NULL,
    max_players INTEGER NOT NULL DEFAULT 10,
    whitelist_mode INTEGER NOT NULL DEFAULT 0,
    difficulty TEXT NOT NULL DEFAULT 'peaceful',
    gamemode TEXT NOT NULL DEFAULT 'survival',
    default_1st_person INTEGER NOT NULL DEFAULT 1,
    server_authoritative INTEGER NOT NULL DEFAULT 1,
    enable_cheats INTEGER NOT NULL DEFAULT 1,
    texture_pack_required INTEGER NOT NULL DEFAULT 0,
    server_description TEXT NOT NULL DEFAULT 'Minecraft Bedrock Server',
    server_motd TEXT NOT NULL DEFAULT 'Minecraft Bedrock Server',
    level_seed TEXT,
    status TEXT NOT NULL DEFAULT 'stopped',
    pid INTEGER,
    pm2_id TEXT UNIQUE,
    data_path TEXT NOT NULL,
    started_at DATETIME,
    pending_restart INTEGER NOT NULL DEFAULT 0,
    pending_restart_reason TEXT,
    pending_restart_at DATETIME,
    restart_scheduled_at DATETIME,
    kind TEXT NOT NULL DEFAULT 'bedrock',
    pending_port INTEGER,
    ipv6_port INTEGER,
    pending_ipv6_port INTEGER,
    lan_broadcast INTEGER NOT NULL DEFAULT 0,
    lan_proxy_port INTEGER,
    remote_host TEXT,
    remote_ipv4_port INTEGER,
    remote_ipv6_port INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Server settings (key-value for flexible config)
  CREATE TABLE IF NOT EXISTS server_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    setting_key TEXT NOT NULL,
    setting_value TEXT NOT NULL,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    UNIQUE(server_id, setting_key)
  );

  -- Players table (known players / whitelist)
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    xuid TEXT UNIQUE,
    username TEXT NOT NULL,
    gamerpic TEXT,
    is_whitelisted INTEGER NOT NULL DEFAULT 0,
    is_banned INTEGER NOT NULL DEFAULT 0,
    last_seen DATETIME,
    discovered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(username)
  );

  -- Server-player association (which players have joined which servers)
  CREATE TABLE IF NOT EXISTS server_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    is_online INTEGER NOT NULL DEFAULT 1,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
  );

  -- Per-server access controls. Bedrock allowlist and permission files are
  -- synchronized from this table; bans are enforced by the manager.
  CREATE TABLE IF NOT EXISTS server_player_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    is_whitelisted INTEGER NOT NULL DEFAULT 0,
    permission TEXT NOT NULL DEFAULT 'member'
      CHECK(permission IN ('visitor', 'member', 'operator')),
    has_custom_permission INTEGER NOT NULL DEFAULT 0,
    is_banned INTEGER NOT NULL DEFAULT 0,
    ban_reason TEXT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
    UNIQUE(server_id, player_id)
  );

  -- Mods/Addons library (global pool of downloaded mods)
  CREATE TABLE IF NOT EXISTS mods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    type TEXT NOT NULL DEFAULT 'addon',
    version TEXT NOT NULL DEFAULT '1.0.0',
    description TEXT,
    author TEXT,
    thumbnail TEXT,
    file_path TEXT NOT NULL,
    file_size INTEGER,
    curseforge_id TEXT UNIQUE,
    source TEXT NOT NULL DEFAULT 'upload',
    downloaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Server-mod association (which mods are installed on which servers)
  CREATE TABLE IF NOT EXISTS server_mods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    mod_id INTEGER NOT NULL,
    installed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (mod_id) REFERENCES mods(id) ON DELETE CASCADE,
    UNIQUE(server_id, mod_id)
  );

  -- Port tracking
  CREATE TABLE IF NOT EXISTS port_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    port INTEGER UNIQUE NOT NULL,
    server_id INTEGER,
    protocol TEXT NOT NULL DEFAULT 'udp',
    family TEXT NOT NULL DEFAULT 'ipv4',
    in_use INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  -- Update history
  CREATE TABLE IF NOT EXISTS update_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    from_version TEXT,
    to_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    notes TEXT,
    performed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  -- Auto-update configuration
  CREATE TABLE IF NOT EXISTS auto_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 0,
    check_interval_hours INTEGER NOT NULL DEFAULT 24,
    last_check DATETIME,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  -- Application settings (catalog sources, API keys)
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Platform users (login accounts). Isolated from Minecraft players.
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    player_id INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_groups (
    user_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, group_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS permission_defs (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    allow_user INTEGER NOT NULL DEFAULT 1,
    allow_group INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS user_permissions (
    user_id INTEGER NOT NULL,
    permission_key TEXT NOT NULL,
    value TEXT NOT NULL CHECK(value IN ('allow', 'deny')),
    PRIMARY KEY (user_id, permission_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_key) REFERENCES permission_defs(key) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS group_permissions (
    group_id INTEGER NOT NULL,
    permission_key TEXT NOT NULL,
    value TEXT NOT NULL CHECK(value IN ('allow', 'deny')),
    PRIMARY KEY (group_id, permission_key),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_key) REFERENCES permission_defs(key) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS password_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Create indexes for performance
  CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);
  CREATE INDEX IF NOT EXISTS idx_server_mods_server_id ON server_mods(server_id);
  CREATE INDEX IF NOT EXISTS idx_server_players_server_id ON server_players(server_id);
  CREATE INDEX IF NOT EXISTS idx_server_player_access_server_id ON server_player_access(server_id);
  CREATE INDEX IF NOT EXISTS idx_players_username ON players(username);
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_user_groups_group_id ON user_groups(group_id);
  CREATE INDEX IF NOT EXISTS idx_password_history_user_id ON password_history(user_id);
`);

// Lightweight migrations for existing installations.
const serverColumns = new Set(db.prepare('PRAGMA table_info(servers)').all().map(column => column.name));
const ensureServerColumn = (name, definition) => {
  if (!serverColumns.has(name)) {
    db.exec(`ALTER TABLE servers ADD COLUMN ${name} ${definition}`);
    serverColumns.add(name);
  }
};

ensureServerColumn('pending_restart', 'INTEGER NOT NULL DEFAULT 0');
ensureServerColumn('pending_restart_reason', 'TEXT');
ensureServerColumn('pending_restart_at', 'DATETIME');
ensureServerColumn('restart_scheduled_at', 'DATETIME');
ensureServerColumn('kind', "TEXT NOT NULL DEFAULT 'bedrock'");
ensureServerColumn('pending_port', 'INTEGER');
ensureServerColumn('ipv6_port', 'INTEGER');
ensureServerColumn('pending_ipv6_port', 'INTEGER');
ensureServerColumn('lan_broadcast', 'INTEGER NOT NULL DEFAULT 0');
ensureServerColumn('lan_proxy_port', 'INTEGER');
ensureServerColumn('remote_host', 'TEXT');
ensureServerColumn('remote_ipv4_port', 'INTEGER');
ensureServerColumn('remote_ipv6_port', 'INTEGER');
const portUsageColumns = new Set(db.prepare('PRAGMA table_info(port_usage)').all().map(column => column.name));
if (!portUsageColumns.has('family')) {
  db.exec(`ALTER TABLE port_usage ADD COLUMN family TEXT NOT NULL DEFAULT 'ipv4'`);
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_one_bedrock_connect
  ON servers(kind) WHERE kind = 'bedrock_connect'
`);
db.exec(`
  DELETE FROM server_players
  WHERE id NOT IN (
    SELECT MIN(id) FROM server_players GROUP BY server_id, player_id
  )
`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_server_players_server_player
  ON server_players(server_id, player_id)
`);
const serverModColumns = new Set(db.prepare('PRAGMA table_info(server_mods)').all().map(column => column.name));
if (!serverModColumns.has('install_manifest')) {
  db.exec('ALTER TABLE server_mods ADD COLUMN install_manifest TEXT');
}

const playerColumns = new Set(db.prepare('PRAGMA table_info(players)').all().map(column => column.name));
if (!playerColumns.has('is_banned')) {
  db.exec('ALTER TABLE players ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0');
}

const accessColumns = new Set(db.prepare('PRAGMA table_info(server_player_access)').all().map(column => column.name));
if (!accessColumns.has('has_custom_permission')) {
  db.exec('ALTER TABLE server_player_access ADD COLUMN has_custom_permission INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE server_player_access SET has_custom_permission = 1');
}

const modColumns = new Set(db.prepare('PRAGMA table_info(mods)').all().map(column => column.name));
if (!modColumns.has('extra_files')) {
  db.exec('ALTER TABLE mods ADD COLUMN extra_files TEXT');
}
const ensureModColumn = (name, definition) => {
  if (!modColumns.has(name)) {
    db.exec(`ALTER TABLE mods ADD COLUMN ${name} ${definition}`);
    modColumns.add(name);
  }
};
ensureModColumn('edition', "TEXT NOT NULL DEFAULT 'bedrock'");
ensureModColumn('artifact_type', "TEXT NOT NULL DEFAULT 'addon'");
ensureModColumn('loader', "TEXT NOT NULL DEFAULT 'any'");
ensureModColumn('minecraft_versions', 'TEXT');
ensureModColumn('environment', "TEXT NOT NULL DEFAULT 'unknown'");
ensureModColumn('dependencies', 'TEXT');
ensureModColumn('source_url', 'TEXT');
ensureModColumn('license', 'TEXT');
ensureModColumn('sha256', 'TEXT');
ensureModColumn('metadata_json', 'TEXT');
ensureModColumn('warning', 'TEXT');

db.exec(`
  UPDATE mods
  SET curseforge_id = NULL
  WHERE curseforge_id IS NOT NULL AND TRIM(curseforge_id) = ''
`);

if (!serverModColumns.has('status')) {
  db.exec("ALTER TABLE server_mods ADD COLUMN status TEXT NOT NULL DEFAULT 'installed'");
}
if (!serverModColumns.has('pending_action')) {
  db.exec('ALTER TABLE server_mods ADD COLUMN pending_action TEXT');
}
if (!serverModColumns.has('staged_path')) {
  db.exec('ALTER TABLE server_mods ADD COLUMN staged_path TEXT');
}
if (!serverModColumns.has('previous_path')) {
  db.exec('ALTER TABLE server_mods ADD COLUMN previous_path TEXT');
}
if (!serverModColumns.has('installed_file')) {
  db.exec('ALTER TABLE server_mods ADD COLUMN installed_file TEXT');
}
if (!serverModColumns.has('compatibility_override')) {
  db.exec('ALTER TABLE server_mods ADD COLUMN compatibility_override INTEGER NOT NULL DEFAULT 0');
}

ensureServerColumn('loader_provider_id', 'TEXT');
ensureServerColumn('loader_version', 'TEXT');
ensureServerColumn('minecraft_version', 'TEXT');
ensureServerColumn('java_major', 'INTEGER');
ensureServerColumn('loader_state', 'TEXT');
ensureServerColumn('loader_metadata', 'TEXT');
ensureServerColumn('missing_mod_dependencies', 'TEXT');
ensureServerColumn('provider_id', 'TEXT');
ensureServerColumn('capability_id', 'TEXT');

db.exec(`
  UPDATE servers
  SET provider_id = COALESCE(NULLIF(provider_id, ''), 'server-edition-bedrock-connect'),
      capability_id = COALESCE(NULLIF(capability_id, ''), 'bedrock-connect')
  WHERE kind = 'bedrock_connect'
`);

db.exec(`
  UPDATE servers
  SET loader_provider_id = 'vanilla',
      minecraft_version = COALESCE(NULLIF(minecraft_version, ''), version),
      loader_state = COALESCE(NULLIF(loader_state, ''), 'ready')
  WHERE kind = 'java' AND (loader_provider_id IS NULL OR loader_provider_id = '')
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    action TEXT NOT NULL,
    actor TEXT,
    target_type TEXT,
    target_id TEXT,
    detail TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS install_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL DEFAULT 'server',
    owner_id INTEGER,
    project TEXT,
    download_url TEXT,
    version TEXT,
    sha256 TEXT,
    license TEXT,
    installed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS gateways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL,
    name TEXT UNIQUE NOT NULL,
    bedrock_listen_address TEXT NOT NULL DEFAULT '0.0.0.0',
    bedrock_udp_port INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    target_server_id INTEGER,
    target_host TEXT,
    target_tcp_port INTEGER,
    authentication TEXT NOT NULL DEFAULT 'online',
    geyser_version TEXT,
    java_major INTEGER,
    status TEXT NOT NULL DEFAULT 'stopped',
    configuration_path TEXT,
    data_path TEXT NOT NULL,
    metadata TEXT,
    floodgate_key_path TEXT,
    offline_confirmed INTEGER NOT NULL DEFAULT 0,
    floodgate_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (target_server_id) REFERENCES servers(id) ON DELETE SET NULL
  );
`);

if (!portUsageColumns.has('gateway_id')) {
  db.exec('ALTER TABLE port_usage ADD COLUMN gateway_id INTEGER');
}

const gatewayColumns = new Set(db.prepare('PRAGMA table_info(gateways)').all().map((column) => column.name));
function ensureGatewayColumn(name, definition) {
  if (!gatewayColumns.has(name)) {
    db.exec(`ALTER TABLE gateways ADD COLUMN ${name} ${definition}`);
    gatewayColumns.add(name);
  }
}
ensureGatewayColumn('compatibility_mode', "TEXT NOT NULL DEFAULT 'direct'");
ensureGatewayColumn('advertise_in_bedrock_connect', 'INTEGER NOT NULL DEFAULT 1');
ensureGatewayColumn('viaproxy_version', 'TEXT');
ensureGatewayColumn('geyser_viaproxy_version', 'TEXT');
ensureGatewayColumn('viaproxy_bind_port', 'INTEGER');
ensureGatewayColumn('target_minecraft_version', 'TEXT');
ensureGatewayColumn('last_compatibility_check', 'TEXT');
ensureGatewayColumn('last_compatibility_result', 'TEXT');
ensureGatewayColumn('last_error', 'TEXT');
ensureGatewayColumn('health_status', "TEXT NOT NULL DEFAULT 'stopped'");
db.exec(`
  UPDATE gateways
  SET compatibility_mode = 'direct'
  WHERE compatibility_mode IS NULL OR compatibility_mode = ''
`);
db.exec(`
  UPDATE gateways
  SET advertise_in_bedrock_connect = 1
  WHERE advertise_in_bedrock_connect IS NULL
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS plugin_dashboard_snapshots (
    entity_id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS server_plugin_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    server_id INTEGER NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    primary_attachment INTEGER NOT NULL DEFAULT 0,
    display_json TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE RESTRICT,
    UNIQUE(plugin_id, provider_id, resource_type, resource_id)
  );
`);

ensureGatewayColumn('unresolved_target', 'INTEGER NOT NULL DEFAULT 0');
ensureGatewayColumn('unresolved_reason', 'TEXT');

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function ensureColumn(table, name, definition) {
  const columns = tableColumns(table);
  if (!columns.has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

ensureColumn('groups', 'is_system', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('groups', 'system_key', 'TEXT');
ensureColumn('groups', 'defaults_version', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('groups', 'description', 'TEXT');
ensureColumn('permission_defs', 'display_name', 'TEXT');
ensureColumn('permission_defs', 'primary_category', 'TEXT');
ensureColumn('permission_defs', 'subcategory', 'TEXT');
ensureColumn('permission_defs', 'source', "TEXT NOT NULL DEFAULT 'core'");
ensureColumn('permission_defs', 'plugin_id', 'TEXT');
ensureColumn('permission_defs', 'risk_level', "TEXT NOT NULL DEFAULT 'normal'");
ensureColumn('permission_defs', 'assignable_to_users', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('permission_defs', 'assignable_to_groups', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('permission_defs', 'active', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('permission_defs', 'deprecated', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('permission_defs', 'schema_version', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('permission_defs', 'created_at', 'DATETIME');
ensureColumn('permission_defs', 'updated_at', 'DATETIME');
ensureColumn('user_permissions', 'assignment_origin', "TEXT NOT NULL DEFAULT 'manual'");
ensureColumn('user_permissions', 'created_at', 'DATETIME');
ensureColumn('user_permissions', 'updated_at', 'DATETIME');
ensureColumn('group_permissions', 'assignment_origin', "TEXT NOT NULL DEFAULT 'manual'");
ensureColumn('group_permissions', 'created_at', 'DATETIME');
ensureColumn('group_permissions', 'updated_at', 'DATETIME');

db.exec(`
  UPDATE permission_defs
  SET display_name = COALESCE(NULLIF(display_name, ''), name),
      primary_category = COALESCE(NULLIF(primary_category, ''), category)
  WHERE display_name IS NULL OR display_name = '' OR primary_category IS NULL OR primary_category = ''
`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_system_key
  ON groups(system_key)
  WHERE system_key IS NOT NULL AND system_key != ''
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    migration_key TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    result TEXT
  );
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_gateways_status ON gateways(status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_server ON server_plugin_attachments(server_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_resource ON server_plugin_attachments(plugin_id, resource_type, resource_id)`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_primary
  ON server_plugin_attachments(plugin_id, provider_id, server_id)
  WHERE primary_attachment = 1
`);

module.exports = db;

