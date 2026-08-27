const crypto = require('crypto');
const schema = require('./schema');

const PROVIDER_ID = 'server-access';
const ACCESS_MODES = new Set(['inherited', 'restricted']);

function database() {
  return require('../../db/connection');
}

function catalog() {
  return require('../../services/permissionCatalog');
}

function decision() {
  return require('../../security/decision');
}

function slugify(name) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'group';
  return base;
}

function nowIso() {
  return new Date().toISOString();
}

function publicUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name || row.fullName,
    isAdmin: row.is_admin === 1 || row.isAdmin === true,
    isActive: row.is_active === 1 || row.isActive !== false,
  };
}

function ensureMigrated() {
  schema.migrate(database());
}

function policyOf(serverId) {
  const db = database();
  const row = db.prepare(`
    SELECT server_id AS serverId, access_mode AS accessMode, provider_id AS providerId
    FROM server_access_policies WHERE server_id = ?
  `).get(Number(serverId));
  return row || { serverId: Number(serverId), accessMode: 'inherited', providerId: PROVIDER_ID };
}

function ensurePolicy(serverId) {
  const db = database();
  db.prepare(`
    INSERT OR IGNORE INTO server_access_policies (server_id, access_mode, provider_id, created_at, updated_at)
    VALUES (?, 'inherited', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(Number(serverId), PROVIDER_ID);
  return policyOf(serverId);
}

function setAccessMode(serverId, accessMode, actor) {
  if (!ACCESS_MODES.has(accessMode)) {
    throw Object.assign(new Error('accessMode must be inherited or restricted'), { status: 400 });
  }
  const db = database();
  const previous = policyOf(serverId);
  ensurePolicy(serverId);
  db.prepare(`
    UPDATE server_access_policies
    SET access_mode = ?, updated_at = CURRENT_TIMESTAMP
    WHERE server_id = ?
  `).run(accessMode, Number(serverId));
  audit('server_access.mode.change', actor, serverId, {
    before: previous.accessMode,
    after: accessMode,
  });
  notifyChanged(serverId);
  return policyOf(serverId);
}

function listGroups(serverId) {
  const db = database();
  return db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM server_access_group_members m WHERE m.group_id = g.id) AS member_count
    FROM server_access_groups g
    WHERE g.server_id = ?
    ORDER BY g.name COLLATE NOCASE
  `).all(Number(serverId)).map(publicGroup);
}

function publicGroup(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    slug: row.slug,
    description: row.description || '',
    isActive: row.is_active === 1,
    memberCount: row.member_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

function getGroup(serverId, groupId) {
  const db = database();
  const row = db.prepare('SELECT * FROM server_access_groups WHERE id = ? AND server_id = ?')
    .get(Number(groupId), Number(serverId));
  if (!row) return null;
  const members = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.is_admin, u.is_active
    FROM users u
    JOIN server_access_group_members m ON m.user_id = u.id
    WHERE m.group_id = ?
    ORDER BY u.full_name COLLATE NOCASE
  `).all(row.id).map(publicUserRow);
  const permissions = {};
  for (const item of db.prepare('SELECT permission_key, value FROM server_access_group_permissions WHERE group_id = ?').all(row.id)) {
    permissions[item.permission_key] = item.value;
  }
  return publicGroup(row, { users: members, permissions });
}

function uniqueSlug(serverId, name, excludeId = null) {
  const db = database();
  let slug = slugify(name);
  let n = 0;
  for (;;) {
    const candidate = n ? `${slug}-${n}` : slug;
    const row = db.prepare('SELECT id FROM server_access_groups WHERE server_id = ? AND slug = ?')
      .get(Number(serverId), candidate);
    if (!row || Number(row.id) === Number(excludeId)) return candidate;
    n += 1;
    if (n > 50) return `${slug}-${crypto.randomBytes(3).toString('hex')}`;
  }
}

function createGroup(serverId, input, actor) {
  const name = String(input?.name || '').trim();
  if (!name) throw Object.assign(new Error('Group name is required'), { status: 400 });
  const db = database();
  const slug = uniqueSlug(serverId, name);
  let id;
  try {
    const result = db.prepare(`
      INSERT INTO server_access_groups (server_id, name, slug, description, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(Number(serverId), name, slug, String(input.description || '').trim());
    id = result.lastInsertRowid;
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw Object.assign(new Error('A group with that name already exists on this server'), { status: 409 });
    }
    throw err;
  }
  audit('server_access.groups.create', actor, serverId, { groupId: id, name });
  notifyChanged(serverId);
  return getGroup(serverId, id);
}

