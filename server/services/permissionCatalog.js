const defs = require('./permissionDefinitions');

const BEDROCK_CONNECT_PLUGIN_ID = defs.BEDROCK_CONNECT_PLUGIN_ID;
const CATEGORIES = defs.CATEGORIES;
const SUBCATEGORIES = defs.SUBCATEGORIES;
const PERMISSIONS = defs.LOOKUP_PERMISSIONS;
const CORE_PERMISSIONS = defs.CORE_PERMISSIONS;
const PLUGIN_OWNED_PERMISSIONS = defs.PLUGIN_OWNED_PERMISSIONS;
const DEPRECATED_PERMISSIONS = defs.DEPRECATED_PERMISSIONS;
const MENU_PERMISSIONS = DEPRECATED_PERMISSIONS.filter((item) => item.key.startsWith('menu.view.'));

const ALL_KEYS = PERMISSIONS.map((item) => item.key);
const ASSIGNABLE_KEYS = [...CORE_PERMISSIONS, ...PLUGIN_OWNED_PERMISSIONS]
  .filter((item) => !item.deprecated && item.assignableToUsers !== false && item.assignableToGroups !== false)
  .map((item) => item.key);

const STANDARD_KEYS = defs.STANDARD_KEYS;
const READ_ONLY_KEYS = defs.READ_ONLY_KEYS;
const POWER_USER_KEYS = defs.POWER_USER_KEYS;
const DEFAULT_GROUPS = defs.DEFAULT_GROUPS;
const SYSTEM_GROUPS = defs.SYSTEM_GROUPS;
const USER_MANAGEMENT_KEYS = defs.USER_MANAGEMENT_KEYS;
const CREATE_SERVER_PERMISSIONS = defs.CREATE_SERVER_PERMISSIONS;
const READ_ONLY_MENU_ALLOW = defs.OLD_READ_ONLY_MENU_ALLOW;
const OLD_STANDARD_KEYS = defs.OLD_STANDARD_KEYS;

const BY_KEY = new Map(PERMISSIONS.map((item) => [item.key, item]));

function permissionByKey(key) {
  if (BY_KEY.has(key)) return BY_KEY.get(key);
  try {
    const pluginHost = require('./pluginHost');
    const extra = typeof pluginHost.getDynamicPermissions === 'function'
      ? pluginHost.getDynamicPermissions()
      : [];
    return extra.find((item) => item?.key === key) || null;
  } catch {
    return null;
  }
}

function isDeprecatedPermission(key) {
  return Boolean(permissionByKey(key)?.deprecated);
}

function canonicalPermission(key) {
  const item = permissionByKey(key);
  return item?.aliasOf || key;
}

function replacementKeysFor(key) {
  const item = permissionByKey(key);
  if (item?.replacementKeys?.length) return item.replacementKeys;
  if (item?.aliasOf) return [item.aliasOf];
  return defs.STALE_PERMISSION_MAP[key] || [];
}

function legacyKeysFor(key) {
  return PERMISSIONS
    .filter((item) => item.deprecated && (
      item.aliasOf === key
      || (item.replacementKeys || []).includes(key)
    ))
    .map((item) => item.key);
}

function permissionAliases(key) {
  const canonical = canonicalPermission(key);
  return [...new Set([key, canonical, ...legacyKeysFor(canonical)])];
}

function isMenuPermission(key) {
  return String(key || '').startsWith('menu.view.');
}

function isPluginPermission(key) {
  return String(key || '').startsWith('plugin.');
}

function normalizeServerKind(kind) {
  const value = String(kind || '').trim().toLowerCase();
  if (value === 'bedrock-connect') return 'bedrock_connect';
  if (value === 'geyser' || value === 'geyser_gateway') return 'geyser_gateway';
  return value;
}

