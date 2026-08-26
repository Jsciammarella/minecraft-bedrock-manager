const db = require('../db/connection');
const logger = require('./logger');
const catalog = require('./permissionCatalog');
const defs = require('./permissionDefinitions');

const MIGRATION_KEY = 'permission_catalog_v2';
const SCHEMA_VERSION = String(defs.CATALOG_SCHEMA_VERSION);

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

function copyAssignment(table, ownerColumn, ownerId, fromKey, toKey, value, origin) {
  if (!toKey || toKey === fromKey) return;
  const exists = db.prepare(`SELECT value FROM ${table} WHERE ${ownerColumn} = ? AND permission_key = ?`).get(ownerId, toKey);
  if (exists) {
    if (exists.value === 'deny' || value !== 'deny') return;
    db.prepare(`
      UPDATE ${table}
      SET value = 'deny', assignment_origin = ?, updated_at = ?
      WHERE ${ownerColumn} = ? AND permission_key = ?
    `).run(origin, nowIso(), ownerId, toKey);
    return;
  }
  db.prepare(`
    INSERT INTO ${table} (${ownerColumn}, permission_key, value, assignment_origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ownerId, toKey, value, origin, nowIso(), nowIso());
}

function expandRow(table, ownerColumn, ownerId, fromKey, value, origin) {
  const targets = catalog.replacementKeysFor(fromKey);
  if (!targets.length) return;
  for (const target of targets) {
    copyAssignment(table, ownerColumn, ownerId, fromKey, target, value, origin);
  }
}

function findSystemGroup(def) {
  const byKey = db.prepare('SELECT * FROM groups WHERE system_key = ?').get(def.systemKey);
  if (byKey) return byKey;
  const bySlug = db.prepare('SELECT * FROM groups WHERE slug = ?').get(def.slug);
  if (bySlug) return bySlug;
  for (const name of [def.name, ...(def.legacyNames || [])]) {
    const byName = db.prepare('SELECT * FROM groups WHERE name = ? COLLATE NOCASE').get(name);
    if (byName) return byName;
  }
  return null;
}

function markSystemGroups() {
  for (const def of defs.SYSTEM_GROUPS) {
    let row = findSystemGroup(def);
    if (!row) {
      db.prepare(`
        INSERT INTO groups (name, slug, is_active, is_system, system_key, defaults_version, created_at, updated_at)
        VALUES (?, ?, 1, 1, ?, 0, ?, ?)
      `).run(def.name, def.slug, def.systemKey, nowIso(), nowIso());
      row = findSystemGroup(def);
    } else {
      db.prepare(`
        UPDATE groups
        SET is_system = 1,
            system_key = ?,
            updated_at = ?
        WHERE id = ?
      `).run(def.systemKey, nowIso(), row.id);
    }
  }
}

function oldSeededAllows(systemKey) {
  if (systemKey === 'administrators') return new Set(catalog.OLD_STANDARD_KEYS.concat(catalog.ALL_KEYS));
  if (systemKey === 'standard-users') {
    const keys = new Set(catalog.OLD_STANDARD_KEYS);
    keys.add('plugins.upload');
    return keys;
  }
  if (systemKey === 'read-only') return new Set();
  return new Set();
}

function oldSeededDenies(systemKey) {
  if (systemKey === 'read-only') {
    return new Set(
      catalog.OLD_STANDARD_KEYS.filter((key) => key.startsWith('menu.view.') && !defs.OLD_READ_ONLY_MENU_ALLOW.includes(key)),
    );
  }
  return new Set();
}

function migrateSystemGroupDefaults() {
  const assignable = catalog.ASSIGNABLE_KEYS;
  for (const def of defs.SYSTEM_GROUPS) {
    const row = findSystemGroup(def);
    if (!row) continue;
    const assignments = db.prepare(`
      SELECT permission_key, value, assignment_origin
      FROM group_permissions
      WHERE group_id = ?
    `).all(row.id);
    const seededAllows = oldSeededAllows(def.systemKey);
    const seededDenies = oldSeededDenies(def.systemKey);
    const keep = [];
    for (const assignment of assignments) {
      const isLegacyAllow = assignment.value === 'allow'
        && (assignment.assignment_origin === 'system_default' || seededAllows.has(assignment.permission_key) || catalog.isMenuPermission(assignment.permission_key) || catalog.isPluginPermission(assignment.permission_key));
      const isLegacyDeny = assignment.value === 'deny'
        && (assignment.assignment_origin === 'system_default' || seededDenies.has(assignment.permission_key));
      if (assignment.value === 'deny' && !isLegacyDeny) {
        keep.push(assignment);
        continue;
      }
      if (assignment.value === 'allow' && !isLegacyAllow) {
        keep.push({ ...assignment, assignment_origin: 'manual' });
      }
    }
    db.prepare('DELETE FROM group_permissions WHERE group_id = ?').run(row.id);
    const insert = db.prepare(`
      INSERT INTO group_permissions (group_id, permission_key, value, assignment_origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const bundle = catalog.bundleKeysFor(def.systemKey, assignable);
    const keptKeys = new Set();
    for (const item of keep) {
      insert.run(row.id, item.permission_key, item.value, item.assignment_origin || 'manual', nowIso(), nowIso());
      keptKeys.add(`${item.permission_key}:${item.value}`);
    }
    for (const key of bundle) {
      if (keptKeys.has(`${key}:deny`)) continue;
      if (keptKeys.has(`${key}:allow`)) continue;
      insert.run(row.id, key, 'allow', 'system_default', nowIso(), nowIso());
    }
    db.prepare('UPDATE groups SET defaults_version = ?, updated_at = ? WHERE id = ?')
      .run(defs.DEFAULTS_VERSION, nowIso(), row.id);
  }
}

function expandAllAssignments() {
  const groupRows = db.prepare('SELECT group_id, permission_key, value FROM group_permissions').all();
  for (const row of groupRows) {
    if (!catalog.isDeprecatedPermission(row.permission_key) && !defs.STALE_PERMISSION_MAP[row.permission_key]) continue;
    expandRow('group_permissions', 'group_id', row.group_id, row.permission_key, row.value, 'migration');
  }
  const userRows = db.prepare('SELECT user_id, permission_key, value FROM user_permissions').all();
  for (const row of userRows) {
    if (!catalog.isDeprecatedPermission(row.permission_key) && !defs.STALE_PERMISSION_MAP[row.permission_key]) continue;
    expandRow('user_permissions', 'user_id', row.user_id, row.permission_key, row.value, 'migration');
  }
}

function migrate() {
  if (currentVersion() === SCHEMA_VERSION) {
    markSystemGroups();
    return { skipped: true, version: SCHEMA_VERSION };
  }
  const tx = db.transaction(() => {
    backupTable('permission_defs', 'permission_defs_backup_v2');
    backupTable('user_permissions', 'user_permissions_backup_v2');
    backupTable('group_permissions', 'group_permissions_backup_v2');
    backupTable('user_groups', 'user_groups_backup_v2');
    backupTable('groups', 'groups_backup_v2');
    expandAllAssignments();
    markSystemGroups();
    migrateSystemGroupDefaults();
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
  logger.info(`Permission catalog migration applied (${SCHEMA_VERSION})`);
  return { skipped: false, version: SCHEMA_VERSION };
}

function resetSystemGroupDefaults(systemKey, actor) {
  if (!actor?.isAdmin) {
    throw Object.assign(new Error('Only administrators can reset system group defaults'), { status: 403 });
  }
  const def = defs.SYSTEM_GROUPS.find((item) => item.systemKey === systemKey || item.slug === systemKey);
  if (!def) throw Object.assign(new Error('Unknown system group'), { status: 404 });
  const row = findSystemGroup(def);
  if (!row) throw Object.assign(new Error('System group not found'), { status: 404 });
  const custom = db.prepare(`
    SELECT permission_key, value FROM group_permissions
    WHERE group_id = ? AND assignment_origin != 'system_default'
  `).all(row.id);
  db.prepare('DELETE FROM group_permissions WHERE group_id = ? AND assignment_origin = ?')
    .run(row.id, 'system_default');
  const insert = db.prepare(`
    INSERT INTO group_permissions (group_id, permission_key, value, assignment_origin, created_at, updated_at)
    VALUES (?, ?, ?, 'system_default', ?, ?)
    ON CONFLICT(group_id, permission_key) DO NOTHING
  `);
  const bundle = catalog.bundleKeysFor(def.systemKey);
  const denied = new Set(custom.filter((item) => item.value === 'deny').map((item) => item.permission_key));
  for (const key of bundle) {
    if (denied.has(key)) continue;
    insert.run(row.id, key, 'allow', nowIso(), nowIso());
  }
  db.prepare('UPDATE groups SET defaults_version = ?, updated_at = ? WHERE id = ?')
    .run(defs.DEFAULTS_VERSION, nowIso(), row.id);
  return require('./authService').getGroup(row.id, { includePermissions: true, includeUsers: true });
}

module.exports = {
  MIGRATION_KEY,
  SCHEMA_VERSION,
  currentVersion,
  migrate,
  resetSystemGroupDefaults,
  findSystemGroup,
};