function updateGroup(serverId, groupId, input, actor) {
  const current = getGroup(serverId, groupId);
  if (!current) throw Object.assign(new Error('Group not found'), { status: 404 });
  const db = database();
  const nextName = input.name != null ? String(input.name).trim() : current.name;
  if (!nextName) throw Object.assign(new Error('Group name is required'), { status: 400 });
  const slug = nextName !== current.name ? uniqueSlug(serverId, nextName, groupId) : current.slug;
  const description = input.description != null ? String(input.description) : current.description;
  const isActive = input.isActive == null ? current.isActive : Boolean(input.isActive);
  const wantedIds = input.userIds ? normalizeUserIds(input.userIds) : null;
  if (wantedIds) assertKnownUsers(wantedIds);
  if (input.permissions) assertAssignableMap(serverId, input.permissions, actor);
  const memberBefore = wantedIds
    ? db.prepare('SELECT user_id AS id FROM server_access_group_members WHERE group_id = ?').all(Number(groupId)).map((row) => row.id)
    : null;
  const permBefore = input.permissions ? groupPermissionMap(groupId) : null;
  const run = db.transaction(() => {
    db.prepare(`
      UPDATE server_access_groups
      SET name = ?, slug = ?, description = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND server_id = ?
    `).run(nextName, slug, description, isActive ? 1 : 0, Number(groupId), Number(serverId));
    if (wantedIds) replaceGroupMembers(groupId, wantedIds);
    if (input.permissions) replaceGroupPermissions(groupId, input.permissions);
  });
  run();
  audit('server_access.groups.edit', actor, serverId, {
    groupId,
    before: { name: current.name, isActive: current.isActive },
    after: { name: nextName, isActive },
  });
  if (wantedIds) {
    const added = wantedIds.filter((id) => !memberBefore.includes(id));
    const removed = memberBefore.filter((id) => !wantedIds.includes(id));
    if (added.length) audit('server_access.groups.add_members', actor, serverId, { groupId, userIds: added });
    if (removed.length) audit('server_access.groups.remove_members', actor, serverId, { groupId, userIds: removed });
  }
  if (input.permissions) {
    audit('server_access.groups.assign_permissions', actor, serverId, {
      groupId,
      before: permBefore,
      after: input.permissions,
    });
  }
  notifyChanged(serverId);
  return getGroup(serverId, groupId);
}

function deleteGroup(serverId, groupId, actor) {
  const current = getGroup(serverId, groupId);
  if (!current) throw Object.assign(new Error('Group not found'), { status: 404 });
  const run = database().transaction(() => {
    database().prepare('DELETE FROM server_access_groups WHERE id = ? AND server_id = ?')
      .run(Number(groupId), Number(serverId));
  });
  run();
  audit('server_access.groups.delete', actor, serverId, { groupId, name: current.name });
  notifyChanged(serverId);
  return { ok: true };
}

