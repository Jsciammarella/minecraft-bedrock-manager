const CATEGORIES = [
  { id: 'servers', label: 'Dashboard/Servers' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'library', label: 'Library' },
  { id: 'players', label: 'Players' },
  { id: 'bedrock_connect', label: 'BedrockConnect' },
  { id: 'users', label: 'Users' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'plugin', label: 'Plugin permissions' },
  { id: 'menu', label: 'Menu' },
];

const MENU_PERMISSIONS = [
  { key: 'menu.view.dashboard', category: 'menu', name: 'View Dashboard', description: 'Show Dashboard in the left-hand menu' },
  { key: 'menu.view.servers', category: 'menu', name: 'View Servers', description: 'Show Servers in the left-hand menu' },
  { key: 'menu.view.servers_new', category: 'menu', name: 'View New Server', description: 'Show New Server in the left-hand menu' },
  { key: 'menu.view.library', category: 'menu', name: 'View Mod Library', description: 'Show Mod Library in the left-hand menu' },
  { key: 'menu.view.catalog', category: 'menu', name: 'View Mod Catalog', description: 'Show Mod Catalog in the left-hand menu' },
  { key: 'menu.view.players', category: 'menu', name: 'View Players', description: 'Show Players in the left-hand menu' },
  { key: 'menu.view.bedrock_connect', category: 'menu', name: 'View BedrockConnect', description: 'Show BedrockConnect in the left-hand menu' },
  { key: 'menu.view.ports', category: 'menu', name: 'View Ports', description: 'Show Ports in the left-hand menu' },
  { key: 'menu.view.users', category: 'menu', name: 'View Users', description: 'Show Users in the left-hand menu' },
  { key: 'menu.view.plugins', category: 'menu', name: 'View Plugins', description: 'Show Plugins in the left-hand menu' },
];

const READ_ONLY_MENU_ALLOW = [
  'menu.view.dashboard',
  'menu.view.players',
  'menu.view.library',
];

