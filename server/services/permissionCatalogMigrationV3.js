const db = require('../db/connection');
const logger = require('./logger');
const catalog = require('./permissionCatalog');
const defs = require('./permissionDefinitions');
const errors = require('../security/errors');

const MIGRATION_KEY = 'permission_catalog_v3';
const SCHEMA_VERSION = '3';

const FIRST_PARTY_OWNERSHIP = [
  { pluginId: defs.BEDROCK_CONNECT_PLUGIN_ID, match: (key) => String(key).startsWith('bedrock_connect.') },
  {
    pluginId: defs.JAVA_PLUGIN_ID,
    match: (key) => key === 'servers.create_java' || key === 'servers.start_java' || key === 'servers.stop_java' || String(key).startsWith('servers.java.'),
  },
  { pluginId: defs.CURSEFORGE_PLUGIN_ID, match: (key) => key === 'catalog.curseforge.configure' || key === 'library.import_curseforge' },
  { pluginId: defs.GIT_CATALOG_PLUGIN_ID, match: (key) => String(key).startsWith('catalog.git.') },
  { pluginId: defs.FILE_CATALOG_PLUGIN_ID, match: (key) => String(key).startsWith('catalog.file.') },
];

function nowIso() {
  return new Date().toISOString();
}

function currentVersion() {
  const row = db.prepare('SELECT schema_version FROM schema_history WHERE migration_key = ?').get(MIGRATION_KEY);
  return row ? String(row.schema_version) : '';
}

function backupTable(source, dest) {
  db.exec(`DROP TABLE IF EXISTS ${dest}`);
  db.exec(`CREATE TABLE ${dest} AS SELECT * FROM ${source}`);
}

function findPowerUsers() {
  return db.prepare(`
    SELECT * FROM groups
    WHERE system_key = 'power-users' OR slug = 'power-users' OR name = 'Power Users' COLLATE NOCASE
  `).get();
}

function findAdministrators() {
  return db.prepare(`
    SELECT * FROM groups
    WHERE system_key = 'administrators' OR slug = 'administrators'
  `).get();
}

function updateFirstPartyOwnership() {
  const rows = db.prepare('SELECT key, plugin_id, source FROM permission_defs WHERE deprecated = 0').all();
  const update = db.prepare(`
    UPDATE permission_defs
    SET plugin_id = ?, source = 'first-party-plugin', updated_at = ?
    WHERE key = ?
  `);
  const stamp = nowIso();
  for (const row of rows) {
    const owner = FIRST_PARTY_OWNERSHIP.find((item) => item.match(row.key));
    if (!owner) continue;
    if (row.plugin_id === owner.pluginId && row.source === 'first-party-plugin') continue;
    update.run(owner.pluginId, stamp, row.key);
  }
}

function addPlayersScanToPowerUsers() {
  const group = findPowerUsers();
  if (!group) return;
  const existing = db.prepare(`
    SELECT value, assignment_origin FROM group_permissions
    WHERE group_id = ? AND permission_key = 'players.scan'
  `).get(group.id);
  if (existing) return;
  const stamp = nowIso();
  db.prepare(`
    INSERT INTO group_permissions (group_id, permission_key, value, assignment_origin, created_at, updated_at)
    VALUES (?, 'players.scan', 'allow', 'system_default', ?, ?)
  `).run(group.id, stamp, stamp);
  db.prepare('UPDATE groups SET defaults_version = ?, updated_at = ? WHERE id = ?')
    .run(defs.DEFAULTS_VERSION, stamp, group.id);
}

function seedAdministratorsAssignable() {
  const group = findAdministrators();
  if (!group) return;
  const keys = catalog.listActiveGroupAssignablePermissions();
  const stamp = nowIso();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO group_permissions (group_id, permission_key, value, assignment_origin, created_at, updated_at)
    VALUES (?, ?, 'allow', 'system_default', ?, ?)
  `);
  for (const key of keys) insert.run(group.id, key, stamp, stamp);
}

function migrate(hooks = {}) {
  if (currentVersion() === SCHEMA_VERSION) {
    return { skipped: true, version: SCHEMA_VERSION };
  }
  const runHook = (name) => {
    if (typeof hooks[name] === 'function') hooks[name]();
  };
  try {
    const tx = db.transaction(() => {
      runHook('beforeBackup');
      backupTable('permission_defs', 'permission_defs_backup_v3');
      backupTable('user_permissions', 'user_permissions_backup_v3');
      backupTable('group_permissions', 'group_permissions_backup_v3');
      backupTable('user_groups', 'user_groups_backup_v3');
      backupTable('groups', 'groups_backup_v3');
      runHook('afterBackup');
      require('./authService').ensurePermissionRows();
      runHook('afterPermissionExpansion');
      updateFirstPartyOwnership();
      addPlayersScanToPowerUsers();
      runHook('afterSystemGroupDefaults');
      seedAdministratorsAssignable();
      runHook('beforeSchemaHistory');
      db.prepare(`
        INSERT INTO schema_history (migration_key, schema_version, applied_at, result)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(migration_key) DO UPDATE SET
          schema_version = excluded.schema_version,
          applied_at = excluded.applied_at,
          result = excluded.result
      `).run(MIGRATION_KEY, SCHEMA_VERSION, nowIso(), 'ok');
    });
    tx();
  } catch (err) {
    logger.error('Permission catalog v3 migration failed', {
      migrationKey: MIGRATION_KEY,
      schemaVersion: SCHEMA_VERSION,
      error: err.message,
      recovery: 'Fix the error and restart. Pre-upgrade backups are preserved. Do not treat this installation as upgraded.',
    });
    throw errors.permissionMigrationFailed(MIGRATION_KEY, SCHEMA_VERSION, err);
  }
  logger.info(`Permission catalog migration applied (${MIGRATION_KEY} ${SCHEMA_VERSION})`);
  return { skipped: false, version: SCHEMA_VERSION };
}

module.exports = {
  MIGRATION_KEY,
  SCHEMA_VERSION,
  currentVersion,
  migrate,
  FIRST_PARTY_OWNERSHIP,
};
