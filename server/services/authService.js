const crypto = require('crypto');
const db = require('../db/connection');
const catalog = require('./permissionCatalog');
const settingsStore = require('./settingsStore');

const SESSION_COOKIE = 'mbm_session';
const DEFAULT_SESSION_HOURS = 168;
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'mcadmin';
const DEFAULT_FULL_NAME = 'Administrator';

const KEYS = {
  SESSION_HOURS: 'auth_session_hours',
  DEFAULT_GROUP_ID: 'auth_default_group_id',
  AUTH_SECRET: 'auth_secret',
  PASSWORD_MIN_LENGTH: 'auth_password_min_length',
  PASSWORD_HISTORY: 'auth_password_history',
  PASSWORD_REQUIRE_UPPER: 'auth_password_require_upper',
  PASSWORD_REQUIRE_LOWER: 'auth_password_require_lower',
  PASSWORD_REQUIRE_NUMBER: 'auth_password_require_number',
  PASSWORD_REQUIRE_SPECIAL: 'auth_password_require_special',
};

const USERNAME_MIN = 2;
const USERNAME_MAX = 64;
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const PASSWORD_MAX = 200;
const DEFAULT_PASSWORD_MIN = 6;

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !String(stored).includes(':')) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const verify = crypto.scryptSync(String(password), salt, 64).toString('hex');
  if (hash.length !== verify.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verify, 'hex'));
  } catch {
    return false;
  }
}

function getSessionHours() {
  const raw = Number(settingsStore.get(KEYS.SESSION_HOURS));
  if (Number.isFinite(raw) && raw >= 1 && raw <= 24 * 30) return Math.round(raw);
  return DEFAULT_SESSION_HOURS;
}