const PERMISSIONS = [
  { key: 'servers.create', category: 'servers', name: 'Create new server', description: 'Allow a user to create a new server' },
  { key: 'servers.create_remote', category: 'servers', name: 'Create new remote server', description: 'Allow the user to create a new remote server' },
  { key: 'servers.create_bedrock_connect', category: 'servers', name: 'Create a BedrockConnect server', description: 'Allow the user to create a Bedrock Connect server' },
  { key: 'servers.view_details', category: 'servers', name: 'Open server details page', description: 'Allow the user to click and open server tiles' },
  { key: 'servers.start', category: 'servers', name: 'Start a server', description: 'Allow the user to start a server' },
  { key: 'servers.stop', category: 'servers', name: 'Stop a server', description: 'Allow the user to stop a server' },
  { key: 'servers.start_bedrock_connect', category: 'servers', name: 'Start a BedrockConnect server', description: 'Allow the user to start a Bedrock Connect server' },
  { key: 'servers.stop_bedrock_connect', category: 'servers', name: 'Stop a BedrockConnect server', description: 'Allow the user to stop a Bedrock Connect server' },
  { key: 'servers.start_remote', category: 'servers', name: 'Start a remote server', description: 'Allow the user to start a remote server' },
  { key: 'servers.stop_remote', category: 'servers', name: 'Stop a remote server', description: 'Allow the user to stop a remote server' },
  { key: 'servers.delete', category: 'servers', name: 'Delete a server', description: 'Allow the user to delete a server' },
  { key: 'servers.set_lan', category: 'servers', name: 'Set LAN Feature', description: 'Allow the user to toggle the LAN feature of a server on and off' },
  { key: 'servers.console', category: 'servers', name: 'Send Console Commands', description: 'Allow the user to enter commands to the server console' },
  { key: 'servers.add_allowed_players', category: 'servers', name: 'Add allowed players', description: 'Allow the user to add players to the allow list' },
  { key: 'servers.remove_allowed_players', category: 'servers', name: 'Remove allowed players', description: 'Allow the user to remove players from the allow list' },
  { key: 'servers.add_banned_players', category: 'servers', name: 'Add banned players', description: 'Allow user to add players to the ban list or ban players' },
  { key: 'servers.remove_banned_players', category: 'servers', name: 'Remove banned players', description: 'Allow the user to remove players from the ban list' },
  { key: 'servers.update', category: 'servers', name: 'Update Server', description: 'Allow user to update the server or set the auto-update on the server properties page' },
  { key: 'servers.change_player_permissions', category: 'servers', name: 'Change Player Permissions', description: 'Allow user to add players and change player permissions on the server users page and the permissions area on the server properties page' },
  { key: 'servers.add_mods', category: 'servers', name: 'Add Mods', description: 'Allow user to add mods to a server' },
  { key: 'servers.remove_mods', category: 'servers', name: 'Remove Mods', description: 'Allow user to remove mods from a server' },
  { key: 'servers.change_general_settings', category: 'servers', name: 'Change General Settings', description: 'Allow user to change general settings of a server' },
  { key: 'servers.change_game_settings', category: 'servers', name: 'Change Game Settings', description: 'Allow user to change game settings of a server' },
  { key: 'servers.change_server_options', category: 'servers', name: 'Change Server Options', description: 'Allow user to change server options of a server' },
  { key: 'servers.change_remote_local_ports', category: 'servers', name: 'Change Remote Server Local Ports', description: 'Allow the user to change the local ports on a remote server' },
  { key: 'servers.change_remote_target', category: 'servers', name: 'Change Remote Target Ports', description: 'Allow user to change the remote target properties on a remote server' },

  { key: 'catalog.download_mods', category: 'catalog', name: 'Download Mods', description: 'Allow a user to download mods from the catalog' },
  { key: 'catalog.change_file_handling', category: 'catalog', name: 'Change File Handling', description: 'Allow the user to change multi-file handling' },
  { key: 'catalog.set_curseforge_key', category: 'catalog', name: 'Set CurseForge key', description: 'Allow the user to add an API key for CurseForge' },
  { key: 'catalog.enable_git', category: 'catalog', name: 'Enable Git Catalog', description: 'Allow the user to enable and configure the git repository in the catalog settings' },
  { key: 'catalog.enable_file', category: 'catalog', name: 'Enable File Catalog', description: 'Allow user to enable and configure the file catalog in the catalog settings' },

  { key: 'library.upload', category: 'library', name: 'Upload mods', description: 'Allow the user to upload mods to the library' },
  { key: 'library.delete', category: 'library', name: 'Delete mods', description: 'Allow the user to delete mods from the library' },
  { key: 'library.change_settings', category: 'library', name: 'Change mod settings', description: 'Allow the user to change library mod settings such as description and thumbnail' },
  { key: 'library.import_curseforge', category: 'library', name: 'Download from CurseForge', description: 'Allow the user to import mods into the library from a CurseForge URL' },
  { key: 'library.import_mcpedl', category: 'library', name: 'Download from MCPEDL', description: 'Allow the user to import mods into the library from an MCPEDL URL' },

  { key: 'players.add', category: 'players', name: 'Add a player', description: 'Allows users to add a player in the player management page' },
  { key: 'players.ban_all', category: 'players', name: 'Ban player from all servers', description: 'Allow user to ban player at the player management page' },
  { key: 'players.remove_whitelisted', category: 'players', name: 'Remove whitelisted players', description: 'Allows user to remove player from all allow lists at the player management page' },

  { key: 'bedrock_connect.enable_dns_proxy', category: 'bedrock_connect', name: 'Enable DNS Proxy', description: 'Allow user to enable the DNS proxy feature' },
  { key: 'bedrock_connect.set_upstream_dns', category: 'bedrock_connect', name: 'Set upstream DNS', description: 'Allow user to set upstream DNS servers' },
  { key: 'bedrock_connect.set_dns_overrides', category: 'bedrock_connect', name: 'Set DNS overrides', description: 'Allow user to set custom DNS overrides and add known featured servers to the override list' },

  { key: 'users.change_password', category: 'users', name: 'Change user password', description: 'Allow user to change another users password' },
  { key: 'users.change_name', category: 'users', name: 'Change name', description: 'Allow user to change a users full name' },
  { key: 'users.change_user_permissions', category: 'users', name: 'Change User Permissions', description: 'Allow a user to change another users permissions' },
  { key: 'users.change_group_permissions', category: 'users', name: 'Change Group Permissions', description: 'Allow a user to change group permissions' },
  { key: 'users.change_group_membership', category: 'users', name: 'Change Group Membership', description: 'Allow user to add/remove users from groups' },
  { key: 'users.add_groups', category: 'users', name: 'Add groups', description: 'Allow user to create groups' },
  { key: 'users.delete_groups', category: 'users', name: 'Delete group', description: 'Allow user to delete groups (deleting groups with users just removes the user from that group)' },

  { key: 'plugins.upload', category: 'plugins', name: 'Upload a plugin', description: 'Allow the user to upload plugins', administrative: true },

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

  ...MENU_PERMISSIONS,
];

