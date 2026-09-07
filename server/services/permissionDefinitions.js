const CATALOG_SCHEMA_VERSION = 3;
const DEFAULTS_VERSION = 3;
const JAVA_PLUGIN_ID = 'server-edition-java';
const BEDROCK_CONNECT_PLUGIN_ID = 'server-edition-bedrock-connect';
const CURSEFORGE_PLUGIN_ID = 'catalog-curseforge';
const GIT_CATALOG_PLUGIN_ID = 'catalog-git';
const FILE_CATALOG_PLUGIN_ID = 'catalog-file';

const CATEGORIES = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'servers', label: 'Servers' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'library', label: 'Library' },
  { id: 'players', label: 'Players' },
  { id: 'ports', label: 'Ports' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'user-management', label: 'User Management' },
  { id: 'plugin', label: 'Plugin permissions' },
];

const SUBCATEGORIES = [
  { id: 'general', category: 'servers', label: 'General' },
  { id: 'lifecycle', category: 'servers', label: 'Lifecycle' },
  { id: 'console', category: 'servers', label: 'Console' },
  { id: 'properties-identity', category: 'servers', label: 'Identity and world' },
  { id: 'properties-gameplay', category: 'servers', label: 'Gameplay' },
  { id: 'properties-access', category: 'servers', label: 'Access and authentication' },
  { id: 'properties-network', category: 'servers', label: 'Network' },
  { id: 'properties-performance', category: 'servers', label: 'Performance' },
  { id: 'properties-content', category: 'servers', label: 'Content' },
  { id: 'properties-movement', category: 'servers', label: 'Movement and authority' },
  { id: 'properties-debugging', category: 'servers', label: 'Debugging' },
  { id: 'remote', category: 'servers', label: 'Remote servers' },
  { id: 'allowlist', category: 'servers', label: 'Allowlist' },
  { id: 'ban-list', category: 'servers', label: 'Ban list' },
  { id: 'player-permissions', category: 'servers', label: 'Player permissions' },
  { id: 'mods', category: 'servers', label: 'Mods and add-ons' },
  { id: 'java', category: 'servers', label: 'Java hosting' },
  { id: 'my-account', category: 'user-management', label: 'My account' },
  { id: 'users', category: 'user-management', label: 'Users' },
  { id: 'groups', category: 'user-management', label: 'Groups' },
  { id: 'permissions', category: 'user-management', label: 'Permission catalog' },
  { id: 'security', category: 'user-management', label: 'Security settings' },
];

function sourceLabel(source) {
  if (source === 'first-party-plugin') return 'First-party plugin';
  if (source === 'third-party-plugin') return 'Third-party plugin';
  return 'Core';
}

function perm(key, displayName, description, extra = {}) {
  const riskLevel = extra.risk || extra.riskLevel || 'normal';
  const adminOnly = riskLevel === 'administrator-only';
  const source = extra.source || 'core';
  const replacementKeys = extra.replacementKeys
    || (extra.aliasOf ? [extra.aliasOf] : []);
  return {
    key,
    displayName,
    name: displayName,
    description,
    primaryCategory: extra.cat || extra.primaryCategory || extra.category || 'plugin',
    category: extra.cat || extra.primaryCategory || extra.category || 'plugin',
    subcategory: extra.sub || extra.subcategory || null,
    source,
    sourceLabel: extra.sourceLabel || sourceLabel(source),
    pluginId: extra.pluginId || null,
    riskLevel,
    assignableToUsers: adminOnly ? false : extra.assignableToUsers !== false,
    assignableToGroups: adminOnly ? false : extra.assignableToGroups !== false,
    active: extra.active !== false,
    deprecated: Boolean(extra.deprecated),
    replacementKeys,
    schemaVersion: extra.schemaVersion || CATALOG_SCHEMA_VERSION,
    aliasOf: extra.aliasOf || null,
    administrative: adminOnly || Boolean(extra.administrative),
    destructive: riskLevel === 'destructive' || Boolean(extra.destructive),
    edition: extra.edition || null,
    informational: Boolean(extra.informational),
    resourceScopes: Array.isArray(extra.resourceScopes) ? extra.resourceScopes : [],
    assignableAtServerScope: Boolean(extra.assignableAtServerScope),
    serverKinds: Array.isArray(extra.serverKinds) ? extra.serverKinds : [],
  };
}

