const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.MC_MANAGER_DB_PATH
  ? path.resolve(process.env.MC_MANAGER_DB_PATH)
  : path.join(__dirname, '../../data/servers/mc_manager.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, { verbose: console.log });

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

  -- Create indexes for performance
  CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);
  CREATE INDEX IF NOT EXISTS idx_server_mods_server_id ON server_mods(server_id);
  CREATE INDEX IF NOT EXISTS idx_server_players_server_id ON server_players(server_id);
  CREATE INDEX IF NOT EXISTS idx_server_player_access_server_id ON server_player_access(server_id);
  CREATE INDEX IF NOT EXISTS idx_players_username ON players(username);
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

module.exports = db;