const ADMINISTRATIVE_PREFIXES = ['users.'];
const DESTRUCTIVE_KEYS = new Set([
  'servers.delete',
  'library.delete',
  'users.delete_groups',
  'players.ban_all',
  'plugins.upload',
]);

function resourceTypeFor(item) {
  if (item.resourceType) return item.resourceType;
  if (item.category === 'servers' || String(item.key).startsWith('servers.')) return 'server';
  if (item.category === 'plugins' || String(item.key).startsWith('plugin.')) return 'plugin';
  if (item.category === 'users') return 'user';
  return null;
}

function annotatePermission(item) {
  const administrative = Boolean(
    item.administrative
    || ADMINISTRATIVE_PREFIXES.some((prefix) => item.key.startsWith(prefix))
    || item.key === 'plugins.upload'
    || item.key === 'catalog.set_curseforge_key'
  );
  return {
    ...item,
    administrative,
    destructive: Boolean(item.destructive || DESTRUCTIVE_KEYS.has(item.key)),
    resourceType: resourceTypeFor(item),
    defaultRoles: item.defaultRoles || null,
  };
}

for (let i = 0; i < PERMISSIONS.length; i += 1) {
  PERMISSIONS[i] = annotatePermission(PERMISSIONS[i]);
}

const ALL_KEYS = PERMISSIONS.map((item) => item.key);

const STANDARD_KEYS = [
  'servers.create',
  'servers.create_remote',
  'servers.create_bedrock_connect',
  'servers.create_java',
  'servers.view_details',
  'servers.start',
  'servers.stop',
  'servers.start_java',
  'servers.stop_java',
  'servers.change_java_settings',
  'servers.start_bedrock_connect',
  'servers.stop_bedrock_connect',
  'servers.start_remote',
  'servers.stop_remote',
  'servers.delete',
  'servers.set_lan',
  'servers.console',
  'servers.add_allowed_players',
  'servers.remove_allowed_players',
  'servers.add_banned_players',
  'servers.remove_banned_players',
  'servers.update',
  'servers.change_player_permissions',
  'servers.add_mods',
  'servers.remove_mods',
  'servers.change_general_settings',
  'servers.change_game_settings',
  'servers.change_server_options',
  'servers.change_remote_local_ports',
  'servers.change_remote_target',
  'catalog.download_mods',
  'catalog.change_file_handling',
  'catalog.set_curseforge_key',
  'catalog.enable_git',
  'catalog.enable_file',
  'library.upload',
  'library.delete',
  'library.change_settings',
  'library.import_curseforge',
  'library.import_mcpedl',
  'players.add',
  'players.ban_all',
  'players.remove_whitelisted',
  'plugins.upload',
  ...MENU_PERMISSIONS.map((item) => item.key),
];

const DEFAULT_GROUPS = [
  { slug: 'administrators', name: 'Administrators', keys: ALL_KEYS },
  { slug: 'standard', name: 'Standard', keys: STANDARD_KEYS },
  { slug: 'read-only', name: 'Read-only', keys: [] },
];

const USER_MANAGEMENT_KEYS = PERMISSIONS
  .filter((item) => item.category === 'users')
  .map((item) => item.key);

function permissionByKey(key) {
  return PERMISSIONS.find((item) => item.key === key) || null;
}

function isMenuPermission(key) {
  return String(key || '').startsWith('menu.view.');
}

function isPluginPermission(key) {
  return String(key || '').startsWith('plugin.');
}

function startPermissionForKind(kind) {
  if (kind === 'bedrock_connect') return 'servers.start_bedrock_connect';
  if (kind === 'remote') return 'servers.start_remote';
  if (kind === 'java') return 'servers.start_java';
  return 'servers.start';
}

function stopPermissionForKind(kind) {
  if (kind === 'bedrock_connect') return 'servers.stop_bedrock_connect';
  if (kind === 'remote') return 'servers.stop_remote';
  if (kind === 'java') return 'servers.stop_java';
  return 'servers.stop';
}

function createPermissionForKind(kind) {
  if (kind === 'bedrock_connect') return 'servers.create_bedrock_connect';
  if (kind === 'remote') return 'servers.create_remote';
  if (kind === 'java') return 'servers.create_java';
  return 'servers.create';
}