const CORE_PERMISSIONS = [
  perm('dashboard.view', 'View dashboard', 'View the dashboard and server tiles.', { cat: 'dashboard', risk: 'read' }),
  perm('dashboard.view_runtime_status', 'View dashboard runtime status', 'View online state, uptime, active players, and restart-required status on dashboard tiles.', { cat: 'dashboard', risk: 'read' }),
  perm('dashboard.view_connection_details', 'View dashboard connection details', 'View server addresses and ports on dashboard tiles.', { cat: 'dashboard', risk: 'read' }),

  perm('servers.view', 'View servers', 'View the server list and server tiles.', { cat: 'servers', sub: 'general', risk: 'read' }),
  perm('servers.view_details', 'View server details', 'Open server information pages.', { cat: 'servers', sub: 'general', risk: 'read' }),
  perm('servers.view_runtime_status', 'View server runtime status', 'View detailed process, uptime, and player-count status.', { cat: 'servers', sub: 'general', risk: 'read' }),
  perm('servers.view_connection_details', 'View server connection details', 'View hostnames, addresses, and ports.', { cat: 'servers', sub: 'general', risk: 'read' }),
  perm('servers.view_properties', 'View server properties', 'View effective server properties without changing them.', { cat: 'servers', sub: 'general', risk: 'read' }),
  perm('servers.create_bedrock', 'Create Bedrock server', 'Create local Bedrock servers.', { cat: 'servers', sub: 'general', risk: 'elevated' }),
  perm('servers.create_remote', 'Create remote server', 'Create remote-server entries or proxies.', { cat: 'servers', sub: 'general', risk: 'elevated' }),
  perm('gateways.create', 'Create gateways', 'Create Bedrock-to-Java gateways and apply automatic gateway configuration during Java server creation.', { cat: 'servers', sub: 'java', risk: 'elevated' }),
  perm('servers.edit_display_name', 'Edit server display name', 'Change the manager-facing display name.', { cat: 'servers', sub: 'general' }),
  perm('servers.edit_description', 'Edit server description', 'Change manager-facing server notes or descriptions.', { cat: 'servers', sub: 'general' }),

  perm('servers.start', 'Start server', 'Start a local core-supported server.', { cat: 'servers', sub: 'lifecycle' }),
  perm('servers.stop', 'Stop server', 'Gracefully stop a local server.', { cat: 'servers', sub: 'lifecycle' }),
  perm('servers.restart', 'Restart server', 'Immediately restart a server gracefully.', { cat: 'servers', sub: 'lifecycle' }),
  perm('servers.restart_with_warning', 'Restart with warning', 'Schedule a restart with player warnings.', { cat: 'servers', sub: 'lifecycle' }),
  perm('servers.cancel_scheduled_restart', 'Cancel scheduled restart', 'Cancel a pending restart-with-warning.', { cat: 'servers', sub: 'lifecycle' }),
  perm('servers.delete', 'Delete server', 'Delete a server and manager-owned server data.', { cat: 'servers', sub: 'lifecycle', risk: 'destructive', destructive: true }),
  perm('servers.update_software', 'Update server software', 'Download and apply a server software update.', { cat: 'servers', sub: 'lifecycle', risk: 'elevated' }),
  perm('servers.configure_auto_update', 'Configure automatic updates', 'Configure automatic server updates.', { cat: 'servers', sub: 'lifecycle', risk: 'elevated' }),
  perm('servers.manage_lan_broadcast', 'Manage LAN broadcast', 'Enable or disable LAN broadcasting.', { cat: 'servers', sub: 'lifecycle' }),

  perm('servers.console.view', 'View console', 'View server-specific console output.', { cat: 'servers', sub: 'console' }),
  perm('servers.console.send_commands', 'Send console commands', 'Send commands to the server console.', { cat: 'servers', sub: 'console', risk: 'elevated' }),

  perm('servers.properties.server_name', 'Change in-game server name', 'Change the in-game server name.', { cat: 'servers', sub: 'properties-identity' }),
  perm('servers.properties.level_seed', 'Change world seed', 'Change the configured world seed.', { cat: 'servers', sub: 'properties-identity', risk: 'elevated' }),
  perm('servers.properties.max_players', 'Change max players', 'Change the maximum player count.', { cat: 'servers', sub: 'properties-identity' }),
  perm('servers.properties.default_player_permission', 'Change default player permission', 'Change the server’s default player permission level.', { cat: 'servers', sub: 'properties-identity' }),
  perm('servers.properties.default_1st_person', 'Change default first-person setting', 'Change the default first-person camera setting.', { cat: 'servers', sub: 'properties-identity' }),

  perm('servers.properties.game_mode', 'Change game mode', 'Change the default game mode.', { cat: 'servers', sub: 'properties-gameplay' }),
  perm('servers.properties.force_game_mode', 'Change forced game mode', 'Enable or disable forced game mode.', { cat: 'servers', sub: 'properties-gameplay' }),
  perm('servers.properties.difficulty', 'Change difficulty', 'Change server difficulty.', { cat: 'servers', sub: 'properties-gameplay' }),
  perm('servers.properties.allow_cheats', 'Change cheats', 'Enable or disable cheats.', { cat: 'servers', sub: 'properties-gameplay' }),
  perm('servers.properties.player_idle_timeout', 'Change idle timeout', 'Change idle-player timeout.', { cat: 'servers', sub: 'properties-gameplay' }),
  perm('servers.properties.tx_rate', 'Change TX rate', 'Change the server TX rate.', { cat: 'servers', sub: 'properties-gameplay' }),
  perm('servers.properties.auto_ice', 'Change auto ice', 'Enable or disable automatic ice formation.', { cat: 'servers', sub: 'properties-gameplay' }),
  perm('servers.properties.natural_regeneration', 'Change natural regeneration', 'Enable or disable natural health regeneration.', { cat: 'servers', sub: 'properties-gameplay' }),

  perm('servers.properties.online_mode', 'Change online mode', 'Enable or disable online account authentication.', { cat: 'servers', sub: 'properties-access', risk: 'elevated' }),
  perm('servers.properties.allowlist_enabled', 'Change allowlist mode', 'Enable or disable the server allowlist.', { cat: 'servers', sub: 'properties-access' }),
  perm('servers.properties.allow_third_party_requests', 'Change third-party requests', 'Permit or reject third-party requests.', { cat: 'servers', sub: 'properties-access' }),
  perm('servers.properties.allow_third_party_pictures', 'Change third-party pictures', 'Permit or reject third-party pictures and skins.', { cat: 'servers', sub: 'properties-access' }),
  perm('servers.properties.require_secure_chat', 'Change secure chat', 'Enable or disable required secure chat.', { cat: 'servers', sub: 'properties-access' }),
  perm('servers.properties.enable_player_data_initialization', 'Change player data initialization', 'Enable or disable player data initialization on first join.', { cat: 'servers', sub: 'properties-access' }),

  perm('servers.properties.ipv4_port', 'Change IPv4 port', 'Change the IPv4 server port.', { cat: 'servers', sub: 'properties-network', risk: 'elevated' }),
  perm('servers.properties.ipv6_port', 'Change IPv6 port', 'Change the IPv6 server port.', { cat: 'servers', sub: 'properties-network', risk: 'elevated' }),
  perm('servers.properties.lan_visibility', 'Change LAN visibility', 'Enable or disable LAN visibility and remote discovery.', { cat: 'servers', sub: 'properties-network' }),

  perm('servers.properties.view_distance', 'Change view distance', 'Change view distance.', { cat: 'servers', sub: 'properties-performance' }),
  perm('servers.properties.tick_distance', 'Change tick distance', 'Change simulation or tick distance.', { cat: 'servers', sub: 'properties-performance' }),

  perm('servers.properties.texture_pack_required', 'Require texture packs', 'Require clients to accept server resource packs.', { cat: 'servers', sub: 'properties-content' }),

  perm('servers.properties.movement_authority', 'Change movement authority', 'Change movement authority behavior.', { cat: 'servers', sub: 'properties-movement', risk: 'elevated' }),
  perm('servers.properties.server_authoritative_inventory', 'Change authoritative inventory', 'Enable or disable server-authoritative inventory.', { cat: 'servers', sub: 'properties-movement', risk: 'elevated' }),

  perm('servers.remote.view_target', 'View remote target', 'View the remote target address and port.', { cat: 'servers', sub: 'remote', risk: 'read' }),
  perm('servers.remote.change_target_host', 'Change remote hostname', 'Change the remote target hostname.', { cat: 'servers', sub: 'remote', risk: 'elevated' }),
  perm('servers.remote.change_target_port', 'Change remote target port', 'Change the remote target port.', { cat: 'servers', sub: 'remote', risk: 'elevated' }),
  perm('servers.remote.change_local_port', 'Change remote local port', 'Change the locally exposed proxy port.', { cat: 'servers', sub: 'remote', risk: 'elevated' }),
  perm('servers.remote.start_proxy', 'Start remote proxy', 'Start a remote-server proxy.', { cat: 'servers', sub: 'remote' }),
  perm('servers.remote.stop_proxy', 'Stop remote proxy', 'Stop a remote-server proxy.', { cat: 'servers', sub: 'remote' }),
  perm('servers.remote.restart_proxy', 'Restart remote proxy', 'Restart a remote-server proxy.', { cat: 'servers', sub: 'remote' }),

  perm('servers.allowlist.view', 'View allowlist', 'View one server’s allowlist.', { cat: 'servers', sub: 'allowlist', risk: 'read' }),
  perm('servers.allowlist.add', 'Add allowlist players', 'Add players to one server’s allowlist.', { cat: 'servers', sub: 'allowlist' }),
  perm('servers.allowlist.remove', 'Remove allowlist players', 'Remove players from one server’s allowlist.', { cat: 'servers', sub: 'allowlist' }),
  perm('servers.allowlist.sync', 'Sync allowlist', 'Reconcile manager and server allowlist data.', { cat: 'servers', sub: 'allowlist', informational: true }),

  perm('servers.banlist.view', 'View ban list', 'View one server’s ban list.', { cat: 'servers', sub: 'ban-list', risk: 'read' }),
  perm('servers.banlist.add', 'Ban player', 'Ban a player from one server.', { cat: 'servers', sub: 'ban-list' }),
  perm('servers.banlist.remove', 'Unban player', 'Unban a player from one server.', { cat: 'servers', sub: 'ban-list' }),
  perm('servers.banlist.sync', 'Sync ban list', 'Reconcile manager and server ban-list data.', { cat: 'servers', sub: 'ban-list', informational: true }),

  perm('servers.player_permissions.view', 'View player permissions', 'View per-server visitor, member, and operator assignments.', { cat: 'servers', sub: 'player-permissions', risk: 'read' }),
  perm('servers.player_permissions.set_visitor', 'Set visitor permission', 'Assign visitor permission.', { cat: 'servers', sub: 'player-permissions' }),
  perm('servers.player_permissions.set_member', 'Set member permission', 'Assign member permission.', { cat: 'servers', sub: 'player-permissions' }),
  perm('servers.player_permissions.set_operator', 'Set operator permission', 'Assign operator permission.', { cat: 'servers', sub: 'player-permissions', risk: 'elevated' }),
  perm('servers.player_permissions.reset', 'Reset player permission', 'Return a player to the server default.', { cat: 'servers', sub: 'player-permissions' }),

  perm('servers.mods.view', 'View installed mods', 'View mods and add-ons installed on a server.', { cat: 'servers', sub: 'mods', risk: 'read' }),
  perm('servers.mods.install', 'Install mods', 'Install a library item on a server.', { cat: 'servers', sub: 'mods' }),
  perm('servers.mods.remove', 'Remove mods', 'Remove an installed item without deleting its library copy.', { cat: 'servers', sub: 'mods' }),
  perm('servers.mods.resolve_dependencies', 'Resolve mod dependencies', 'Approve dependency resolution and installation.', { cat: 'servers', sub: 'mods' }),
  perm('servers.mods.view_restart_status', 'View mod restart status', 'View whether installed changes require a restart.', { cat: 'servers', sub: 'mods', risk: 'read' }),

  perm('catalog.view', 'View catalog', 'Open and browse the catalog.', { cat: 'catalog', risk: 'read' }),
  perm('catalog.search', 'Search catalog', 'Search enabled catalog sources.', { cat: 'catalog', risk: 'read' }),
  perm('catalog.view_details', 'View catalog details', 'View catalog item versions and compatibility details.', { cat: 'catalog', risk: 'read' }),
  perm('catalog.download_to_library', 'Download to library', 'Download catalog files into the manager library.', { cat: 'catalog' }),
  perm('catalog.select_download_version', 'Select download version', 'Select a particular compatible file or version.', { cat: 'catalog' }),
  perm('catalog.change_file_handling', 'Change catalog file handling', 'Change core download storage or processing behavior.', { cat: 'catalog', risk: 'elevated' }),

  perm('library.view', 'View library', 'View library entries.', { cat: 'library', risk: 'read' }),
  perm('library.view_files', 'View library files', 'View files attached to library entries.', { cat: 'library', risk: 'read' }),
  perm('library.download_files', 'Download library files', 'Download a stored file to the user’s device.', { cat: 'library', risk: 'read', informational: true }),
  perm('library.upload', 'Upload library files', 'Upload mod or add-on files.', { cat: 'library' }),
  perm('library.edit_metadata', 'Edit library metadata', 'Edit name, description, edition, loader, or compatibility metadata.', { cat: 'library' }),
  perm('library.add_file', 'Add library file', 'Add a file or version to an existing entry.', { cat: 'library' }),
  perm('library.remove_file', 'Remove library file', 'Remove one file without deleting the entry.', { cat: 'library' }),
  perm('library.delete_entry', 'Delete library entry', 'Delete an entry and manager-owned files.', { cat: 'library', risk: 'destructive', destructive: true }),
  perm('library.import_mcpedl', 'Import from MCPEDL', 'Import mods into the library from an MCPEDL URL.', { cat: 'library' }),

  perm('players.view', 'View players', 'View manager player records.', { cat: 'players', risk: 'read' }),
  perm('players.view_server_membership', 'View player server membership', 'View player allowlist, ban-list, and permission relationships.', { cat: 'players', risk: 'read' }),
  perm('players.scan', 'Scan Servers for Players', 'Scan a managed server for discovered players and add missing player records to the management console.', { cat: 'players' }),
  perm('players.add', 'Add player', 'Add players to the manager.', { cat: 'players' }),
  perm('players.remove_allowlist_all', 'Remove player from all allowlists', 'Remove a player from all managed allowlists.', { cat: 'players' }),
  perm('players.ban_all', 'Ban player everywhere', 'Ban a player across applicable managed servers.', { cat: 'players', risk: 'elevated' }),
  perm('players.unban_all', 'Unban player everywhere', 'Unban a player across applicable managed servers.', { cat: 'players', risk: 'elevated' }),

  perm('ports.view', 'View ports', 'View assigned and available ports.', { cat: 'ports', risk: 'read' }),
  perm('ports.refresh', 'Refresh port availability', 'Perform an active port availability check.', { cat: 'ports' }),

  perm('plugins.view', 'View plugins', 'View installed and available plugins.', { cat: 'plugins', risk: 'elevated' }),
  perm('plugins.view_details', 'View plugin details', 'View plugin version, capabilities, and permission declarations.', { cat: 'plugins', risk: 'elevated' }),
  perm('plugins.install', 'Install plugin', 'Install or upload a plugin.', { cat: 'plugins', risk: 'elevated' }),
  perm('plugins.enable', 'Enable plugin', 'Enable a plugin.', { cat: 'plugins', risk: 'elevated' }),
  perm('plugins.disable', 'Disable plugin', 'Disable a plugin.', { cat: 'plugins', risk: 'elevated' }),
  perm('plugins.configure', 'Configure plugins', 'Open and change general plugin settings.', { cat: 'plugins', risk: 'elevated' }),
  perm('plugins.enable_backend', 'Enable plugin backend', 'Approve trusted backend capability.', { cat: 'plugins', risk: 'elevated' }),

  perm('account.view_own_profile', 'View own profile', 'View the signed-in user’s profile.', { cat: 'user-management', sub: 'my-account', risk: 'read' }),
  perm('account.change_own_name', 'Change own name', 'Change the signed-in user’s display name.', { cat: 'user-management', sub: 'my-account' }),
  perm('account.change_own_password', 'Change own password', 'Change the signed-in user’s password.', { cat: 'user-management', sub: 'my-account' }),
  perm('account.view_own_permissions', 'View own permissions', 'View the signed-in user’s effective permissions.', { cat: 'user-management', sub: 'my-account', risk: 'read' }),

  perm('users.view', 'View users', 'View manager user accounts.', { cat: 'user-management', sub: 'users', risk: 'read' }),
  perm('users.view_details', 'View user details', 'View a user’s profile, groups, and assignments.', { cat: 'user-management', sub: 'users', risk: 'read' }),
  perm('users.create', 'Create users', 'Create manager user accounts.', { cat: 'user-management', sub: 'users', risk: 'elevated' }),
  perm('users.edit_name', 'Edit user names', 'Change another user’s display name.', { cat: 'user-management', sub: 'users' }),
  perm('users.reset_password', 'Reset user passwords', 'Reset another user’s password.', { cat: 'user-management', sub: 'users', risk: 'elevated' }),
  perm('users.activate', 'Activate users', 'Activate a user account.', { cat: 'user-management', sub: 'users' }),
  perm('users.deactivate', 'Deactivate users', 'Deactivate a user account.', { cat: 'user-management', sub: 'users', risk: 'elevated' }),
  perm('users.delete', 'Delete users', 'Delete a user account.', { cat: 'user-management', sub: 'users', risk: 'destructive', destructive: true }),
  perm('users.link_player', 'Link player to user', 'Link a player record to a user account.', { cat: 'user-management', sub: 'users' }),
  perm('users.unlink_player', 'Unlink player from user', 'Remove a player link from a user account.', { cat: 'user-management', sub: 'users' }),
  perm('users.assign_groups', 'Assign user groups', 'Add or remove a user’s group memberships.', { cat: 'user-management', sub: 'users', risk: 'elevated' }),
  perm('users.assign_permissions', 'Assign user permissions', 'Change a user’s direct permission assignments.', { cat: 'user-management', sub: 'users', risk: 'elevated' }),
  perm('users.view_effective_permissions', 'View user effective permissions', 'View a user’s effective permission result.', { cat: 'user-management', sub: 'users', risk: 'read' }),
  perm('users.set_administrator', 'Set administrator status', 'Grant or revoke actual administrator status.', { cat: 'user-management', sub: 'users', risk: 'administrator-only' }),

  perm('groups.view', 'View groups', 'View permission groups.', { cat: 'user-management', sub: 'groups', risk: 'read' }),
  perm('groups.view_details', 'View group details', 'View a group’s members and assignments.', { cat: 'user-management', sub: 'groups', risk: 'read' }),
  perm('groups.create', 'Create groups', 'Create permission groups.', { cat: 'user-management', sub: 'groups', risk: 'elevated' }),
  perm('groups.edit_name', 'Edit group name', 'Change a group’s display name.', { cat: 'user-management', sub: 'groups' }),
  perm('groups.activate', 'Activate groups', 'Activate a permission group.', { cat: 'user-management', sub: 'groups' }),
  perm('groups.deactivate', 'Deactivate groups', 'Deactivate a permission group.', { cat: 'user-management', sub: 'groups', risk: 'elevated' }),
  perm('groups.delete', 'Delete groups', 'Delete a permission group.', { cat: 'user-management', sub: 'groups', risk: 'destructive', destructive: true }),
  perm('groups.add_members', 'Add group members', 'Add users to a group.', { cat: 'user-management', sub: 'groups', risk: 'elevated' }),
  perm('groups.remove_members', 'Remove group members', 'Remove users from a group.', { cat: 'user-management', sub: 'groups', risk: 'elevated' }),
  perm('groups.assign_permissions', 'Assign group permissions', 'Change a group’s permission assignments.', { cat: 'user-management', sub: 'groups', risk: 'elevated' }),
  perm('groups.view_effective_permissions', 'View group effective permissions', 'View a group’s assigned permissions.', { cat: 'user-management', sub: 'groups', risk: 'read' }),
  perm('groups.reset_system_defaults', 'Reset system group defaults', 'Reset a built-in group to current starter defaults.', { cat: 'user-management', sub: 'groups', risk: 'administrator-only' }),

  perm('permissions.view_catalog', 'View permission catalog', 'View the permission catalog.', { cat: 'user-management', sub: 'permissions', risk: 'read' }),
  perm('permissions.view_assignments', 'View permission assignments', 'View user and group permission assignments.', { cat: 'user-management', sub: 'permissions', risk: 'read' }),
  perm('permissions.manage_assignability', 'Manage permission assignability', 'Change whether a permission can be assigned to users or groups.', { cat: 'user-management', sub: 'permissions', risk: 'administrator-only' }),
  perm('permissions.view_deprecated', 'View deprecated permissions', 'View deprecated permission aliases.', { cat: 'user-management', sub: 'permissions', risk: 'read' }),

  perm('security.view_settings', 'View security settings', 'View authentication and password-policy settings.', { cat: 'user-management', sub: 'security', risk: 'read' }),
  perm('security.configure_session_timeout', 'Configure session timeout', 'Change signed-in session duration.', { cat: 'user-management', sub: 'security', risk: 'administrator-only' }),
  perm('security.configure_password_policy', 'Configure password policy', 'Change password length and complexity requirements.', { cat: 'user-management', sub: 'security', risk: 'administrator-only' }),
];