function getDefaultGroupId() {
  const raw = Number(settingsStore.get(KEYS.DEFAULT_GROUP_ID));
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

function settingFlag(key) {
  return settingsStore.get(key) === '1';
}

function clampInt(value, fallback, min, max) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

function getPasswordPolicy() {
  return {
    minLength: clampInt(settingsStore.get(KEYS.PASSWORD_MIN_LENGTH), DEFAULT_PASSWORD_MIN, 1, PASSWORD_MAX),
    maxLength: PASSWORD_MAX,
    history: clampInt(settingsStore.get(KEYS.PASSWORD_HISTORY), 0, 0, 24),
    requireUpper: settingFlag(KEYS.PASSWORD_REQUIRE_UPPER),
    requireLower: settingFlag(KEYS.PASSWORD_REQUIRE_LOWER),
    requireNumber: settingFlag(KEYS.PASSWORD_REQUIRE_NUMBER),
    requireSpecial: settingFlag(KEYS.PASSWORD_REQUIRE_SPECIAL),
    usernameMin: USERNAME_MIN,
    usernameMax: USERNAME_MAX,
    usernamePattern: USERNAME_PATTERN.source,
    usernameAllowed: 'letters, numbers, periods, underscores, and hyphens',
  };
}

function publicSettings() {
  return {
    sessionHours: getSessionHours(),
    defaultGroupId: getDefaultGroupId(),
    ...getPasswordPolicy(),
  };
}

function saveSettings({
  sessionHours,
  defaultGroupId,
  passwordMinLength,
  passwordHistory,
  passwordRequireUpper,
  passwordRequireLower,
  passwordRequireNumber,
  passwordRequireSpecial,
} = {}) {
  if (sessionHours != null) {
    const hours = Number(sessionHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) {
      throw new Error('Session timeout must be between 1 and 720 hours');
    }
    settingsStore.set(KEYS.SESSION_HOURS, String(Math.round(hours)));
  }
  if (defaultGroupId === null || defaultGroupId === '') {
    settingsStore.set(KEYS.DEFAULT_GROUP_ID, '');
  } else if (defaultGroupId != null) {
    const id = Number(defaultGroupId);
    const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(id);
    if (!group) throw new Error('Default group not found');
    settingsStore.set(KEYS.DEFAULT_GROUP_ID, String(id));
  }
  if (passwordMinLength != null) {
    settingsStore.set(KEYS.PASSWORD_MIN_LENGTH, String(clampInt(passwordMinLength, DEFAULT_PASSWORD_MIN, 1, PASSWORD_MAX)));
  }
  if (passwordHistory != null) {
    settingsStore.set(KEYS.PASSWORD_HISTORY, String(clampInt(passwordHistory, 0, 0, 24)));
  }
  if (passwordRequireUpper != null) {
    settingsStore.set(KEYS.PASSWORD_REQUIRE_UPPER, passwordRequireUpper ? '1' : '0');
  }
  if (passwordRequireLower != null) {
    settingsStore.set(KEYS.PASSWORD_REQUIRE_LOWER, passwordRequireLower ? '1' : '0');
  }
  if (passwordRequireNumber != null) {
    settingsStore.set(KEYS.PASSWORD_REQUIRE_NUMBER, passwordRequireNumber ? '1' : '0');
  }
  if (passwordRequireSpecial != null) {
    settingsStore.set(KEYS.PASSWORD_REQUIRE_SPECIAL, passwordRequireSpecial ? '1' : '0');
  }
  return publicSettings();
}

function listedPermissionKeys() {
  return db.prepare('SELECT key FROM permission_defs ORDER BY key').all().map((row) => row.key);
}

function knownPermission(key) {
  return Boolean(db.prepare('SELECT 1 FROM permission_defs WHERE key = ?').get(key));
}

function upsertPermissionDefs(perms) {
  const upsert = db.prepare(`
    INSERT INTO permission_defs (
      key, name, description, category, allow_user, allow_group,
      display_name, primary_category, subcategory, source, plugin_id, risk_level,
      assignable_to_users, assignable_to_groups, active, deprecated, schema_version,
      created_at, updated_at
    ) VALUES (
      @key, @name, @description, @category, @allowUser, @allowGroup,
      @displayName, @primaryCategory, @subcategory, @source, @pluginId, @riskLevel,
      @assignableToUsers, @assignableToGroups, @active, @deprecated, @schemaVersion,
      @createdAt, @updatedAt
    )
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      category = excluded.category,
      display_name = excluded.display_name,
      primary_category = excluded.primary_category,
      subcategory = excluded.subcategory,
      source = excluded.source,
      plugin_id = excluded.plugin_id,
      risk_level = excluded.risk_level,
      assignable_to_users = excluded.assignable_to_users,
      assignable_to_groups = excluded.assignable_to_groups,
      allow_user = CASE WHEN excluded.assignable_to_users = 0 THEN 0 ELSE permission_defs.allow_user END,
      allow_group = CASE WHEN excluded.assignable_to_groups = 0 THEN 0 ELSE permission_defs.allow_group END,
      active = excluded.active,
      deprecated = excluded.deprecated,
      schema_version = excluded.schema_version,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction(() => {
    const stamp = nowIso();
    for (const perm of perms) {
      const deprecated = Boolean(perm.deprecated);
      const assignableUsers = deprecated ? 0 : (perm.assignableToUsers === false ? 0 : 1);
      const assignableGroups = deprecated ? 0 : (perm.assignableToGroups === false ? 0 : 1);
      const displayName = perm.displayName || perm.name || perm.key;
      upsert.run({
        key: perm.key,
        name: displayName,
        description: perm.description || '',
        category: perm.primaryCategory || perm.category || 'plugin',
        allowUser: assignableUsers,
        allowGroup: assignableGroups,
        displayName,
        primaryCategory: perm.primaryCategory || perm.category || 'plugin',
        subcategory: perm.subcategory || null,
        source: perm.source || 'core',
        pluginId: perm.pluginId || null,
        riskLevel: perm.riskLevel || 'normal',
        assignableToUsers: assignableUsers,
        assignableToGroups: assignableGroups,
        active: deprecated ? 0 : (perm.active === false ? 0 : 1),
        deprecated: deprecated ? 1 : 0,
        schemaVersion: perm.schemaVersion || catalog.CATALOG_SCHEMA_VERSION || 2,
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
  });
  tx();
}

function ensurePermissionRows() {
  upsertPermissionDefs([
    ...catalog.CORE_PERMISSIONS,
    ...catalog.DEPRECATED_PERMISSIONS,
  ]);
}

function seedUnusedDefaultGroupPerms() {
  const insertAllow = db.prepare(`
    INSERT OR IGNORE INTO group_permissions (group_id, permission_key, value, assignment_origin, created_at, updated_at)
    VALUES (?, ?, 'allow', 'system_default', ?, ?)
  `);
  const countPerms = db.prepare('SELECT COUNT(*) AS n FROM group_permissions WHERE group_id = ?');
  const stamp = nowIso();
  for (const def of catalog.SYSTEM_GROUPS) {
    const row = db.prepare(`
      SELECT id FROM groups WHERE system_key = ? OR slug = ?
    `).get(def.systemKey, def.slug);
    if (!row) continue;
    const empty = countPerms.get(row.id).n === 0;
    const keys = def.systemKey === 'administrators'
      ? catalog.listActiveGroupAssignablePermissions()
      : catalog.bundleKeysFor(def.systemKey);
    if (empty) {
      for (const key of keys) insertAllow.run(row.id, key, stamp, stamp);
      db.prepare('UPDATE groups SET defaults_version = ? WHERE id = ?').run(catalog.DEFAULTS_VERSION, row.id);
      continue;
    }
    if (def.systemKey !== 'administrators') continue;
    const assigned = new Set(
      db.prepare('SELECT permission_key AS k FROM group_permissions WHERE group_id = ?')
        .all(row.id)
        .map((item) => item.k),
    );
    for (const key of keys) {
      if (assigned.has(key) || catalog.isDeprecatedPermission(key)) continue;
      insertAllow.run(row.id, key, stamp, stamp);
    }
  }
}

function ensureDefaultGroups() {
  const insertGroup = db.prepare(`
    INSERT INTO groups (name, slug, is_active, is_system, system_key, defaults_version, created_at, updated_at)
    VALUES (?, ?, 1, 1, ?, ?, ?, ?)
  `);
  const stamp = nowIso();
  for (const def of catalog.SYSTEM_GROUPS) {
    const row = db.prepare(`
      SELECT id FROM groups WHERE system_key = ? OR slug = ? OR name = ? COLLATE NOCASE
    `).get(def.systemKey, def.slug, def.name);
    if (!row) {
      insertGroup.run(def.name, def.slug, def.systemKey, catalog.DEFAULTS_VERSION, stamp, stamp);
    } else {
      db.prepare(`
        UPDATE groups SET is_system = 1, system_key = COALESCE(NULLIF(system_key, ''), ?)
        WHERE id = ?
      `).run(def.systemKey, row.id);
    }
  }
}

function syncDynamicPermissions() {
  let pluginHost;
  try {
    pluginHost = require('./pluginHost');
  } catch {
    return;
  }
  const dynamic = typeof pluginHost.getDynamicPermissions === 'function'
    ? pluginHost.getDynamicPermissions()
    : [];
  if (dynamic.length) upsertPermissionDefs(dynamic);
  try {
    const plugins = pluginHost.getPlugins() || [];
    if (plugins.length) {
      const stamp = nowIso();
      db.prepare(`
        UPDATE permission_defs
        SET active = 0, updated_at = ?
        WHERE IFNULL(plugin_id, '') != '' AND deprecated = 0
      `).run(stamp);
      const setActive = db.prepare(`
        UPDATE permission_defs
        SET active = 1, updated_at = ?
        WHERE plugin_id = ? AND deprecated = 0
      `);
      for (const plugin of plugins) {
        if (!plugin?.id || plugin.enabled === false) continue;
        setActive.run(stamp, plugin.id);
      }
    }
  } catch {
    /* plugin list optional during startup */
  }
  const keep = new Set([
    ...catalog.ALL_KEYS,
    ...dynamic.map((item) => item.key),
  ]);
  const extra = db.prepare(`
    SELECT key FROM permission_defs
    WHERE key LIKE 'plugin.%' OR key LIKE 'menu.view.plugin.%'
  `).all();
  const remove = db.prepare('DELETE FROM permission_defs WHERE key = ?');
  const tx = db.transaction(() => {
    for (const row of extra) {
      if (!keep.has(row.key)) remove.run(row.key);
    }
  });
  tx();
  seedUnusedDefaultGroupPerms();
}

function runSecurityMigrations() {
  const logger = require('./logger');
  const errors = require('../security/errors');
  const wrap = (migrationKey, fn) => {
    try {
      return fn();
    } catch (err) {
      if (err?.code === 'PERMISSION_MIGRATION_FAILED') throw err;
      logger.error('Permission migration failed', {
        migrationKey,
        schemaVersion: String(catalog.CATALOG_SCHEMA_VERSION),
        error: err.message,
        recovery: 'Fix the reported error and restart. Do not sign in or start managed servers until migration succeeds.',
      });
      throw errors.permissionMigrationFailed(migrationKey, String(catalog.CATALOG_SCHEMA_VERSION), err);
    }
  };
  wrap('permission_catalog_v2', () => require('./permissionCatalogMigration').migrate());
  wrap('permission_catalog_v3', () => require('./permissionCatalogMigrationV3').migrate());
  wrap('bedrock_connect_permission_schema', () => require('./bedrockConnectPermissionMigration').migrate());
}

function ensureSeed() {
  ensurePermissionRows();
  ensureDefaultGroups();
  runSecurityMigrations();
  seedUnusedDefaultGroupPerms();
}

function needsAdministratorBootstrap() {
  return countAdmins({ onlyActive: true }) === 0;
}

function bootstrapAdministrator({ username, password, fullName } = {}) {
  if (!needsAdministratorBootstrap()) {
    const err = new Error('Administrator bootstrap is not available');
    err.status = 404;
    throw err;
  }
  const pass = String(password || '');
  if (!pass) {
    const err = new Error('An initial administrator password is required');
    err.status = 400;
    throw err;
  }
  ensureSeed();
  const user = createUserRecord({
    username: username || DEFAULT_USERNAME,
    fullName: fullName || DEFAULT_FULL_NAME,
    password: pass,
    isAdmin: true,
    isActive: true,
    skipDefaultGroup: true,
  });
  const adminGroup = db.prepare("SELECT id FROM groups WHERE slug = 'administrators'").get();
  if (adminGroup) {
    db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(user.id, adminGroup.id);
  }
  return getUser(user.id, { includePermissions: true });
}

function countAdmins({ excludeUserId, onlyActive = false } = {}) {
  let sql = 'SELECT COUNT(*) AS n FROM users WHERE is_admin = 1';
  const params = [];
  if (onlyActive) sql += ' AND is_active = 1';
  if (excludeUserId) {
    sql += ' AND id != ?';
    params.push(excludeUserId);
  }
  return db.prepare(sql).get(...params).n;
}

function permissionFlags() {
  const rows = db.prepare('SELECT key, allow_user, allow_group, active, deprecated FROM permission_defs').all();
  const map = {};
  for (const row of rows) {
    map[row.key] = {
      allowUser: row.allow_user === 1,
      allowGroup: row.allow_group === 1,
      active: row.active !== 0,
      deprecated: row.deprecated === 1,
    };
  }
  return map;
}

function groupPermissionMap(groupIds, flags) {
  const result = {};
  if (!groupIds.length) return result;
  const placeholders = groupIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT permission_key, value
    FROM group_permissions
    WHERE group_id IN (${placeholders})
  `).all(...groupIds);
  for (const row of rows) {
    const flag = flags[row.permission_key];
    if (flag && flag.allowGroup === false && !flag.deprecated) continue;
    if (row.value === 'deny') result[row.permission_key] = 'deny';
    else if (row.value === 'allow' && result[row.permission_key] !== 'deny') {
      result[row.permission_key] = 'allow';
    }
  }
  return result;
}

function userPermissionMap(userId, flags) {
  const rows = db.prepare(`
    SELECT permission_key, value FROM user_permissions WHERE user_id = ?
  `).all(userId);
  const result = {};
  for (const row of rows) {
    const flag = flags[row.permission_key];
    if (flag && flag.allowUser === false && !flag.deprecated) continue;
    result[row.permission_key] = row.value;
  }
  return result;
}

function assignmentValue(key, map) {
  if (map[key] === 'deny') return 'deny';
  const aliases = typeof catalog.legacyKeysFor === 'function' ? catalog.legacyKeysFor(key) : [];
  if (aliases.some((alias) => map[alias] === 'deny')) return 'deny';
  if (map[key] === 'allow') return 'allow';
  if (aliases.some((alias) => map[alias] === 'allow')) return 'allow';
  return undefined;
}

function evaluatePermissions(userRow, groups) {
  const granted = {};
  const keys = listedPermissionKeys();
  if (userRow.is_admin === 1) {
    for (const key of keys) granted[key] = true;
    return granted;
  }
  const flags = permissionFlags();
  const activeGroupIds = groups.filter((g) => g.is_active === 1).map((g) => g.id);
  const groupMap = groupPermissionMap(activeGroupIds, flags);
  const userMap = userPermissionMap(userRow.id, flags);
  for (const key of keys) {
    const groupVal = assignmentValue(key, groupMap);
    const userVal = assignmentValue(key, userMap);
    if (groupVal === 'deny') {
      granted[key] = false;
      continue;
    }
    if (userVal === 'deny') {
      granted[key] = false;
      continue;
    }
    const def = catalog.permissionByKey(key);
    if (def && def.active === false && !def.deprecated) {
      granted[key] = false;
      continue;
    }
    const flagsForKey = flags[key];
    if (flagsForKey && flagsForKey.active === false) {
      granted[key] = false;
      continue;
    }
    granted[key] = groupVal === 'allow' || userVal === 'allow';
  }
  return granted;
}

function loadGroupsForUser(userId) {
  return db.prepare(`
    SELECT g.id, g.name, g.slug, g.is_active
    FROM groups g
    JOIN user_groups ug ON ug.group_id = g.id
    WHERE ug.user_id = ?
    ORDER BY g.name COLLATE NOCASE
  `).all(userId);
}

function publicUser(row, { includePermissions = false, includeSensitive = false } = {}) {
  if (!row) return null;
  const groups = loadGroupsForUser(row.id);
  const player = row.player_id
    ? db.prepare('SELECT id, username, xuid FROM players WHERE id = ?').get(row.player_id)
    : null;
  const payload = {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    isAdmin: row.is_admin === 1,
    isActive: row.is_active === 1,
    playerId: row.player_id || null,
    player: player ? { id: player.id, username: player.username, xuid: player.xuid } : null,
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      slug: g.slug,
      isActive: g.is_active === 1,
    })),
    groupCount: groups.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includePermissions) {
    const granted = evaluatePermissions(row, groups);
    const effective = new Set();
    for (const key of listedPermissionKeys()) {
      const meta = catalog.permissionByKey(key) || {};
      if (meta.deprecated) {
        if (granted[key]) {
          for (const next of catalog.replacementKeysFor(key)) {
            if (granted[next] !== false) effective.add(next);
          }
        }
        continue;
      }
      if (granted[key]) effective.add(key);
    }
    payload.permissions = [...effective];
  }
  if (includeSensitive) {
    payload.userPermissions = {};
    const rows = db.prepare('SELECT permission_key, value FROM user_permissions WHERE user_id = ?').all(row.id);
    for (const item of rows) payload.userPermissions[item.permission_key] = item.value;
    const inherited = {};
    const flags = permissionFlags();
    const groupMap = groupPermissionMap(groups.filter((g) => g.is_active === 1).map((g) => g.id), flags);
    const groupRows = groups.length
      ? db.prepare(`
          SELECT g.name, gp.permission_key, gp.value
          FROM group_permissions gp
          JOIN groups g ON g.id = gp.group_id
          WHERE gp.group_id IN (${groups.map(() => '?').join(',')})
        `).all(...groups.map((g) => g.id))
      : [];
    const sources = {};
    for (const item of groupRows) {
      if (!sources[item.permission_key]) sources[item.permission_key] = [];
      sources[item.permission_key].push({ group: item.name, effect: item.value });
    }
    for (const [key, value] of Object.entries(groupMap)) {
      inherited[key] = {
        effect: value,
        sources: sources[key] || [],
      };
    }
    payload.inheritedPermissions = inherited;
  }
  return payload;
}