const SERVER_UPDATE_FIELDS = {
  general: [
    'port', 'ipv6Port', 'ipv6_port', 'max_players', 'maxPlayers',
    'server_description', 'server_motd', 'level_seed', 'name',
  ],
  game: [
    'gamemode', 'difficulty', 'view_distance', 'tick_distance',
    'player_idle_timeout', 'tx_rate', 'simulation_distance', 'spawn_protection',
  ],
  options: [
    'enable_cheats', 'server_authoritative', 'whitelist_mode', 'texture_pack_required',
    'auto_ice', 'natural_regeneration', 'online_mode', 'remote_discovery',
    'allow_third_party_requests', 'allow_third_party_pictures', 'require_secure_chat',
    'server_authoritative_inventory', 'enable_player_data_initialization',
    'pvp', 'allow_nether', 'allow_flight', 'enable_command_block', 'hardcore',
    'force_gamemode', 'spawn_animals', 'spawn_npcs', 'spawn_monsters',
    'generate_structures', 'hide_online_players', 'enforce_whitelist',
    'require_resource_pack', 'broadcast_console_to_ops', 'enable_status',
    'enable_query', 'enable_rcon', 'sync_chunk_writes', 'prevent_proxy_connections',
    'enforce_secure_profile', 'network_compression_threshold',
    'entity_broadcast_range_percentage', 'query_port', 'rcon_port', 'rcon_password',
    'resource_pack', 'resource_pack_sha1', 'level_type', 'max_world_size',
  ],
  java: [
    'pvp', 'allow_nether', 'allow_flight', 'enable_command_block', 'hardcore',
    'force_gamemode', 'spawn_animals', 'spawn_npcs', 'spawn_monsters',
    'generate_structures', 'hide_online_players', 'enforce_whitelist',
    'require_resource_pack', 'broadcast_console_to_ops', 'enable_status',
    'enable_query', 'enable_rcon', 'sync_chunk_writes', 'prevent_proxy_connections',
    'enforce_secure_profile', 'network_compression_threshold',
    'entity_broadcast_range_percentage', 'query_port', 'rcon_port', 'rcon_password',
    'resource_pack', 'resource_pack_sha1', 'level_type', 'max_world_size',
    'simulation_distance', 'spawn_protection', 'op_permission_level', 'function_permission_level',
  ],
  playerPermissions: ['default_player_permission', 'default_1st_person', 'op_permission_level', 'function_permission_level'],
  remoteLocal: ['port', 'ipv6Port', 'ipv6_port'],
  remoteTarget: [
    'remoteHost', 'remote_host', 'remoteIpv4Port', 'remote_ipv4_port',
    'remoteIpv6Port', 'remote_ipv6_port',
  ],
};

function bodyHasAny(body, keys) {
  if (!body || typeof body !== 'object') return false;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined);
}

function requiredServerUpdatePermissions(server, body) {
  const needed = new Set();
  if (!body || typeof body !== 'object') return [];
  if (server?.kind === 'remote') {
    if (bodyHasAny(body, SERVER_UPDATE_FIELDS.remoteLocal)) needed.add('servers.change_remote_local_ports');
    if (bodyHasAny(body, SERVER_UPDATE_FIELDS.remoteTarget)) needed.add('servers.change_remote_target');
    return [...needed];
  }
  if (bodyHasAny(body, SERVER_UPDATE_FIELDS.general)) needed.add('servers.change_general_settings');
  if (bodyHasAny(body, SERVER_UPDATE_FIELDS.game)) needed.add('servers.change_game_settings');
  if (bodyHasAny(body, SERVER_UPDATE_FIELDS.options)) needed.add('servers.change_server_options');
  if (bodyHasAny(body, SERVER_UPDATE_FIELDS.playerPermissions)) needed.add('servers.change_player_permissions');
  if (server?.kind === 'java' && bodyHasAny(body, SERVER_UPDATE_FIELDS.java)) {
    needed.add('servers.change_java_settings');
  }
  return [...needed];
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

module.exports = {
  CATEGORIES,
  PERMISSIONS,
  MENU_PERMISSIONS,
  ALL_KEYS,
  STANDARD_KEYS,
  DEFAULT_GROUPS,
  USER_MANAGEMENT_KEYS,
  READ_ONLY_MENU_ALLOW,
  permissionByKey,
  isMenuPermission,
  isPluginPermission,
  startPermissionForKind,
  stopPermissionForKind,
  createPermissionForKind,
  requiredServerUpdatePermissions,
  listKeys,
};