const SERVER_SCOPED_KEYS = new Set([
  'servers.view',
  'servers.view_details',
  'servers.view_runtime_status',
  'servers.view_connection_details',
  'servers.view_properties',
  'servers.edit_display_name',
  'servers.edit_description',
  'servers.start',
  'servers.stop',
  'servers.restart',
  'servers.restart_with_warning',
  'servers.cancel_scheduled_restart',
  'servers.delete',
  'servers.update_software',
  'servers.configure_auto_update',
  'servers.manage_lan_broadcast',
  'servers.console.view',
  'servers.console.send_commands',
  'servers.properties.server_name',
  'servers.properties.level_seed',
  'servers.properties.max_players',
  'servers.properties.default_player_permission',
  'servers.properties.default_1st_person',
  'servers.properties.game_mode',
  'servers.properties.force_game_mode',
  'servers.properties.difficulty',
  'servers.properties.allow_cheats',
  'servers.properties.player_idle_timeout',
  'servers.properties.tx_rate',
  'servers.properties.auto_ice',
  'servers.properties.natural_regeneration',
  'servers.properties.online_mode',
  'servers.properties.allowlist_enabled',
  'servers.properties.allow_third_party_requests',
  'servers.properties.allow_third_party_pictures',
  'servers.properties.require_secure_chat',
  'servers.properties.enable_player_data_initialization',
  'servers.properties.ipv4_port',
  'servers.properties.ipv6_port',
  'servers.properties.lan_visibility',
  'servers.properties.view_distance',
  'servers.properties.tick_distance',
  'servers.properties.texture_pack_required',
  'servers.properties.movement_authority',
  'servers.properties.server_authoritative_inventory',
  'servers.remote.view_target',
  'servers.remote.change_target_host',
  'servers.remote.change_target_port',
  'servers.remote.change_local_port',
  'servers.remote.start_proxy',
  'servers.remote.stop_proxy',
  'servers.remote.restart_proxy',
  'servers.allowlist.view',
  'servers.allowlist.add',
  'servers.allowlist.remove',
  'servers.allowlist.sync',
  'servers.banlist.view',
  'servers.banlist.add',
  'servers.banlist.remove',
  'servers.banlist.sync',
  'servers.player_permissions.view',
  'servers.player_permissions.set_visitor',
  'servers.player_permissions.set_member',
  'servers.player_permissions.set_operator',
  'servers.player_permissions.reset',
  'servers.mods.view',
  'servers.mods.install',
  'servers.mods.remove',
  'servers.mods.resolve_dependencies',
  'servers.mods.view_restart_status',
  'players.view_server_membership',
  'players.scan',
]);

