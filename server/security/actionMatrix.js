const ACTION_MATRIX = [
  { method: 'POST', route: '/api/auth/bootstrap', action: 'bootstrap administrator', mode: 'authentication', exceptionReason: 'Initial administrator bootstrap before RBAC sessions exist', risk: 'elevated' },
  { method: 'POST', route: '/api/auth/login', action: 'login', mode: 'authentication', exceptionReason: 'Public authentication operation', risk: 'normal' },
  { method: 'POST', route: '/api/auth/logout', action: 'logout', mode: 'authentication', exceptionReason: 'Public session termination', risk: 'read' },
  { method: 'PUT', route: '/api/auth/password', action: 'change own password', mode: 'authentication', permission: 'account.change_own_password', exceptionReason: 'Change own password with current-password confirmation', risk: 'normal' },

  { method: 'POST', route: '/api/user-management/users', action: 'create user', mode: 'composite', permissions: ['users.create'], risk: 'elevated' },
  { method: 'PUT', route: '/api/user-management/users/:id', action: 'update user', mode: 'field-mapped', resolver: 'userManagement.putUser', risk: 'elevated' },
  { method: 'DELETE', route: '/api/user-management/users/:id', action: 'delete user', mode: 'static', permission: 'users.delete', risk: 'destructive' },
  { method: 'POST', route: '/api/user-management/groups', action: 'create group', mode: 'static', permission: 'groups.create', risk: 'elevated' },
  { method: 'PUT', route: '/api/user-management/groups/:id', action: 'update group', mode: 'field-mapped', resolver: 'userManagement.putGroup', risk: 'elevated' },
  { method: 'DELETE', route: '/api/user-management/groups/:id', action: 'delete group', mode: 'static', permission: 'groups.delete', risk: 'destructive' },
  { method: 'POST', route: '/api/user-management/groups/:id/reset-defaults', action: 'reset system group defaults', mode: 'static', permission: 'groups.reset_system_defaults', risk: 'administrator-only' },
  { method: 'PUT', route: '/api/user-management/permissions/:key', action: 'manage permission assignability', mode: 'static', permission: 'permissions.manage_assignability', risk: 'administrator-only' },
  { method: 'PUT', route: '/api/user-management/settings', action: 'save security settings', mode: 'composite', permissions: ['security.configure_session_timeout', 'security.configure_password_policy'], risk: 'administrator-only' },

  { method: 'POST', route: '/api/servers', action: 'create server', mode: 'kind-specific', resolver: 'createPermissionForKind', risk: 'elevated' },
  { method: 'PUT', route: '/api/servers/:id', action: 'update server settings', mode: 'field-mapped', resolver: 'requiredServerUpdatePermissions', risk: 'elevated' },
  { method: 'DELETE', route: '/api/servers/:id', action: 'delete server', mode: 'kind-specific', resolver: 'deletePermissionForKind', risk: 'destructive' },
  { method: 'POST', route: '/api/servers/bedrock-connect/check-updates', action: 'check BedrockConnect updates', mode: 'static', permission: 'bedrock_connect.change_settings', risk: 'elevated' },
  { method: 'POST', route: '/api/servers/bedrock-connect', action: 'create BedrockConnect', mode: 'static', permission: 'bedrock_connect.create', risk: 'elevated' },
  { method: 'POST', route: '/api/servers/:id/plugin-actions', action: 'run plugin server action', mode: 'plugin-action', resolver: 'pluginActions.invoke', risk: 'elevated' },
  { method: 'POST', route: '/api/servers/:id/start', action: 'start server', mode: 'kind-specific', resolver: 'startPermissionForKind', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/stop', action: 'stop server', mode: 'kind-specific', resolver: 'stopPermissionForKind', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/restart', action: 'restart server', mode: 'kind-specific', resolver: 'restartPermissionForKind', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/restart-with-warning', action: 'restart with warning', mode: 'static', permission: 'servers.restart_with_warning', risk: 'normal' },
  { method: 'DELETE', route: '/api/servers/:id/restart-with-warning', action: 'cancel scheduled restart', mode: 'static', permission: 'servers.cancel_scheduled_restart', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/command', action: 'send console command', mode: 'static', permission: 'servers.console.send_commands', risk: 'elevated' },
  { method: 'POST', route: '/api/servers/:id/update', action: 'update software', mode: 'static', permission: 'servers.update_software', risk: 'elevated' },
  { method: 'POST', route: '/api/servers/:id/auto-update', action: 'enable auto-update', mode: 'static', permission: 'servers.configure_auto_update', risk: 'elevated' },
  { method: 'DELETE', route: '/api/servers/:id/auto-update', action: 'disable auto-update', mode: 'static', permission: 'servers.configure_auto_update', risk: 'elevated' },
  { method: 'PUT', route: '/api/servers/:id/lan-broadcast', action: 'manage LAN broadcast', mode: 'static', permission: 'servers.manage_lan_broadcast', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/java/dependencies/resolve', action: 'resolve java dependencies', mode: 'composite', permissions: ['servers.mods.install', 'servers.mods.resolve_dependencies'], risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/java/mods/validate', action: 'validate java mods', mode: 'static', permission: 'servers.mods.install', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/java/mods', action: 'install java mods', mode: 'static', permission: 'servers.mods.install', risk: 'normal' },
  { method: 'DELETE', route: '/api/servers/:id/java/mods/:installationId', action: 'remove java mods', mode: 'static', permission: 'servers.mods.remove', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/java/dependencies/reevaluate', action: 'reevaluate java dependencies', mode: 'composite', permissions: ['servers.mods.install', 'servers.mods.resolve_dependencies'], risk: 'normal' },

  { method: 'POST', route: '/api/mods/upload', action: 'upload library file', mode: 'static', permission: 'library.upload', risk: 'normal' },
  { method: 'POST', route: '/api/mods/import-curseforge', action: 'import from CurseForge', mode: 'static', permission: 'library.import_curseforge', risk: 'normal' },
  { method: 'POST', route: '/api/mods/import-mcpedl', action: 'import from MCPEDL', mode: 'static', permission: 'library.import_mcpedl', risk: 'normal' },
  { method: 'PUT', route: '/api/mods/:id', action: 'edit library metadata', mode: 'static', permission: 'library.edit_metadata', risk: 'normal' },
  { method: 'POST', route: '/api/mods/:id/files', action: 'add library file', mode: 'static', permission: 'library.add_file', risk: 'normal' },
  { method: 'DELETE', route: '/api/mods/:id/files', action: 'remove library file', mode: 'static', permission: 'library.remove_file', risk: 'normal' },
  { method: 'DELETE', route: '/api/mods/:id', action: 'delete library entry', mode: 'static', permission: 'library.delete_entry', risk: 'destructive' },
  { method: 'POST', route: '/api/mods/:modId/install/:serverId', action: 'install mod on server', mode: 'static', permission: 'servers.mods.install', risk: 'normal' },
  { method: 'DELETE', route: '/api/mods/:modId/uninstall/:serverId', action: 'remove mod from server', mode: 'static', permission: 'servers.mods.remove', risk: 'normal' },
  { method: 'PUT', route: '/api/mods/catalog/multi-file-mode', action: 'change file handling', mode: 'static', permission: 'catalog.change_file_handling', risk: 'elevated' },
  { method: 'POST', route: '/api/mods/catalog/git/sync', action: 'sync Git catalog', mode: 'static', permission: 'catalog.git.sync', risk: 'normal' },
  { method: 'POST', route: '/api/mods/catalog/download/:slug', action: 'download catalog item', mode: 'static', permission: 'catalog.download_to_library', risk: 'normal' },

  { method: 'PUT', route: '/api/players/server/:serverId/:playerId', action: 'update player server access', mode: 'field-mapped', resolver: 'players.updateServerAccess', risk: 'normal' },
  { method: 'POST', route: '/api/players/scan/:serverId', action: 'scan players', mode: 'composite', permissions: ['players.scan', 'servers.view_details'], risk: 'normal' },
  { method: 'POST', route: '/api/players', action: 'add player', mode: 'static', permission: 'players.add', risk: 'normal' },
  { method: 'POST', route: '/api/players/:id/whitelist', action: 'allowlist player', mode: 'static', permission: 'servers.allowlist.add', risk: 'normal', resourceResolver: 'server' },
  { method: 'POST', route: '/api/players/:id/unwhitelist', action: 'remove allowlist', mode: 'static', permission: 'servers.allowlist.remove', risk: 'normal', resourceResolver: 'server' },
  { method: 'POST', route: '/api/players/:id/unwhitelist-all', action: 'remove allowlist everywhere', mode: 'static', permission: 'players.remove_allowlist_all', risk: 'normal' },
  { method: 'POST', route: '/api/players/:id/ban-all', action: 'ban player everywhere', mode: 'static', permission: 'players.ban_all', risk: 'elevated' },
  { method: 'POST', route: '/api/players/:id/unban-all', action: 'unban player everywhere', mode: 'static', permission: 'players.unban_all', risk: 'elevated' },

  { method: 'POST', route: '/api/plugins/:pluginId/settings/actions/:actionId', action: 'run plugin settings action', mode: 'plugin-action', resolver: 'pluginSettings.invoke', risk: 'elevated' },
  { method: 'POST', route: '/api/plugins/upload', action: 'install plugin', mode: 'static', permission: 'plugins.install', risk: 'elevated' },
  { method: 'PUT', route: '/api/plugins/:pluginId/backend-enabled', action: 'enable plugin backend', mode: 'static', permission: 'plugins.enable_backend', risk: 'elevated' },
  { method: 'PUT', route: '/api/plugins/:pluginId/enabled', action: 'enable or disable plugin', mode: 'composite', permissions: ['plugins.enable', 'plugins.disable'], risk: 'elevated' },

  { method: 'PUT', route: '/api/bedrock-connect/dns', action: 'update DNS settings', mode: 'field-mapped', resolver: 'bedrockConnect.dns', risk: 'elevated' },

  { method: 'POST', route: '/api/java/providers/:providerId/validate', action: 'validate java loader', mode: 'static', permission: 'servers.create_java', risk: 'elevated' },

  { method: 'POST', route: '/api/gateways/providers/:providerId/recommend', action: 'recommend gateway configuration', mode: 'static', permission: 'servers.create_java', risk: 'elevated' },
  { method: 'POST', route: '/api/gateways', action: 'create geyser gateway', mode: 'static', permission: 'gateways.create', risk: 'elevated' },
  { method: 'PATCH', route: '/api/gateways/:id', action: 'update geyser gateway', mode: 'static', permission: 'plugins.configure', risk: 'elevated' },
  { method: 'POST', route: '/api/gateways/:id/apply-settings', action: 'apply geyser settings', mode: 'static', permission: 'plugins.configure', risk: 'elevated' },
  { method: 'DELETE', route: '/api/gateways/:id', action: 'delete geyser gateway', mode: 'static', permission: 'servers.delete', risk: 'destructive' },
  { method: 'POST', route: '/api/gateways/:id/start', action: 'start geyser gateway', mode: 'static', permission: 'servers.start_java', risk: 'normal' },
  { method: 'POST', route: '/api/gateways/:id/stop', action: 'stop geyser gateway', mode: 'static', permission: 'servers.stop_java', risk: 'normal' },
  { method: 'POST', route: '/api/gateways/:id/restart', action: 'restart geyser gateway', mode: 'static', permission: 'servers.restart', risk: 'normal' },

  { method: 'POST', route: '/api/plugin-actions', action: 'invoke plugin action', mode: 'plugin-action', resolver: 'pluginActions.invoke', risk: 'elevated' },
  { method: 'POST', route: '/api/plugin-actions/servers/:id', action: 'invoke plugin server action', mode: 'plugin-action', resolver: 'pluginActions.invoke', risk: 'elevated' },

  { method: 'POST', route: '/api/server-access/servers/:serverId/users', action: 'add server access user', mode: 'static', permission: 'server_access.users.add', risk: 'elevated', resourceResolver: 'server' },
  { method: 'PATCH', route: '/api/server-access/servers/:serverId/users/:userId', action: 'update server access user', mode: 'static', permission: 'server_access.users.assign_permissions', risk: 'elevated', resourceResolver: 'server' },
  { method: 'DELETE', route: '/api/server-access/servers/:serverId/users/:userId', action: 'remove server access user', mode: 'static', permission: 'server_access.users.remove', risk: 'elevated', resourceResolver: 'server' },
  { method: 'POST', route: '/api/server-access/servers/:serverId/groups', action: 'create server access group', mode: 'static', permission: 'server_access.groups.create', risk: 'elevated', resourceResolver: 'server' },
  { method: 'PATCH', route: '/api/server-access/servers/:serverId/groups/:groupId', action: 'update server access group', mode: 'field-mapped', resolver: 'serverAccess.patchGroup', risk: 'elevated', resourceResolver: 'server' },
  { method: 'DELETE', route: '/api/server-access/servers/:serverId/groups/:groupId', action: 'delete server access group', mode: 'static', permission: 'server_access.groups.delete', risk: 'destructive', resourceResolver: 'server' },
  { method: 'PATCH', route: '/api/server-access/servers/:serverId/mode', action: 'change server access mode', mode: 'static', permission: 'server_access.mode.change', risk: 'elevated', resourceResolver: 'server' },

  { method: 'WS', route: 'join-server', action: 'subscribe to console', mode: 'static', permission: 'servers.console.view', risk: 'normal', resourceResolver: 'server' },
  { method: 'WS', route: 'send-command', action: 'send console command', mode: 'static', permission: 'servers.console.send_commands', risk: 'elevated', resourceResolver: 'server' },
  { method: 'WS', route: 'start-server', action: 'start server', mode: 'kind-specific', resolver: 'startPermissionForKind', risk: 'normal', resourceResolver: 'server' },
  { method: 'WS', route: 'stop-server', action: 'stop server', mode: 'kind-specific', resolver: 'stopPermissionForKind', risk: 'normal', resourceResolver: 'server' },
];

for (const item of ACTION_MATRIX) {
  const route = String(item.route || '');
  const serverRoute = /^\/api\/servers\/:id(?:\/|$)/.test(route)
    || /:serverId/.test(route)
    || /\/plugin-actions\/servers\/:id/.test(route)
    || /\/mods\/:modId\/(?:install|uninstall)\/:serverId/.test(route)
    || item.method === 'WS';
  if (!serverRoute || item.resourceResolver) continue;
  item.resourceResolver = 'server';
  if (item.assignableAtServerScope == null) item.assignableAtServerScope = true;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ROUTE_FILE_PREFIXES = {
  'auth.js': '/api/auth',
  'userManagement.js': '/api/user-management',
  'servers.js': '/api/servers',
  'mods.js': '/api/mods',
  'players.js': '/api/players',
  'plugins.js': '/api/plugins',
  'java.js': '/api/java',
  'gateways.js': '/api/gateways',
  'bedrockConnect.js': '/api/bedrock-connect',
  'pluginActions.js': '/api/plugin-actions',
  'dashboard.js': '/api/dashboard',
  'serverAccess.js': '/api/server-access',
  'ports.js': '/api/ports',
  'api.js': '/api/v1',
};

function mutatingEntries() {
  return ACTION_MATRIX.filter((item) => MUTATING_METHODS.has(item.method) || item.method === 'WS');
}

function declaredPermissions(entry) {
  if (Array.isArray(entry.permissions) && entry.permissions.length) return entry.permissions;
  if (entry.permission && entry.permission !== 'field-mapped' && !String(entry.permission).includes(' ')) {
    return [entry.permission];
  }
  return [];
}

module.exports = {
  ACTION_MATRIX,
  MUTATING_METHODS,
  ROUTE_FILE_PREFIXES,
  mutatingEntries,
  declaredPermissions,
};