function getUserRow(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').trim());
}

function hasPermission(user, key) {
  if (!user || user.isActive === false) return false;
  if (user.isAdmin) return true;
  const perms = user.permissions || [];
  const aliases = typeof catalog.permissionAliases === 'function'
    ? catalog.permissionAliases(key)
    : [key];
  return aliases.some((item) => perms.includes(item));
}

function collectGlobalSources(user, key) {
  const decision = require('../security/decision');
  if (!user || user.id == null || user.isActive === false) return [];
  const row = getUserRow(user.id) || (user.is_admin != null ? user : null);
  if (!row) return [];
  const canonical = typeof catalog.canonicalPermission === 'function'
    ? catalog.canonicalPermission(key)
    : String(key || '');
  const flags = permissionFlags();
  const groups = loadGroupsForUser(row.id);
  const activeGroups = groups.filter((g) => g.is_active === 1);
  const groupMap = groupPermissionMap(activeGroups.map((g) => g.id), flags);
  const userMap = userPermissionMap(row.id, flags);
  const sources = [];
  if (activeGroups.length) {
    const placeholders = activeGroups.map(() => '?').join(',');
    const groupRows = db.prepare(`
      SELECT g.id, g.name, gp.permission_key, gp.value
      FROM group_permissions gp
      JOIN groups g ON g.id = gp.group_id
      WHERE gp.group_id IN (${placeholders})
    `).all(...activeGroups.map((g) => g.id));
    const aliases = new Set(typeof catalog.permissionAliases === 'function'
      ? catalog.permissionAliases(canonical)
      : [canonical]);
    for (const item of groupRows) {
      if (!aliases.has(item.permission_key) && item.permission_key !== canonical) continue;
      const flag = flags[item.permission_key];
      if (flag && flag.allowGroup === false && !flag.deprecated) continue;
      sources.push(decision.source({
        origin: 'global-group',
        scope: 'global',
        value: item.value,
        groupId: item.id,
        groupName: item.name,
        permission: canonical,
      }));
    }
  }
  const userVal = assignmentValue(canonical, userMap);
  if (userVal) {
    sources.push(decision.source({
      origin: 'global-user',
      scope: 'global',
      value: userVal,
      userId: row.id,
      permission: canonical,
    }));
  }
  void groupMap;
  return sources;
}