const SERVER_KIND_LIMITS = {
  'servers.start': ['bedrock'],
  'servers.stop': ['bedrock'],
  'servers.remote.view_target': ['remote'],
  'servers.remote.change_target_host': ['remote'],
  'servers.remote.change_target_port': ['remote'],
  'servers.remote.change_local_port': ['remote'],
  'servers.remote.start_proxy': ['remote'],
  'servers.remote.stop_proxy': ['remote'],
  'servers.remote.restart_proxy': ['remote'],
};

for (const item of CORE_PERMISSIONS) {
  if (!SERVER_SCOPED_KEYS.has(item.key)) continue;
  item.resourceScopes = ['server'];
  item.assignableAtServerScope = true;
  if (SERVER_KIND_LIMITS[item.key]) item.serverKinds = SERVER_KIND_LIMITS[item.key];
}

const JAVA_FIELD_NAMES = [
  'pvp',
  'allow_nether',
  'allow_flight',
  'enable_command_block',
  'hardcore',
  'spawn_animals',
  'spawn_npcs',
  'spawn_monsters',
  'generate_structures',
  'hide_online_players',
  'enforce_whitelist',
  'require_resource_pack',
  'broadcast_console_to_ops',
  'enable_status',
  'enable_query',
  'enable_rcon',
  'sync_chunk_writes',
  'prevent_proxy_connections',
  'enforce_secure_profile',
  'network_compression_threshold',
  'entity_broadcast_range_percentage',
  'query_port',
  'rcon_port',
  'rcon_password',
  'resource_pack',
  'resource_pack_sha1',
  'level_type',
  'max_world_size',
  'simulation_distance',
  'spawn_protection',
  'op_permission_level',
  'function_permission_level',
];