function isServerAssignable(key, kind) {
  const item = permissionByKey(key);
  if (!item) return false;
  if (item.assignableAtServerScope !== true && !(item.resourceScopes || []).includes('server')) return false;
  if (item.active === false && !item.deprecated) return false;
  if (item.riskLevel === 'administrator-only' || item.administrative) return false;
  if (item.informational) return false;
  const kinds = item.serverKinds || [];
  if (!kinds.length || kind == null || kind === '') return true;
  const normalized = normalizeServerKind(kind);
  return kinds.some((entry) => normalizeServerKind(entry) === normalized);
}

function listServerAssignablePermissions(kind) {
  const keys = typeof listKeys === 'function' ? listKeys() : ALL_KEYS;
  return keys.filter((key) => isServerAssignable(key, kind)).map((key) => permissionByKey(key)).filter(Boolean);
}

function startPermissionForKind(kind) {
  if (kind === 'bedrock_connect') return 'bedrock_connect.start';
  if (kind === 'remote') return 'servers.remote.start_proxy';
  if (kind === 'java') return 'servers.start_java';
  return 'servers.start';
}

function stopPermissionForKind(kind) {
  if (kind === 'bedrock_connect') return 'bedrock_connect.stop';
  if (kind === 'remote') return 'servers.remote.stop_proxy';
  if (kind === 'java') return 'servers.stop_java';
  return 'servers.stop';
}

function createPermissionForKind(kind) {
  if (kind === 'bedrock_connect') return 'bedrock_connect.create';
  if (kind === 'remote') return 'servers.create_remote';
  if (kind === 'java') return 'servers.create_java';
  return 'servers.create_bedrock';
}

function restartPermissionForKind(kind) {
  if (kind === 'bedrock_connect') return 'bedrock_connect.restart';
  if (kind === 'remote') return 'servers.remote.restart_proxy';
  return 'servers.restart';
}

function deletePermissionForKind(kind) {
  if (kind === 'bedrock_connect') return 'bedrock_connect.delete';
  return 'servers.delete';
}

function pluginOwnsKey(pluginId, key) {
  const owner = defs.BUNDLED_PERMISSION_OWNERS[pluginId];
  if (typeof owner === 'function') return owner(key);
  const item = permissionByKey(key);
  return Boolean(item?.pluginId && item.pluginId === pluginId);
}

function normalizeComparable(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = String(value).trim();
  if (text === '') return '';
  if (text === 'true' || text === '1') return '1';
  if (text === 'false' || text === '0') return '0';
  const num = Number(text);
  if (text !== '' && Number.isFinite(num) && String(num) === text) return String(num);
  return text;
}

function fieldChanged(current, submitted) {
  if (submitted === undefined) return false;
  const left = normalizeComparable(current);
  const right = normalizeComparable(submitted);
  if (left == null && (right == null || right === '')) return false;
  return left !== right;
}

function currentSettingsSnapshot(server) {
  const values = { ...(server || {}) };
  try {
    if (server?.kind === 'java') {
      const javaEdition = require('./javaEdition');
      Object.assign(values, javaEdition.readSettings(server.id) || {});
    } else if (server?.data_path && server.kind !== 'remote' && server.kind !== 'bedrock_connect') {
      const serverManager = require('./serverManager');
      const props = serverManager.readServerProperties(
        require('path').join(server.data_path, 'server.properties'),
      );
      const reverse = {
        'max-players': 'max_players',
        difficulty: 'difficulty',
        gamemode: 'gamemode',
        'allow-list': 'whitelist_mode',
        'server-name': 'server_motd',
        'texturepack-required': 'texture_pack_required',
        'allow-cheats': 'enable_cheats',
        'view-distance': 'view_distance',
        'tick-distance': 'tick_distance',
        'player-idle-timeout': 'player_idle_timeout',
        'allow-third-party-requests': 'allow_third_party_requests',
        'allow-third-party-pictures': 'allow_third_party_pictures',
        'online-mode': 'online_mode',
        'require-secure-chat': 'require_secure_chat',
        'server-authoritative-vanilla-inventory': 'server_authoritative_inventory',
        'enable-player-data-initialization': 'enable_player_data_initialization',
        'level-seed': 'level_seed',
        'default-player-permission-level': 'default_player_permission',
        'auto-ice': 'auto_ice',
        'natural-regeneration': 'natural_regeneration',
        'remote-discovery': 'remote_discovery',
        'tx-rate': 'tx_rate',
        'enable-lan-visibility': 'remote_discovery',
      };
      for (const [propKey, field] of Object.entries(reverse)) {
        if (props[propKey] != null && values[field] == null) values[field] = props[propKey];
      }
    }
  } catch {
    /* snapshot is best-effort */
  }
  return values;
}