function normalizeUserIds(userIds) {
  return [...new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function assertKnownUsers(userIds) {
  const db = database();
  for (const userId of userIds) {
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) {
      throw Object.assign(new Error('Unknown user'), { status: 400 });
    }
  }
}

function replaceGroupMembers(groupId, wanted) {
  const db = database();
  db.prepare('DELETE FROM server_access_group_members WHERE group_id = ?').run(Number(groupId));
  const insert = db.prepare('INSERT INTO server_access_group_members (group_id, user_id, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
  for (const userId of wanted) insert.run(Number(groupId), userId);
}

function groupPermissionMap(groupId) {
  const before = {};
  for (const item of database().prepare('SELECT permission_key, value FROM server_access_group_permissions WHERE group_id = ?').all(Number(groupId))) {
    before[item.permission_key] = item.value;
  }
  return before;
}

function replaceGroupPermissions(groupId, permissions) {
  const db = database();
  db.prepare('DELETE FROM server_access_group_permissions WHERE group_id = ?').run(Number(groupId));
  const insert = db.prepare(`
    INSERT INTO server_access_group_permissions (group_id, permission_key, value, assignment_origin, created_at, updated_at)
    VALUES (?, ?, ?, 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  for (const [key, value] of Object.entries(permissions || {})) {
    if (value !== 'allow' && value !== 'deny') continue;
    insert.run(Number(groupId), catalog().canonicalPermission(key), value);
  }
}

function applyGroupMembers(serverId, groupId, userIds, actor, { skipNotify } = {}) {
  const wanted = normalizeUserIds(userIds);
  assertKnownUsers(wanted);
  const db = database();
  const current = db.prepare('SELECT user_id AS id FROM server_access_group_members WHERE group_id = ?')
    .all(Number(groupId)).map((row) => row.id);
  const run = db.transaction(() => replaceGroupMembers(groupId, wanted));
  run();
  const currentSet = new Set(current);
  const wantedSet = new Set(wanted);
  const added = wanted.filter((id) => !currentSet.has(id));
  const removed = current.filter((id) => !wantedSet.has(id));
  if (added.length) audit('server_access.groups.add_members', actor, serverId, { groupId, userIds: added });
  if (removed.length) audit('server_access.groups.remove_members', actor, serverId, { groupId, userIds: removed });
  if (!skipNotify) notifyChanged(serverId);
}

function applyGroupPermissions(serverId, groupId, permissions, actor, { skipNotify } = {}) {
  assertAssignableMap(serverId, permissions, actor);
  const before = groupPermissionMap(groupId);
  const run = database().transaction(() => replaceGroupPermissions(groupId, permissions));
  run();
  audit('server_access.groups.assign_permissions', actor, serverId, { groupId, before, after: permissions || {} });
  if (!skipNotify) notifyChanged(serverId);
}

function listAssignedUsers(serverId) {
  const db = database();
  const explicit = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.is_admin, u.is_active, a.is_active AS assignment_active
    FROM server_access_users a
    JOIN users u ON u.id = a.user_id
    WHERE a.server_id = ?
    ORDER BY u.full_name COLLATE NOCASE
  `).all(Number(serverId));
  const fromGroups = db.prepare(`
    SELECT DISTINCT u.id, u.username, u.full_name, u.is_admin, u.is_active
    FROM users u
    JOIN server_access_group_members m ON m.user_id = u.id
    JOIN server_access_groups g ON g.id = m.group_id
    WHERE g.server_id = ? AND g.is_active = 1
  `).all(Number(serverId));
  const map = new Map();
  for (const row of [...explicit, ...fromGroups]) {
    const current = map.get(row.id) || publicUserRow(row);
    current.explicit = Boolean(explicit.find((item) => item.id === row.id));
    current.viaGroup = Boolean(fromGroups.find((item) => item.id === row.id));
    map.set(row.id, current);
  }
  return [...map.values()];
}

function getAssignedUser(serverId, userId) {
  const db = database();
  const user = db.prepare('SELECT id, username, full_name, is_admin, is_active FROM users WHERE id = ?')
    .get(Number(userId));
  if (!user) return null;
  const assignment = db.prepare('SELECT * FROM server_access_users WHERE server_id = ? AND user_id = ?')
    .get(Number(serverId), Number(userId));
  const groups = db.prepare(`
    SELECT g.id, g.name, g.slug, g.is_active
    FROM server_access_groups g
    JOIN server_access_group_members m ON m.group_id = g.id
    WHERE g.server_id = ? AND m.user_id = ?
  `).all(Number(serverId), Number(userId));
  const permissions = {};
  for (const item of db.prepare(`
    SELECT permission_key, value FROM server_access_user_permissions
    WHERE server_id = ? AND user_id = ?
  `).all(Number(serverId), Number(userId))) {
    permissions[item.permission_key] = item.value;
  }
  return {
    ...publicUserRow(user),
    explicit: Boolean(assignment),
    assignmentActive: assignment ? assignment.is_active === 1 : false,
    groups: groups.map((g) => ({ id: g.id, name: g.name, slug: g.slug, isActive: g.is_active === 1 })),
    permissions,
  };
}

function addUser(serverId, userId, actor) {
  const db = database();
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId));
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO server_access_users (server_id, user_id, is_active, created_at, updated_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(server_id, user_id) DO UPDATE SET is_active = 1, updated_at = CURRENT_TIMESTAMP
    `).run(Number(serverId), Number(userId));
  });
  run();
  audit('server_access.users.add', actor, serverId, { userId: Number(userId) });
  notifyChanged(serverId);
  return getAssignedUser(serverId, userId);
}

function updateUser(serverId, userId, input, actor) {
  const current = getAssignedUser(serverId, userId);
  if (!current) throw Object.assign(new Error('User not found'), { status: 404 });
  const db = database();
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId));
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (input.permissions) assertAssignableMap(serverId, input.permissions, actor);
  const permBefore = input.permissions ? userPermissionMap(serverId, userId) : null;
  const run = db.transaction(() => {
    if (input.isActive != null || input.explicit) {
      db.prepare(`
        INSERT INTO server_access_users (server_id, user_id, is_active, created_at, updated_at)
        VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(server_id, user_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
      `).run(Number(serverId), Number(userId));
      if (input.isActive != null) {
        db.prepare('UPDATE server_access_users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE server_id = ? AND user_id = ?')
          .run(input.isActive ? 1 : 0, Number(serverId), Number(userId));
      }
    }
    if (input.permissions) replaceUserPermissions(serverId, userId, input.permissions);
  });
  run();
  if (input.isActive != null || input.explicit) {
    audit('server_access.users.add', actor, serverId, { userId: Number(userId), isActive: input.isActive });
  }
  if (input.permissions) {
    audit('server_access.users.assign_permissions', actor, serverId, {
      userId,
      before: permBefore,
      after: input.permissions,
    });
  }
  notifyChanged(serverId);
  return getAssignedUser(serverId, userId);
}

function removeUser(serverId, userId, actor) {
  const db = database();
  const run = db.transaction(() => {
    db.prepare('DELETE FROM server_access_users WHERE server_id = ? AND user_id = ?')
      .run(Number(serverId), Number(userId));
    db.prepare('DELETE FROM server_access_user_permissions WHERE server_id = ? AND user_id = ?')
      .run(Number(serverId), Number(userId));
  });
  run();
  audit('server_access.users.remove', actor, serverId, { userId: Number(userId) });
  notifyChanged(serverId);
  return { ok: true };
}

function userPermissionMap(serverId, userId) {
  const before = {};
  for (const item of database().prepare(`
    SELECT permission_key, value FROM server_access_user_permissions WHERE server_id = ? AND user_id = ?
  `).all(Number(serverId), Number(userId))) {
    before[item.permission_key] = item.value;
  }
  return before;
}

function replaceUserPermissions(serverId, userId, permissions) {
  const db = database();
  db.prepare('DELETE FROM server_access_user_permissions WHERE server_id = ? AND user_id = ?')
    .run(Number(serverId), Number(userId));
  const insert = db.prepare(`
    INSERT INTO server_access_user_permissions (server_id, user_id, permission_key, value, assignment_origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  for (const [key, value] of Object.entries(permissions || {})) {
    if (value !== 'allow' && value !== 'deny') continue;
    insert.run(Number(serverId), Number(userId), catalog().canonicalPermission(key), value);
  }
}

function applyUserPermissions(serverId, userId, permissions, actor, { skipNotify } = {}) {
  assertAssignableMap(serverId, permissions, actor);
  const before = userPermissionMap(serverId, userId);
  const run = database().transaction(() => replaceUserPermissions(serverId, userId, permissions));
  run();
  audit('server_access.users.assign_permissions', actor, serverId, { userId, before, after: permissions || {} });
  if (!skipNotify) notifyChanged(serverId);
}

function serverKind(serverId) {
  const row = database().prepare('SELECT kind FROM servers WHERE id = ?').get(Number(serverId));
  return row?.kind || 'bedrock';
}

function assertAssignableMap(serverId, permissions, actor) {
  const cat = catalog();
  const kind = serverKind(serverId);
  const security = require('../../security');
  for (const [key, value] of Object.entries(permissions || {})) {
    if (value !== 'allow' && value !== 'deny' && value !== '' && value != null) {
      throw Object.assign(new Error(`Invalid assignment for ${key}`), { status: 400 });
    }
    if (value !== 'allow' && value !== 'deny') continue;
    const canonical = cat.canonicalPermission(key);
    const def = cat.permissionByKey(canonical);
    if (!def) {
      throw Object.assign(new Error(`Unknown permission ${key}`), { status: 400 });
    }
    if (def.active === false && !def.deprecated) {
      throw Object.assign(new Error(`${canonical} is inactive and cannot be assigned`), { status: 400 });
    }
    if (!cat.isServerAssignable(canonical, kind)) {
      const kinds = def.serverKinds || [];
      if (kinds.length && kind) {
        throw Object.assign(new Error(`${canonical} is not compatible with ${kind} servers`), { status: 400 });
      }
      throw Object.assign(new Error(`${canonical} cannot be assigned at server scope`), { status: 400 });
    }
    if (actor && !security.isAdministrator(actor) && value === 'allow') {
      if (!security.authorize(actor, canonical, { type: 'server', id: Number(serverId), kind })) {
        throw Object.assign(new Error(`You cannot grant ${canonical} because you do not hold it on this server`), {
          status: 403,
          code: 'PERMISSION_REQUIRED',
          permission: canonical,
        });
      }
    }
  }
}

function isAssigned(principal, serverId) {
  if (!principal?.id) return false;
  if (principal.isAdmin) return true;
  const db = database();
  const explicit = db.prepare(`
    SELECT 1 FROM server_access_users
    WHERE server_id = ? AND user_id = ? AND is_active = 1
  `).get(Number(serverId), Number(principal.id));
  if (explicit) return true;
  const grouped = db.prepare(`
    SELECT 1
    FROM server_access_group_members m
    JOIN server_access_groups g ON g.id = m.group_id
    WHERE g.server_id = ? AND g.is_active = 1 AND m.user_id = ?
  `).get(Number(serverId), Number(principal.id));
  return Boolean(grouped);
}

function inspectMembership(principal, resource) {
  const serverId = Number(resource?.id);
  const policy = policyOf(serverId);
  return {
    accessMode: policy.accessMode || 'inherited',
    assigned: isAssigned(principal, serverId),
  };
}

function collectSources(principal, permission, resource) {
  if (!principal?.id) return [];
  const serverId = Number(resource?.id);
  const db = database();
  const cat = catalog();
  const canonical = cat.canonicalPermission(permission);
  const aliases = new Set(cat.permissionAliases(canonical));
  const sources = [];
  const groupRows = db.prepare(`
    SELECT g.id, g.name, gp.permission_key, gp.value
    FROM server_access_group_permissions gp
    JOIN server_access_groups g ON g.id = gp.group_id
    JOIN server_access_group_members m ON m.group_id = g.id
    WHERE g.server_id = ? AND g.is_active = 1 AND m.user_id = ?
  `).all(serverId, Number(principal.id));
  for (const item of groupRows) {
    if (!aliases.has(item.permission_key) && item.permission_key !== canonical) continue;
    sources.push(decision().source({
      origin: 'server-group',
      scope: 'server',
      value: item.value,
      groupId: item.id,
      groupName: item.name,
      permission: canonical,
    }));
  }
  const userRows = db.prepare(`
    SELECT up.permission_key, up.value
    FROM server_access_user_permissions up
    JOIN server_access_users a
      ON a.server_id = up.server_id AND a.user_id = up.user_id
    WHERE up.server_id = ? AND up.user_id = ? AND a.is_active = 1
  `).all(serverId, Number(principal.id));
  for (const item of userRows) {
    if (!aliases.has(item.permission_key) && item.permission_key !== canonical) continue;
    sources.push(decision().source({
      origin: 'server-user',
      scope: 'server',
      value: item.value,
      userId: Number(principal.id),
      permission: canonical,
    }));
  }
  return sources;
}

function getEffectivePermissions(principal, resource) {
  const security = require('../../security');
  const cat = catalog();
  const keys = cat.listServerAssignablePermissions(resource?.kind);
  const permissions = {};
  for (const item of keys) {
    permissions[item.key] = security.decide(principal, item.key, resource);
  }
  return {
    accessMode: inspectMembership(principal, resource).accessMode,
    assigned: inspectMembership(principal, resource).assigned,
    permissions,
  };
}

function listAssignablePermissions(resource) {
  return catalog().listServerAssignablePermissions(resource?.kind);
}

function getDisableImpact() {
  const db = database();
  const configuredServers = db.prepare('SELECT COUNT(*) AS n FROM server_access_policies').get().n;
  const serverGroups = db.prepare('SELECT COUNT(*) AS n FROM server_access_groups').get().n;
  const assignedUsers = db.prepare('SELECT COUNT(*) AS n FROM server_access_users').get().n;
  const allowAssignments = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM server_access_group_permissions WHERE value = 'allow')
      + (SELECT COUNT(*) FROM server_access_user_permissions WHERE value = 'allow') AS n
  `).get().n;
  const denyAssignments = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM server_access_group_permissions WHERE value = 'deny')
      + (SELECT COUNT(*) FROM server_access_user_permissions WHERE value = 'deny') AS n
  `).get().n;
  const restrictedServers = db.prepare(`
    SELECT COUNT(*) AS n FROM server_access_policies WHERE access_mode = 'restricted'
  `).get().n;
  return {
    required: true,
    configuredServers,
    serverGroups,
    assignedUsers,
    allowAssignments,
    denyAssignments,
    restrictedServers,
    message: 'Disabling Server Access Control returns affected servers to global RBAC. Restricted servers become visible under global rules, and server-specific denies stop applying.',
  };
}

function snapshot(serverId) {
  return {
    policy: policyOf(serverId),
    groups: listGroups(serverId),
    users: listAssignedUsers(serverId),
  };
}

function audit(event, actor, serverId, detail) {
  try {
    require('../../security').audit(event, {
      principal: actor,
      resource: { type: 'server', id: serverId },
      detail,
    });
  } catch {
    /* ignore */
  }
}

function notifyChanged(serverId) {
  try {
    const pluginEvents = require('../../services/pluginEvents');
    pluginEvents.emit('server-access.changed', { serverId });
  } catch { /* ignore */ }
  try {
    if (global.io) require('../../security/socketAuth').revalidateSubscriptions(global.io);
  } catch { /* ignore */ }
}

function listDirectoryUsers() {
  return database().prepare(`
    SELECT id, username, full_name, is_admin, is_active
    FROM users
    ORDER BY full_name COLLATE NOCASE, username COLLATE NOCASE
  `).all().map(publicUserRow);
}

module.exports = {
  PROVIDER_ID,
  ensureMigrated,
  policyOf,
  ensurePolicy,
  setAccessMode,
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  listAssignedUsers,
  getAssignedUser,
  addUser,
  updateUser,
  removeUser,
  inspectMembership,
  collectSources,
  getEffectivePermissions,
  listAssignablePermissions,
  getDisableImpact,
  snapshot,
  listDirectoryUsers,
  applyUserPermissions,
  applyGroupMembers,
  applyGroupPermissions,
};