const JAVA_PERMISSION_KEYS = [
  'servers.create_java',
  'servers.start_java',
  'servers.stop_java',
  ...JAVA_FIELD_NAMES.map((field) => `servers.java.${field}`),
];

const JAVA_PERMISSIONS = JAVA_PERMISSION_KEYS.map((key) => ({ key, edition: 'java' }));
const JAVA_FIELD_PERMISSIONS = JAVA_FIELD_NAMES.map((field) => ({
  key: `servers.java.${field}`,
  field,
}));
const BEDROCK_CONNECT_PERMISSIONS = [];
const CATALOG_PLUGIN_PERMISSIONS = [];
const PLUGIN_OWNED_PERMISSIONS = [];

function dep(key, displayName, description, aliasOf, extra = {}) {
  const replacements = extra.replacementKeys || (Array.isArray(aliasOf) ? aliasOf : [aliasOf]);
  return perm(key, displayName, description, {
    ...extra,
    deprecated: true,
    aliasOf: Array.isArray(aliasOf) ? aliasOf[0] : aliasOf,
    replacementKeys: replacements,
    assignableToUsers: false,
    assignableToGroups: false,
    active: false,
  });
}

const DEPRECATED_PERMISSIONS = [
  dep('menu.view.dashboard', 'View Dashboard', 'Deprecated alias for dashboard.view', 'dashboard.view', { cat: 'dashboard' }),
  dep('menu.view.servers', 'View Servers', 'Deprecated alias for servers.view', 'servers.view', { cat: 'servers' }),
  dep('menu.view.servers_new', 'View New Server', 'Deprecated menu alias. Creation is controlled by server-type create permissions.', [], { cat: 'servers', replacementKeys: [] }),
  dep('menu.view.library', 'View Mod Library', 'Deprecated alias for library.view', 'library.view', { cat: 'library' }),
  dep('menu.view.catalog', 'View Mod Catalog', 'Deprecated alias for catalog.view', 'catalog.view', { cat: 'catalog' }),
  dep('menu.view.players', 'View Players', 'Deprecated alias for players.view', 'players.view', { cat: 'players' }),
  dep('menu.view.ports', 'View Ports', 'Deprecated alias for ports.view', 'ports.view', { cat: 'ports' }),
  dep('menu.view.users', 'View Users', 'Deprecated alias for users.view', 'users.view', { cat: 'user-management' }),
  dep('menu.view.plugins', 'View Plugins', 'Deprecated alias for plugins.view', 'plugins.view', { cat: 'plugins' }),
  dep('menu.view.bedrock_connect', 'View BedrockConnect', 'Deprecated alias for bedrock_connect.view', 'bedrock_connect.view', { cat: 'bedrock-connect', source: 'first-party-plugin', pluginId: BEDROCK_CONNECT_PLUGIN_ID }),

  dep('servers.create', 'Create new server', 'Deprecated alias for servers.create_bedrock', 'servers.create_bedrock', { cat: 'servers' }),
  dep('servers.start_remote', 'Start a remote server', 'Deprecated alias for servers.remote.start_proxy', 'servers.remote.start_proxy', { cat: 'servers' }),
  dep('servers.stop_remote', 'Stop a remote server', 'Deprecated alias for servers.remote.stop_proxy', 'servers.remote.stop_proxy', { cat: 'servers' }),
  dep('servers.set_lan', 'Set LAN Feature', 'Deprecated alias for servers.manage_lan_broadcast', 'servers.manage_lan_broadcast', { cat: 'servers' }),
  dep('servers.console', 'Send Console Commands', 'Deprecated alias for console view and send-command permissions', ['servers.console.view', 'servers.console.send_commands'], { cat: 'servers' }),
  dep('servers.add_allowed_players', 'Add allowed players', 'Deprecated alias for servers.allowlist.add', 'servers.allowlist.add', { cat: 'servers' }),
  dep('servers.remove_allowed_players', 'Remove allowed players', 'Deprecated alias for servers.allowlist.remove', 'servers.allowlist.remove', { cat: 'servers' }),
  dep('servers.add_banned_players', 'Add banned players', 'Deprecated alias for servers.banlist.add', 'servers.banlist.add', { cat: 'servers' }),
  dep('servers.remove_banned_players', 'Remove banned players', 'Deprecated alias for servers.banlist.remove', 'servers.banlist.remove', { cat: 'servers' }),
  dep('servers.update', 'Update Server', 'Deprecated alias for software update and auto-update permissions', ['servers.update_software', 'servers.configure_auto_update'], { cat: 'servers' }),
  dep('servers.change_player_permissions', 'Change Player Permissions', 'Deprecated alias for per-server player permission keys', [
    'servers.player_permissions.set_visitor',
    'servers.player_permissions.set_member',
    'servers.player_permissions.set_operator',
    'servers.player_permissions.reset',
    'servers.properties.default_player_permission',
    'servers.properties.default_1st_person',
  ], { cat: 'servers' }),
  dep('servers.add_mods', 'Add Mods', 'Deprecated alias for mod install and dependency resolution', ['servers.mods.install', 'servers.mods.resolve_dependencies'], { cat: 'servers' }),
  dep('servers.remove_mods', 'Remove Mods', 'Deprecated alias for servers.mods.remove', 'servers.mods.remove', { cat: 'servers' }),
  dep('servers.change_general_settings', 'Change General Settings', 'Deprecated alias for identity, port, and description permissions', [
    'servers.edit_display_name',
    'servers.edit_description',
    'servers.properties.server_name',
    'servers.properties.level_seed',
    'servers.properties.max_players',
    'servers.properties.ipv4_port',
    'servers.properties.ipv6_port',
  ], { cat: 'servers' }),
  dep('servers.change_game_settings', 'Change Game Settings', 'Deprecated alias for gameplay and performance property permissions', [
    'servers.properties.game_mode',
    'servers.properties.difficulty',
    'servers.properties.view_distance',
    'servers.properties.tick_distance',
    'servers.properties.player_idle_timeout',
    'servers.properties.tx_rate',
  ], { cat: 'servers' }),
  dep('servers.change_server_options', 'Change Server Options', 'Deprecated alias for access, content, and related property permissions', [
    'servers.properties.allow_cheats',
    'servers.properties.movement_authority',
    'servers.properties.allowlist_enabled',
    'servers.properties.texture_pack_required',
    'servers.properties.auto_ice',
    'servers.properties.natural_regeneration',
    'servers.properties.online_mode',
    'servers.properties.lan_visibility',
    'servers.properties.allow_third_party_requests',
    'servers.properties.allow_third_party_pictures',
    'servers.properties.require_secure_chat',
    'servers.properties.server_authoritative_inventory',
    'servers.properties.enable_player_data_initialization',
    'servers.properties.force_game_mode',
  ], { cat: 'servers' }),
  dep('servers.change_remote_local_ports', 'Change Remote Server Local Ports', 'Deprecated alias for servers.remote.change_local_port', 'servers.remote.change_local_port', { cat: 'servers' }),
  dep('servers.change_remote_target', 'Change Remote Target Ports', 'Deprecated alias for remote host and target-port permissions', [
    'servers.remote.change_target_host',
    'servers.remote.change_target_port',
  ], { cat: 'servers' }),
  dep('servers.change_java_settings', 'Change Java-only settings', 'Deprecated alias for Java Hosting plugin property permissions', JAVA_FIELD_NAMES.map((field) => `servers.java.${field}`), { cat: 'servers', source: 'first-party-plugin', pluginId: JAVA_PLUGIN_ID }),
  dep('servers.create_bedrock_connect', 'Create a BedrockConnect server', 'Deprecated alias for bedrock_connect.create', 'bedrock_connect.create', { cat: 'bedrock-connect', source: 'first-party-plugin', pluginId: BEDROCK_CONNECT_PLUGIN_ID }),
  dep('servers.start_bedrock_connect', 'Start a BedrockConnect server', 'Deprecated alias for bedrock_connect.start', 'bedrock_connect.start', { cat: 'bedrock-connect', source: 'first-party-plugin', pluginId: BEDROCK_CONNECT_PLUGIN_ID }),
  dep('servers.stop_bedrock_connect', 'Stop a BedrockConnect server', 'Deprecated alias for bedrock_connect.stop', 'bedrock_connect.stop', { cat: 'bedrock-connect', source: 'first-party-plugin', pluginId: BEDROCK_CONNECT_PLUGIN_ID }),
  dep('bedrock_connect.enable_dns_proxy', 'Enable DNS Proxy', 'Deprecated alias for bedrock_connect.dns.enable_proxy', 'bedrock_connect.dns.enable_proxy', { cat: 'bedrock-connect', source: 'first-party-plugin', pluginId: BEDROCK_CONNECT_PLUGIN_ID }),
  dep('bedrock_connect.set_upstream_dns', 'Set upstream DNS', 'Deprecated alias for bedrock_connect.dns.set_upstream', 'bedrock_connect.dns.set_upstream', { cat: 'bedrock-connect', source: 'first-party-plugin', pluginId: BEDROCK_CONNECT_PLUGIN_ID }),
  dep('bedrock_connect.set_dns_overrides', 'Set DNS overrides', 'Deprecated alias for BedrockConnect DNS override permissions', [
    'bedrock_connect.dns.add_override',
    'bedrock_connect.dns.edit_override',
    'bedrock_connect.dns.remove_override',
  ], { cat: 'bedrock-connect', source: 'first-party-plugin', pluginId: BEDROCK_CONNECT_PLUGIN_ID }),

  dep('catalog.download_mods', 'Download Mods', 'Deprecated alias for catalog.download_to_library', 'catalog.download_to_library', { cat: 'catalog' }),
  dep('catalog.set_curseforge_key', 'Set CurseForge key', 'Deprecated alias for catalog.curseforge.configure', 'catalog.curseforge.configure', { cat: 'catalog', source: 'first-party-plugin', pluginId: CURSEFORGE_PLUGIN_ID }),
  dep('catalog.enable_git', 'Enable Git Catalog', 'Deprecated alias for Git catalog configuration', ['catalog.git.configure', 'catalog.git.sync'], { cat: 'catalog', source: 'first-party-plugin', pluginId: GIT_CATALOG_PLUGIN_ID }),
  dep('catalog.enable_file', 'Enable File Catalog', 'Deprecated alias for catalog.file.configure', 'catalog.file.configure', { cat: 'catalog', source: 'first-party-plugin', pluginId: FILE_CATALOG_PLUGIN_ID }),

  dep('library.delete', 'Delete mods', 'Deprecated alias for library.delete_entry', 'library.delete_entry', { cat: 'library' }),
  dep('library.change_settings', 'Change mod settings', 'Deprecated alias for library metadata and file permissions', [
    'library.edit_metadata',
    'library.add_file',
    'library.remove_file',
  ], { cat: 'library' }),

  dep('players.remove_whitelisted', 'Remove whitelisted players', 'Deprecated alias for players.remove_allowlist_all', 'players.remove_allowlist_all', { cat: 'players' }),

  dep('users.change_password', 'Change user password', 'Deprecated alias for own-password and reset-password permissions', [
    'account.change_own_password',
    'users.reset_password',
  ], { cat: 'user-management' }),
  dep('users.change_name', 'Change name', 'Deprecated alias for own-name and user-name permissions', [
    'account.change_own_name',
    'users.edit_name',
  ], { cat: 'user-management' }),
  dep('users.change_user_permissions', 'Change User Permissions', 'Deprecated alias for user account and assignment permissions', [
    'users.view',
    'users.view_details',
    'users.create',
    'users.activate',
    'users.deactivate',
    'users.delete',
    'users.link_player',
    'users.unlink_player',
    'users.assign_permissions',
    'users.view_effective_permissions',
  ], { cat: 'user-management' }),
  dep('users.change_group_permissions', 'Change Group Permissions', 'Deprecated alias for group assignment and catalog permissions', [
    'groups.view',
    'groups.view_details',
    'groups.edit_name',
    'groups.activate',
    'groups.deactivate',
    'groups.assign_permissions',
    'groups.view_effective_permissions',
    'permissions.view_catalog',
    'permissions.view_assignments',
  ], { cat: 'user-management' }),
  dep('users.change_group_membership', 'Change Group Membership', 'Deprecated alias for group membership permissions', [
    'users.assign_groups',
    'groups.add_members',
    'groups.remove_members',
  ], { cat: 'user-management' }),
  dep('users.add_groups', 'Add groups', 'Deprecated alias for groups.create', 'groups.create', { cat: 'user-management' }),
  dep('users.delete_groups', 'Delete group', 'Deprecated alias for groups.delete', 'groups.delete', { cat: 'user-management' }),

  dep('plugins.upload', 'Upload a plugin', 'Deprecated alias for plugins.install', 'plugins.install', { cat: 'plugins' }),
];