function canAccessUserManagement(user) {
  if (!user) return false;
  if (user.isAdmin) return true;
  return catalog.USER_MANAGEMENT_KEYS
    .filter((key) => !String(key).startsWith('account.'))
    .some((key) => hasPermission(user, key));
}

function listUsers() {
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM user_groups ug WHERE ug.user_id = u.id) AS group_count
    FROM users u
    ORDER BY u.full_name COLLATE NOCASE, u.username COLLATE NOCASE
  `).all();
  return rows.map((row) => publicUser({ ...row, group_count: row.group_count }));
}

function getUser(id, opts) {
  const row = getUserRow(id);
  if (!row) return null;
  return publicUser(row, opts);
}

function isValidUsername(username) {
  const value = String(username || '').trim();
  return value.length >= USERNAME_MIN
    && value.length <= USERNAME_MAX
    && USERNAME_PATTERN.test(value);
}

function normalizeUsername(username) {
  const value = String(username || '').trim();
  if (!value) throw new Error('Username is required');
  if (value.length < USERNAME_MIN || value.length > USERNAME_MAX) {
    throw new Error(`Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters`);
  }
  if (!USERNAME_PATTERN.test(value)) {
    throw new Error('Username can only contain letters, numbers, periods, underscores, and hyphens');
  }
  return value;
}

function normalizeFullName(fullName) {
  const value = String(fullName || '').trim();
  if (!value) throw new Error('Full name is required');
  if (value.length > 120) throw new Error('Full name is too long');
  return value;
}

function passwordMatchesStored(password, stored) {
  return Boolean(stored) && verifyPassword(password, stored);
}

function assertPassword(password, { userId } = {}) {
  const value = String(password || '');
  const policy = getPasswordPolicy();
  if (!value) throw new Error('Password is required');
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new Error('Password cannot contain control characters');
  }
  if (value.length < policy.minLength) {
    throw new Error(`Password must be at least ${policy.minLength} characters`);
  }
  if (value.length > policy.maxLength) {
    throw new Error(`Password cannot be longer than ${policy.maxLength} characters`);
  }
  if (policy.requireUpper && !/[A-Z]/.test(value)) {
    throw new Error('Password must include an uppercase letter');
  }
  if (policy.requireLower && !/[a-z]/.test(value)) {
    throw new Error('Password must include a lowercase letter');
  }
  if (policy.requireNumber && !/[0-9]/.test(value)) {
    throw new Error('Password must include a number');
  }
  if (policy.requireSpecial && !/[^A-Za-z0-9]/.test(value)) {
    throw new Error('Password must include a special character');
  }
  if (userId) {
    const row = getUserRow(userId);
    if (row && passwordMatchesStored(value, row.password_hash)) {
      throw new Error('New password must be different from the current password');
    }
    if (policy.history > 0) {
      const previous = db.prepare(`
        SELECT password_hash
        FROM password_history
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(userId, policy.history);
      if (previous.some((item) => passwordMatchesStored(value, item.password_hash))) {
        throw new Error(`Password cannot match the last ${policy.history} password${policy.history === 1 ? '' : 's'}`);
      }
    }
  }
  return value;
}

