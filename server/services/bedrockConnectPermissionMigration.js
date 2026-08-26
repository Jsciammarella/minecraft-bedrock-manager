const db = require('../db/connection');
const logger = require('./logger');
const pluginAudit = require('./pluginAudit');
const settingsStore = require('./settingsStore');

const SCHEMA_KEY = 'bedrock_connect_permission_schema';
const SCHEMA_VERSION = '1';

const EXPANSIONS = [
  { from: 'menu.view.bedrock_connect', to: ['bedrock_connect.view', 'bedrock_connect.view_status', 'bedrock_connect.dns.view'], menuDefault: true },
  { from: 'servers.create_bedrock_connect', to: ['bedrock_connect.create'] },
  { from: 'servers.start_bedrock_connect', to: ['bedrock_connect.start'] },
  { from: 'servers.stop_bedrock_connect', to: ['bedrock_connect.stop'] },
  { from: 'bedrock_connect.enable_dns_proxy', to: ['bedrock_connect.dns.enable_proxy'] },
  { from: 'bedrock_connect.set_upstream_dns', to: ['bedrock_connect.dns.set_upstream'] },
  { from: 'bedrock_connect.set_dns_overrides', to: [
    'bedrock_connect.dns.add_override',
    'bedrock_connect.dns.edit_override',
    'bedrock_connect.dns.remove_override',
  ] },
  { from: 'servers.change_general_settings', to: ['bedrock_connect.change_ports', 'bedrock_connect.change_settings'], onlyIfLegacyBc: true },
  { from: 'servers.delete', to: ['bedrock_connect.delete'], onlyIfLegacyBc: true },
];

const LEGACY_BC_KEYS = [
  'menu.view.bedrock_connect',
  'servers.create_bedrock_connect',
  'servers.start_bedrock_connect',
  'servers.stop_bedrock_connect',
  'bedrock_connect.enable_dns_proxy',
  'bedrock_connect.set_upstream_dns',
  'bedrock_connect.set_dns_overrides',
];

function currentVersion() {
  return String(settingsStore.get(SCHEMA_KEY) || '').trim();
}

function copyAssignment(table, ownerColumn, ownerId, fromKey, toKey, value) {
  db.prepare(`
    INSERT INTO ${table} (${ownerColumn}, permission_key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(${ownerColumn}, permission_key) DO NOTHING
  `).run(ownerId, toKey, value);
}

function hasAnyLegacyRows() {
  const keys = LEGACY_BC_KEYS;
  const placeholders = keys.map(() => '?').join(', ');
  const groupHit = db.prepare(`
    SELECT 1 AS ok FROM group_permissions WHERE permission_key IN (${placeholders}) LIMIT 1
  `).get(...keys);
  if (groupHit) return true;
  const userHit = db.prepare(`
    SELECT 1 AS ok FROM user_permissions WHERE permission_key IN (${placeholders}) LIMIT 1
  `).get(...keys);
  return Boolean(userHit);
}

function groupHasLegacyBc(getPerm, groupId) {
  return LEGACY_BC_KEYS.some((key) => getPerm.get(groupId, key)?.value === 'allow');
}

function migrateGroupExpansions() {
  const groups = db.prepare('SELECT id, slug FROM groups').all();
  const getPerm = db.prepare(`
    SELECT value FROM group_permissions WHERE group_id = ? AND permission_key = ?
  `);
  const applyMenuDefault = hasAnyLegacyRows();
  for (const group of groups) {
    const legacyBc = groupHasLegacyBc(getPerm, group.id);
    for (const rule of EXPANSIONS) {
      if (rule.onlyIfLegacyBc && !legacyBc) continue;
      const row = getPerm.get(group.id, rule.from);
      let value = row?.value || null;
      if (!value && rule.menuDefault && applyMenuDefault) value = 'allow';
      if (!value) continue;
      for (const target of rule.to) {
        copyAssignment('group_permissions', 'group_id', group.id, rule.from, target, value);
      }
    }
    const start = getPerm.get(group.id, 'servers.start_bedrock_connect')
      || getPerm.get(group.id, 'bedrock_connect.start');
    const stop = getPerm.get(group.id, 'servers.stop_bedrock_connect')
      || getPerm.get(group.id, 'bedrock_connect.stop');
    if (start?.value === 'allow' && stop?.value === 'allow') {
      copyAssignment('group_permissions', 'group_id', group.id, 'servers.start_bedrock_connect', 'bedrock_connect.restart', 'allow');
    } else if (start?.value === 'deny' || stop?.value === 'deny') {
      copyAssignment('group_permissions', 'group_id', group.id, 'servers.stop_bedrock_connect', 'bedrock_connect.restart', 'deny');
    }
  }
}

function migrateUserExpansions() {
  const users = db.prepare('SELECT id FROM users').all();
  const getPerm = db.prepare(`
    SELECT value FROM user_permissions WHERE user_id = ? AND permission_key = ?
  `);
  for (const user of users) {
    const legacyBc = LEGACY_BC_KEYS.some((key) => getPerm.get(user.id, key)?.value === 'allow');
    for (const rule of EXPANSIONS) {
      if (rule.onlyIfLegacyBc && !legacyBc) continue;
      const row = getPerm.get(user.id, rule.from);
      if (!row?.value) continue;
      for (const target of rule.to) {
        copyAssignment('user_permissions', 'user_id', user.id, rule.from, target, row.value);
      }
    }
    const start = getPerm.get(user.id, 'servers.start_bedrock_connect')
      || getPerm.get(user.id, 'bedrock_connect.start');
    const stop = getPerm.get(user.id, 'servers.stop_bedrock_connect')
      || getPerm.get(user.id, 'bedrock_connect.stop');
    if (start?.value === 'allow' && stop?.value === 'allow') {
      copyAssignment('user_permissions', 'user_id', user.id, 'servers.start_bedrock_connect', 'bedrock_connect.restart', 'allow');
    } else if (start?.value === 'deny' || stop?.value === 'deny') {
      copyAssignment('user_permissions', 'user_id', user.id, 'servers.stop_bedrock_connect', 'bedrock_connect.restart', 'deny');
    }
  }
}

function migrate() {
  const already = currentVersion() === SCHEMA_VERSION;
  const tx = db.transaction(() => {
    migrateGroupExpansions();
    migrateUserExpansions();
    settingsStore.set(SCHEMA_KEY, SCHEMA_VERSION);
  });
  tx();
  if (!already) {
    pluginAudit.record('permission.migration', {
      targetType: 'permission-schema',
      targetId: SCHEMA_KEY,
      detail: { version: SCHEMA_VERSION, plugin: 'server-edition-bedrock-connect' },
    });
    logger.info(`Migrated BedrockConnect permissions to schema ${SCHEMA_VERSION}`);
  }
  return { version: SCHEMA_VERSION };
}

module.exports = {
  EXPANSIONS,
  SCHEMA_KEY,
  SCHEMA_VERSION,
  currentVersion,
  migrate,
};