const LOOKUP_PERMISSIONS = [
  ...CORE_PERMISSIONS,
  ...DEPRECATED_PERMISSIONS,
];

const PROPERTY_FIELD_MAP = {
  name: 'servers.edit_display_name',
  server_description: 'servers.edit_description',
  server_motd: 'servers.properties.server_name',
  level_seed: 'servers.properties.level_seed',
  max_players: 'servers.properties.max_players',
  maxPlayers: 'servers.properties.max_players',
  default_player_permission: 'servers.properties.default_player_permission',
  default_1st_person: 'servers.properties.default_1st_person',
  gamemode: 'servers.properties.game_mode',
  force_gamemode: 'servers.properties.force_game_mode',
  difficulty: 'servers.properties.difficulty',
  enable_cheats: 'servers.properties.allow_cheats',
  player_idle_timeout: 'servers.properties.player_idle_timeout',
  tx_rate: 'servers.properties.tx_rate',
  auto_ice: 'servers.properties.auto_ice',
  natural_regeneration: 'servers.properties.natural_regeneration',
  online_mode: 'servers.properties.online_mode',
  whitelist_mode: 'servers.properties.allowlist_enabled',
  allow_third_party_requests: 'servers.properties.allow_third_party_requests',
  allow_third_party_pictures: 'servers.properties.allow_third_party_pictures',
  require_secure_chat: 'servers.properties.require_secure_chat',
  enable_player_data_initialization: 'servers.properties.enable_player_data_initialization',
  port: 'servers.properties.ipv4_port',
  ipv6Port: 'servers.properties.ipv6_port',
  ipv6_port: 'servers.properties.ipv6_port',
  remote_discovery: 'servers.properties.lan_visibility',
  view_distance: 'servers.properties.view_distance',
  tick_distance: 'servers.properties.tick_distance',
  texture_pack_required: 'servers.properties.texture_pack_required',
  server_authoritative: 'servers.properties.movement_authority',
  server_authoritative_inventory: 'servers.properties.server_authoritative_inventory',
};