function requiredServerUpdatePermissions(server, body, currentValues) {
  const needed = new Set();
  if (!body || typeof body !== 'object') return [];
  const current = currentValues || currentSettingsSnapshot(server);
  const changed = (field, aliases = []) => {
    const keys = [field, ...aliases];
    return keys.some((key) => (
      Object.prototype.hasOwnProperty.call(body, key)
      && body[key] !== undefined
      && fieldChanged(current[key] ?? current[field], body[key])
    ));
  };

  if (server?.kind === 'remote') {
    for (const [field, permission] of Object.entries(defs.REMOTE_FIELD_MAP)) {
      if (changed(field)) needed.add(permission);
    }
    return [...needed];
  }
  if (server?.kind === 'bedrock_connect') {
    if (changed('port') || changed('ipv6Port') || changed('ipv6_port')) needed.add('bedrock_connect.change_ports');
    const remaining = Object.keys(body).filter((key) => !['port', 'ipv6Port', 'ipv6_port'].includes(key));
    if (remaining.some((key) => changed(key))) needed.add('bedrock_connect.change_settings');
    return [...needed];
  }

  for (const [field, permission] of Object.entries(defs.PROPERTY_FIELD_MAP)) {
    if (changed(field)) needed.add(permission);
  }
  if (server?.kind === 'java') {
    for (const [field, permission] of Object.entries(javaFieldMap())) {
      if (changed(field)) needed.add(permission);
    }
  }
  return [...needed];
}

function propertyPermissionForField(field, kind) {
  if (kind === 'remote') return defs.REMOTE_FIELD_MAP[field] || null;
  if (kind === 'java' && javaFieldMap()[field]) return javaFieldMap()[field];
  return defs.PROPERTY_FIELD_MAP[field] || null;
}

function listKeys() {
  const keys = [...ALL_KEYS];
  try {
    const pluginHost = require('./pluginHost');
    const extra = typeof pluginHost.getDynamicPermissions === 'function'
      ? pluginHost.getDynamicPermissions()
      : [];
    for (const item of extra) {
      if (item?.key && !keys.includes(item.key)) keys.push(item.key);
    }
  } catch {
    /* plugin host may not be loaded yet */
  }
  return keys;
}

function bundleKeysFor(systemKey, assignableKeys = ASSIGNABLE_KEYS) {
  if (systemKey === 'administrators') return listActiveGroupAssignablePermissions(assignableKeys);
  if (systemKey === 'read-only') return [...READ_ONLY_KEYS];
  if (systemKey === 'standard-users') return [...STANDARD_KEYS];
  if (systemKey === 'power-users') return [...POWER_USER_KEYS];
  return [];
}

function listActiveGroupAssignablePermissions(fallback = ASSIGNABLE_KEYS) {
  try {
    const db = require('../db/connection');
    const rows = db.prepare(`
      SELECT key FROM permission_defs
      WHERE active = 1 AND deprecated = 0 AND assignable_to_groups = 1
      ORDER BY key
    `).all();
    if (rows.length) return rows.map((row) => row.key);
  } catch {
    /* database may not be ready */
  }
  return [...fallback];
}