function setUserGroups(userId, groupIds) {
  const ids = [...new Set((groupIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)');
    for (const id of ids) {
      const exists = db.prepare('SELECT id FROM groups WHERE id = ?').get(id);
      if (exists) insert.run(userId, id);
    }
  });
  tx();
}

function addUserToDefaultGroup(userId) {
  const defaultId = getDefaultGroupId();
  if (!defaultId) {
    const standard = db.prepare("SELECT id FROM groups WHERE slug = 'standard'").get();
    if (standard) {
      db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(userId, standard.id);
    }
    return;
  }
  db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(userId, defaultId);
}

function createUserRecord({ username, fullName, password, isAdmin = false, isActive = true, playerId = null, groupIds, skipDefaultGroup = false }) {
  const login = normalizeUsername(username);
  if (getUserByUsername(login)) throw new Error('Username is already taken');
  const name = normalizeFullName(fullName);
  const hash = hashPassword(assertPassword(password));
  let resolvedPlayerId = null;
  if (playerId) {
    const player = db.prepare('SELECT id FROM players WHERE id = ?').get(Number(playerId));
    if (!player) throw new Error('Player not found');
    const taken = db.prepare('SELECT id FROM users WHERE player_id = ?').get(player.id);
    if (taken) throw new Error('That player is already linked to another user');
    resolvedPlayerId = player.id;
  }
  const info = db.prepare(`
    INSERT INTO users (username, full_name, password_hash, is_admin, is_active, player_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(login, name, hash, isAdmin ? 1 : 0, isActive ? 1 : 0, resolvedPlayerId, nowIso(), nowIso());
  if (Array.isArray(groupIds)) setUserGroups(info.lastInsertRowid, groupIds);
  else if (!skipDefaultGroup) addUserToDefaultGroup(info.lastInsertRowid);
  return getUserRow(info.lastInsertRowid);
}

function createUser(data, actor) {
  if (data.isAdmin && !actor?.isAdmin) {
    throw Object.assign(new Error('Only administrators can create administrator users'), { status: 403 });
  }
  return publicUser(createUserRecord(data), { includePermissions: true, includeSensitive: true });
}

function expandAssignmentKeys(key) {
  if (catalog.isDeprecatedPermission(key)) {
    const next = catalog.replacementKeysFor(key).filter((item) => item && knownPermission(item));
    return next.length ? next : [];
  }
  return knownPermission(key) ? [key] : [];
}

function replaceUserPermissions(userId, permissions) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(userId);
    const insert = db.prepare(`
      INSERT INTO user_permissions (user_id, permission_key, value, assignment_origin, created_at, updated_at)
      VALUES (?, ?, ?, 'manual', ?, ?)
    `);
    const flags = permissionFlags();
    const stamp = nowIso();
    const seen = new Set();
    for (const [key, value] of Object.entries(permissions || {})) {
      if (value !== 'allow' && value !== 'deny') continue;
      for (const target of expandAssignmentKeys(key)) {
        if (seen.has(target)) continue;
        if (flags[target] && flags[target].allowUser === false) continue;
        seen.add(target);
        insert.run(userId, target, value, stamp, stamp);
      }
    }
  });
  tx();
}

function updateUser(id, data, actor) {
  const row = getUserRow(id);
  if (!row) throw Object.assign(new Error('User not found'), { status: 404 });

  const next = {
    username: row.username,
    full_name: row.full_name,
    is_admin: row.is_admin,
    is_active: row.is_active,
    player_id: row.player_id,
  };

  if (data.fullName != null) next.full_name = normalizeFullName(data.fullName);
  if (data.isActive != null) next.is_active = data.isActive ? 1 : 0;
  if (data.isAdmin != null) {
    if (!actor?.isAdmin) {
      throw Object.assign(new Error('Only administrators can change administrator status'), { status: 403 });
    }
    next.is_admin = data.isAdmin ? 1 : 0;
  }
  if (data.playerId !== undefined) {
    if (data.playerId === null || data.playerId === '') {
      next.player_id = null;
    } else {
      const player = db.prepare('SELECT id FROM players WHERE id = ?').get(Number(data.playerId));
      if (!player) throw new Error('Player not found');
      const taken = db.prepare('SELECT id FROM users WHERE player_id = ? AND id != ?').get(player.id, id);
      if (taken) throw new Error('That player is already linked to another user');
      next.player_id = player.id;
    }
  }

  const disablingAdmin = row.is_admin === 1 && (next.is_active === 0 || next.is_admin === 0);
  const deletingAdminFlag = row.is_admin === 1 && next.is_admin === 0;
  if ((disablingAdmin || deletingAdminFlag) && !actor?.isAdmin) {
    throw Object.assign(new Error('Only administrators can disable or demote administrators'), { status: 403 });
  }
  if (row.is_admin === 1 && next.is_admin === 0 && countAdmins({ excludeUserId: id }) === 0) {
    throw new Error('There must always be at least one administrator');
  }
  if (row.is_admin === 1 && next.is_active === 0 && countAdmins({ excludeUserId: id, onlyActive: true }) === 0) {
    throw new Error('There must always be at least one active administrator');
  }

  db.prepare(`
    UPDATE users
    SET username = ?, full_name = ?, is_admin = ?, is_active = ?, player_id = ?, updated_at = ?
    WHERE id = ?
  `).run(next.username, next.full_name, next.is_admin, next.is_active, next.player_id, nowIso(), id);

  if (Array.isArray(data.groupIds)) setUserGroups(id, data.groupIds);
  if (data.userPermissions && typeof data.userPermissions === 'object') {
    replaceUserPermissions(id, data.userPermissions);
  }
  if (data.password) {
    setPassword(id, data.password, { invalidateSessions: true, keepSessionId: data.keepSessionId });
  }
  if (next.is_active === 0) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  return getUser(id, { includePermissions: true, includeSensitive: true });
}

function rememberPasswordHash(userId, passwordHash) {
  if (!userId || !passwordHash) return;
  db.prepare('INSERT INTO password_history (user_id, password_hash, created_at) VALUES (?, ?, ?)')
    .run(userId, passwordHash, nowIso());
  db.prepare(`
    DELETE FROM password_history
    WHERE user_id = ?
      AND id NOT IN (
        SELECT id FROM (
          SELECT id FROM password_history
          WHERE user_id = ?
          ORDER BY id DESC
          LIMIT 24
        )
      )
  `).run(userId, userId);
}

function setPassword(id, password, { invalidateSessions = false, keepSessionId = null } = {}) {
  const row = getUserRow(id);
  if (!row) throw Object.assign(new Error('User not found'), { status: 404 });
  const value = assertPassword(password, { userId: id });
  if (row.password_hash) rememberPasswordHash(id, row.password_hash);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(value), nowIso(), id);
  if (invalidateSessions) {
    if (keepSessionId) {
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(id, keepSessionId);
    } else {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
  }
}

function deleteUser(id, actor) {
  const row = getUserRow(id);
  if (!row) throw Object.assign(new Error('User not found'), { status: 404 });
  if (row.is_admin === 1 && !actor?.isAdmin) {
    throw Object.assign(new Error('Only administrators can delete administrators'), { status: 403 });
  }
  if (row.is_admin === 1 && countAdmins({ excludeUserId: id }) === 0) {
    throw new Error('There must always be at least one administrator');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { success: true };
}

function listGroups() {
  return db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id) AS user_count
    FROM groups g
    ORDER BY g.name COLLATE NOCASE
  `).all().map(publicGroup);
}