const REMOTE_FIELD_MAP = {
  port: 'servers.remote.change_local_port',
  ipv6Port: 'servers.remote.change_local_port',
  ipv6_port: 'servers.remote.change_local_port',
  remoteHost: 'servers.remote.change_target_host',
  remote_host: 'servers.remote.change_target_host',
  remoteIpv4Port: 'servers.remote.change_target_port',
  remote_ipv4_port: 'servers.remote.change_target_port',
  remoteIpv6Port: 'servers.remote.change_target_port',
  remote_ipv6_port: 'servers.remote.change_target_port',
};

const JAVA_FIELD_MAP = Object.fromEntries(
  JAVA_FIELD_NAMES.map((field) => [field, `servers.java.${field}`]),
);

const READ_ONLY_KEYS = [
  'account.view_own_profile',
  'account.change_own_name',
  'account.change_own_password',
  'account.view_own_permissions',
  'dashboard.view',
  'dashboard.view_runtime_status',
  'dashboard.view_connection_details',
  'servers.view',
  'servers.view_details',
  'servers.view_runtime_status',
  'servers.view_connection_details',
  'servers.view_properties',
];

const STANDARD_KEYS = [
  ...READ_ONLY_KEYS,
  'servers.remote.view_target',
  'servers.allowlist.view',
  'servers.banlist.view',
  'servers.player_permissions.view',
  'servers.mods.view',
  'servers.mods.view_restart_status',
  'catalog.view',
  'catalog.search',
  'catalog.view_details',
  'library.view',
  'library.view_files',
  'library.download_files',
  'players.view',
  'players.view_server_membership',
];