function mergedCategories({ includeInactive = false } = {}) {
  const byId = new Map((defs.CATEGORIES || []).map((item) => [item.id, { ...item, source: item.source || 'core' }]));
  try {
    const pluginHost = require('./pluginHost');
    const extra = typeof pluginHost.getPermissionCategories === 'function'
      ? pluginHost.getPermissionCategories()
      : [];
    for (const item of extra || []) {
      if (item?.id && !byId.has(item.id)) byId.set(item.id, item);
    }
  } catch {
    /* plugins optional */
  }
  if (includeInactive) {
    try {
      const db = require('../db/connection');
      const rows = db.prepare(`
        SELECT DISTINCT primary_category AS id
        FROM permission_defs
        WHERE IFNULL(primary_category, '') != ''
      `).all();
      for (const row of rows) {
        if (!byId.has(row.id)) {
          byId.set(row.id, { id: row.id, label: row.id, source: 'historical', inactive: true });
        }
      }
    } catch {
      /* optional */
    }
  }
  return [...byId.values()];
}

function mergedSubcategories() {
  const items = [...(defs.SUBCATEGORIES || [])];
  try {
    const pluginHost = require('./pluginHost');
    const extra = typeof pluginHost.getPermissionSubcategories === 'function'
      ? pluginHost.getPermissionSubcategories()
      : [];
    const seen = new Set(items.map((item) => `${item.category}:${item.id}`));
    for (const item of extra || []) {
      const key = `${item.category}:${item.id}`;
      if (item?.id && !seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
    }
  } catch {
    /* plugins optional */
  }
  return items;
}

function javaFieldMap() {
  const map = { ...defs.JAVA_FIELD_MAP };
  try {
    const pluginHost = require('./pluginHost');
    Object.assign(map, pluginHost.getFieldMappings?.('server-edition-java') || {});
  } catch {
    /* plugin field mappings optional */
  }
  return map;
}

module.exports = {
  BEDROCK_CONNECT_PLUGIN_ID,
  CATALOG_SCHEMA_VERSION: defs.CATALOG_SCHEMA_VERSION,
  DEFAULTS_VERSION: defs.DEFAULTS_VERSION,
  CATEGORIES,
  SUBCATEGORIES,
  PERMISSIONS,
  CORE_PERMISSIONS,
  PLUGIN_OWNED_PERMISSIONS,
  DEPRECATED_PERMISSIONS,
  MENU_PERMISSIONS,
  ALL_KEYS,
  ASSIGNABLE_KEYS,
  STANDARD_KEYS,
  READ_ONLY_KEYS,
  POWER_USER_KEYS,
  OLD_STANDARD_KEYS,
  DEFAULT_GROUPS,
  SYSTEM_GROUPS,
  USER_MANAGEMENT_KEYS,
  CREATE_SERVER_PERMISSIONS,
  READ_ONLY_MENU_ALLOW,
  STALE_PERMISSION_MAP: defs.STALE_PERMISSION_MAP,
  PROPERTY_FIELD_MAP: defs.PROPERTY_FIELD_MAP,
  JAVA_FIELD_MAP: defs.JAVA_FIELD_MAP,
  REMOTE_FIELD_MAP: defs.REMOTE_FIELD_MAP,
  permissionAliases,
  permissionByKey,
  isDeprecatedPermission,
  isMenuPermission,
  isPluginPermission,
  isServerAssignable,
  listServerAssignablePermissions,
  normalizeServerKind,
  canonicalPermission,
  replacementKeysFor,
  legacyKeysFor,
  startPermissionForKind,
  stopPermissionForKind,
  createPermissionForKind,
  restartPermissionForKind,
  deletePermissionForKind,
  requiredServerUpdatePermissions,
  currentSettingsSnapshot,
  propertyPermissionForField,
  pluginOwnsKey,
  listKeys,
  bundleKeysFor,
  listActiveGroupAssignablePermissions,
  mergedCategories,
  mergedSubcategories,
  javaFieldMap,
};