function publicGroup(row, { includePermissions = false, includeUsers = false } = {}) {
  if (!row) return null;
  const payload = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description || '',
    isActive: row.is_active === 1,
    isSystem: row.is_system === 1,
    systemKey: row.system_key || null,
    defaultsVersion: row.defaults_version || 0,
    userCount: row.user_count != null
      ? row.user_count
      : db.prepare('SELECT COUNT(*) AS n FROM user_groups WHERE group_id = ?').get(row.id).n,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includePermissions) {
    payload.permissions = {};
    const rows = db.prepare('SELECT permission_key, value FROM group_permissions WHERE group_id = ?').all(row.id);
    for (const item of rows) payload.permissions[item.permission_key] = item.value;
  }
  if (includeUsers) {
    payload.users = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.is_admin, u.is_active
      FROM users u
      JOIN user_groups ug ON ug.user_id = u.id
      WHERE ug.group_id = ?
      ORDER BY u.full_name COLLATE NOCASE
    `).all(row.id).map((u) => ({
      id: u.id,
      username: u.username,
      fullName: u.full_name,
      isAdmin: u.is_admin === 1,
      isActive: u.is_active === 1,
    }));
  }
  return payload;
}

function getGroup(id, opts) {
  const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!row) return null;
  return publicGroup(row, opts);
}

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || `group-${Date.now()}`;
}

function createGroup({ name }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Group name is required');
  const existing = db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE').get(trimmed);
  if (existing) throw new Error('A group with that name already exists');
  let slug = slugify(trimmed);
  let n = 1;
  while (db.prepare('SELECT id FROM groups WHERE slug = ?').get(slug)) {
    slug = `${slugify(trimmed)}-${n++}`;
  }
  const info = db.prepare(`
    INSERT INTO groups (name, slug, is_active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
  `).run(trimmed, slug, nowIso(), nowIso());
  return getGroup(info.lastInsertRowid, { includePermissions: true, includeUsers: true });
}

function replaceGroupPermissions(groupId, permissions) {
  const flags = permissionFlags();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM group_permissions WHERE group_id = ?').run(groupId);
    const insert = db.prepare(`
      INSERT INTO group_permissions (group_id, permission_key, value, assignment_origin, created_at, updated_at)
      VALUES (?, ?, ?, 'manual', ?, ?)
    `);
    const stamp = nowIso();
    const seen = new Set();
    for (const [key, value] of Object.entries(permissions || {})) {
      if (value !== 'allow' && value !== 'deny') continue;
      for (const target of expandAssignmentKeys(key)) {
        if (seen.has(`${target}:${value}`)) continue;
        if (flags[target] && flags[target].allowGroup === false) continue;
        seen.add(`${target}:${value}`);
        insert.run(groupId, target, value, stamp, stamp);
      }
    }
  });
  tx();
}

function setGroupUsers(groupId, userIds) {
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  db.prepare('DELETE FROM user_groups WHERE group_id = ?').run(groupId);
  const insert = db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)');
  for (const id of ids) insert.run(id, groupId);
}

function applyGroupMembership(groupId, userIds, actor) {
  const incoming = Array.isArray(userIds) ? userIds : [];
  const requested = [];
  const seen = new Set();
  for (const raw of incoming) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1 || !getUserRow(id)) {
      throw Object.assign(new Error('Invalid user id'), { status: 400 });
    }
    if (seen.has(id)) continue;
    seen.add(id);
    requested.push(id);
  }
  const current = db.prepare('SELECT user_id AS id FROM user_groups WHERE group_id = ?').all(groupId).map((row) => row.id);
  const currentSet = new Set(current);
  const requestedSet = new Set(requested);
  const addedIds = requested.filter((id) => !currentSet.has(id));
  const removedIds = current.filter((id) => !requestedSet.has(id));
  const errors = require('../security/errors');
  if (actor && !actor.isAdmin) {
    if (addedIds.length && !hasPermission(actor, 'groups.add_members')) {
      throw errors.permissionRequired('groups.add_members');
    }
    if (removedIds.length && !hasPermission(actor, 'groups.remove_members')) {
      throw errors.permissionRequired('groups.remove_members');
    }
  }
  setGroupUsers(groupId, requested);
}

function updateGroup(id, data, actor) {
  const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!row) throw Object.assign(new Error('Group not found'), { status: 404 });
  const nextName = data.name != null ? String(data.name).trim() : row.name;
  if (!nextName) throw new Error('Group name is required');
  const clash = db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE AND id != ?').get(nextName, id);
  if (clash) throw new Error('A group with that name already exists');
  const nextActive = data.isActive == null ? row.is_active : (data.isActive ? 1 : 0);
  const tx = db.transaction(() => {
    db.prepare('UPDATE groups SET name = ?, is_active = ?, updated_at = ? WHERE id = ?')
      .run(nextName, nextActive, nowIso(), id);
    if (data.permissions && typeof data.permissions === 'object') {
      replaceGroupPermissions(id, data.permissions);
    }
    if (Array.isArray(data.userIds)) applyGroupMembership(id, data.userIds, actor);
  });
  tx.immediate();
  return getGroup(id, { includePermissions: true, includeUsers: true });
}

function deleteGroup(id) {
  const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!row) throw Object.assign(new Error('Group not found'), { status: 404 });
  if (row.is_system === 1) {
    throw Object.assign(new Error('Built-in groups cannot be deleted'), { status: 400 });
  }
  db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  return { success: true };
}

function listPermissionDefs({ includeDeprecated = false } = {}) {
  return db.prepare(`
    SELECT key, name, description, category, allow_user, allow_group,
      display_name, primary_category, subcategory, source, plugin_id, risk_level,
      assignable_to_users, assignable_to_groups, active, deprecated, schema_version
    FROM permission_defs
    ORDER BY COALESCE(primary_category, category), COALESCE(display_name, name)
  `).all().flatMap((row) => {
    const meta = catalog.permissionByKey(row.key) || {};
    if (row.deprecated === 1 && !includeDeprecated && !meta.deprecated) return [];
    if ((meta.deprecated || row.deprecated === 1) && !includeDeprecated) return [];
    return [{
      key: row.key,
      name: row.display_name || row.name,
      displayName: row.display_name || row.name,
      description: row.description,
      category: row.primary_category || row.category,
      primaryCategory: row.primary_category || row.category,
      subcategory: row.subcategory || meta.subcategory || null,
      allowUser: row.allow_user === 1,
      allowGroup: row.allow_group === 1,
      assignableToUsers: row.assignable_to_users === 1,
      assignableToGroups: row.assignable_to_groups === 1,
      pluginId: row.plugin_id || meta.pluginId || null,
      source: row.source || meta.source || 'core',
      sourceLabel: meta.sourceLabel || (row.source === 'first-party-plugin' ? 'First-party plugin' : row.source === 'third-party-plugin' ? 'Third-party plugin' : 'Core'),
      riskLevel: row.risk_level || meta.riskLevel || 'normal',
      active: row.active !== 0,
      deprecated: row.deprecated === 1 || Boolean(meta.deprecated),
      schemaVersion: row.schema_version || meta.schemaVersion || catalog.CATALOG_SCHEMA_VERSION,
    }];
  });
}

function updatePermissionDef(key, { allowUser, allowGroup }) {
  const row = db.prepare('SELECT key FROM permission_defs WHERE key = ?').get(key);
  if (!row) throw Object.assign(new Error('Permission not found'), { status: 404 });
  const current = db.prepare('SELECT allow_user, allow_group FROM permission_defs WHERE key = ?').get(key);
  const nextUser = allowUser == null ? current.allow_user : (allowUser ? 1 : 0);
  const nextGroup = allowGroup == null ? current.allow_group : (allowGroup ? 1 : 0);
  db.prepare('UPDATE permission_defs SET allow_user = ?, allow_group = ? WHERE key = ?')
    .run(nextUser, nextGroup, key);
  return listPermissionDefs().find((item) => item.key === key);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const hours = getSessionHours();
  const expires = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (id, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, nowIso(), expires);
  return { token, expiresAt: expires, maxAge: hours * 60 * 60 };
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}

function getSessionUser(token) {
  if (!token) return null;
  purgeExpiredSessions();
  const session = db.prepare(`
    SELECT s.id AS session_id, s.expires_at, u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(token);
  if (!session) return null;
  if (session.is_active !== 1) return null;
  const user = publicUser(session, { includePermissions: true });
  user.sessionId = session.session_id;
  return user;
}

function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

function login(username, password) {
  const loginName = String(username || '').trim();
  const secret = String(password || '');
  if (!isValidUsername(loginName) || !secret || secret.length > PASSWORD_MAX) {
    throw Object.assign(new Error('Invalid username or password'), { status: 401 });
  }
  const row = getUserByUsername(loginName);
  if (!row || !verifyPassword(secret, row.password_hash)) {
    throw Object.assign(new Error('Invalid username or password'), { status: 401 });
  }
  if (row.is_active !== 1) {
    throw Object.assign(new Error('This account is deactivated'), { status: 403 });
  }
  const session = createSession(row.id);
  const user = publicUser(row, { includePermissions: true });
  return { user, session };
}

function cookieHeader(token, maxAge) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Number(maxAge) || 0)}`,
  ];
  return parts.join('; ');
}

function clearCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    out[key] = val;
  }
  return out;
}

function tokenFromRequest(req) {
  const header = req.headers?.authorization || '';
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  if (req.headers?.['x-session-token']) return String(req.headers['x-session-token']).trim();
  return parseCookies(req)[SESSION_COOKIE] || '';
}

function lastAdminGuard(userId) {
  const row = getUserRow(userId);
  if (!row || row.is_admin !== 1) return { isLastAdmin: false, isAdmin: false };
  return {
    isAdmin: true,
    isLastAdmin: countAdmins({ excludeUserId: userId, onlyActive: true }) === 0,
  };
}

module.exports = {
  SESSION_COOKIE,
  DEFAULT_USERNAME,
  DEFAULT_PASSWORD,
  KEYS,
  ensureSeed,
  ensurePermissionRows,
  hashPassword,
  verifyPassword,
  hasPermission,
  collectGlobalSources,
  canAccessUserManagement,
  listUsers,
  getUser,
  getUserRow,
  createUser,
  updateUser,
  deleteUser,
  setPassword,
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  listPermissionDefs,
  updatePermissionDef,
  publicSettings,
  saveSettings,
  getPasswordPolicy,
  isValidUsername,
  login,
  getSessionUser,
  destroySession,
  tokenFromRequest,
  cookieHeader,
  clearCookieHeader,
  lastAdminGuard,
  evaluatePermissions,
  loadGroupsForUser,
  countAdmins,
  syncDynamicPermissions,
  needsAdministratorBootstrap,
  bootstrapAdministrator,
  resetSystemGroupDefaults: (...args) => require('./permissionCatalogMigration').resetSystemGroupDefaults(...args),
};