const POWER_USER_KEYS = [
  ...STANDARD_KEYS,
  'servers.create_bedrock',
  'servers.create_remote',
  'servers.edit_display_name',
  'servers.edit_description',
  'servers.start',
  'servers.stop',
  'servers.restart',
  'servers.restart_with_warning',
  'servers.cancel_scheduled_restart',
  'servers.update_software',
  'servers.manage_lan_broadcast',
  'servers.console.view',
  'servers.console.send_commands',
  'servers.properties.server_name',
  'servers.properties.max_players',
  'servers.properties.default_player_permission',
  'servers.properties.game_mode',
  'servers.properties.force_game_mode',
  'servers.properties.difficulty',
  'servers.properties.allow_cheats',
  'servers.properties.player_idle_timeout',
  'servers.properties.allowlist_enabled',
  'servers.properties.allow_third_party_pictures',
  'servers.properties.lan_visibility',
  'servers.properties.view_distance',
  'servers.properties.tick_distance',
  'servers.properties.texture_pack_required',
  'servers.remote.start_proxy',
  'servers.remote.stop_proxy',
  'servers.remote.restart_proxy',
  'servers.allowlist.add',
  'servers.allowlist.remove',
  'servers.allowlist.sync',
  'servers.banlist.add',
  'servers.banlist.remove',
  'servers.banlist.sync',
  'servers.player_permissions.set_visitor',
  'servers.player_permissions.set_member',
  'servers.player_permissions.set_operator',
  'servers.player_permissions.reset',
  'servers.mods.install',
  'servers.mods.remove',
  'servers.mods.resolve_dependencies',
  'catalog.download_to_library',
  'catalog.select_download_version',
  'library.upload',
  'library.edit_metadata',
  'library.add_file',
  'library.remove_file',
  'players.add',
  'players.scan',
  'players.remove_allowlist_all',
  'players.ban_all',
  'players.unban_all',
  'ports.view',
  'ports.refresh',
];

const OLD_STANDARD_KEYS = [
  'servers.create',
  'servers.create_remote',
  'servers.create_java',
  'servers.view_details',
  'servers.start',
  'servers.stop',
  'servers.start_java',
  'servers.stop_java',
  'servers.change_java_settings',
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
  'menu.view.dashboard',
  'menu.view.servers',
  'menu.view.servers_new',
  'menu.view.library',
  'menu.view.catalog',
  'menu.view.players',
  'menu.view.ports',
  'menu.view.users',
  'menu.view.plugins',
];

const OLD_READ_ONLY_MENU_ALLOW = [
  'menu.view.dashboard',
  'menu.view.players',
  'menu.view.library',
];

const STALE_PERMISSION_MAP = Object.fromEntries(
  DEPRECATED_PERMISSIONS.map((item) => [item.key, item.replacementKeys || []]),
);

const SYSTEM_GROUPS = [
  { systemKey: 'administrators', slug: 'administrators', name: 'Administrators', bundle: 'administrators' },
  { systemKey: 'standard-users', slug: 'standard', name: 'Standard Users', bundle: 'standard-users', legacyNames: ['Standard'] },
  { systemKey: 'read-only', slug: 'read-only', name: 'Read-only', bundle: 'read-only', legacyNames: ['Read-only'] },
  { systemKey: 'power-users', slug: 'power-users', name: 'Power Users', bundle: 'power-users' },
];

const DEFAULT_GROUPS = SYSTEM_GROUPS.map((item) => ({
  slug: item.slug,
  systemKey: item.systemKey,
  name: item.name,
  keys: item.bundle === 'read-only'
    ? READ_ONLY_KEYS
    : item.bundle === 'standard-users'
      ? STANDARD_KEYS
      : item.bundle === 'power-users'
        ? POWER_USER_KEYS
        : null,
}));

const USER_MANAGEMENT_KEYS = CORE_PERMISSIONS
  .filter((item) => item.primaryCategory === 'user-management')
  .map((item) => item.key);

const CREATE_SERVER_PERMISSIONS = [
  'servers.create_bedrock',
  'servers.create_remote',
  'servers.create_java',
  'bedrock_connect.create',
];

const BUNDLED_PERMISSION_OWNERS = {
  [BEDROCK_CONNECT_PLUGIN_ID]: (key) => String(key).startsWith('bedrock_connect.'),
  [JAVA_PLUGIN_ID]: (key) => (
    key === 'servers.create_java'
    || key === 'servers.start_java'
    || key === 'servers.stop_java'
    || String(key).startsWith('servers.java.')
  ),
  [CURSEFORGE_PLUGIN_ID]: (key) => key === 'catalog.curseforge.configure' || key === 'library.import_curseforge',
  [GIT_CATALOG_PLUGIN_ID]: (key) => String(key).startsWith('catalog.git.'),
  [FILE_CATALOG_PLUGIN_ID]: (key) => String(key).startsWith('catalog.file.'),
};

module.exports = {
  CATALOG_SCHEMA_VERSION,
  DEFAULTS_VERSION,
  JAVA_PLUGIN_ID,
  BEDROCK_CONNECT_PLUGIN_ID,
  CURSEFORGE_PLUGIN_ID,
  GIT_CATALOG_PLUGIN_ID,
  FILE_CATALOG_PLUGIN_ID,
  CATEGORIES,
  SUBCATEGORIES,
  perm,
  CORE_PERMISSIONS,
  JAVA_PERMISSION_KEYS,
  JAVA_FIELD_NAMES,
  BEDROCK_CONNECT_PERMISSIONS,
  JAVA_PERMISSIONS,
  JAVA_FIELD_PERMISSIONS,
  CATALOG_PLUGIN_PERMISSIONS,
  PLUGIN_OWNED_PERMISSIONS,
  DEPRECATED_PERMISSIONS,
  LOOKUP_PERMISSIONS,
  PROPERTY_FIELD_MAP,
  REMOTE_FIELD_MAP,
  JAVA_FIELD_MAP,
  READ_ONLY_KEYS,
  STANDARD_KEYS,
  POWER_USER_KEYS,
  OLD_STANDARD_KEYS,
  OLD_READ_ONLY_MENU_ALLOW,
  STALE_PERMISSION_MAP,
  SYSTEM_GROUPS,
  DEFAULT_GROUPS,
  USER_MANAGEMENT_KEYS,
  CREATE_SERVER_PERMISSIONS,
  BUNDLED_PERMISSION_OWNERS,
};
