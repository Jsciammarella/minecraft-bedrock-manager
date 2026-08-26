const ACTION_MATRIX = [
  { method: 'GET', route: '/api/servers', action: 'list servers', permission: 'servers.view', plugin: 'core', risk: 'read' },
  { method: 'POST', route: '/api/servers', action: 'create server', permission: 'kind-specific create', composite: ['servers.create_bedrock', 'servers.create_remote', 'servers.create_java', 'bedrock_connect.create'], plugin: 'core', risk: 'elevated' },
  { method: 'PUT', route: '/api/servers/:id', action: 'update server properties', permission: 'field-mapped', plugin: 'core', risk: 'elevated' },
  { method: 'DELETE', route: '/api/servers/:id', action: 'delete server', permission: 'servers.delete', plugin: 'core', risk: 'destructive' },
  { method: 'POST', route: '/api/servers/:id/start', action: 'start server', permission: 'kind-specific start', plugin: 'core', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/stop', action: 'stop server', permission: 'kind-specific stop', plugin: 'core', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/restart', action: 'restart server', permission: 'servers.restart', plugin: 'core', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/restart-with-warning', action: 'restart with warning', permission: 'servers.restart_with_warning', plugin: 'core', risk: 'normal' },
  { method: 'DELETE', route: '/api/servers/:id/restart-with-warning', action: 'cancel scheduled restart', permission: 'servers.cancel_scheduled_restart', plugin: 'core', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/command', action: 'send console command', permission: 'servers.console.send_commands', plugin: 'core', risk: 'elevated' },
  { method: 'POST', route: '/api/servers/:id/update', action: 'update software', permission: 'servers.update_software', plugin: 'core', risk: 'elevated' },
  { method: 'POST', route: '/api/servers/:id/auto-update', action: 'enable auto-update', permission: 'servers.configure_auto_update', plugin: 'core', risk: 'elevated' },
  { method: 'DELETE', route: '/api/servers/:id/auto-update', action: 'disable auto-update', permission: 'servers.configure_auto_update', plugin: 'core', risk: 'elevated' },
  { method: 'PUT', route: '/api/servers/:id/lan-broadcast', action: 'manage LAN broadcast', permission: 'servers.manage_lan_broadcast', plugin: 'core', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/java/mods', action: 'install java mods', permission: 'servers.mods.install', plugin: 'core', risk: 'normal' },
  { method: 'DELETE', route: '/api/servers/:id/java/mods/:installationId', action: 'remove java mods', permission: 'servers.mods.remove', plugin: 'core', risk: 'normal' },
  { method: 'POST', route: '/api/servers/:id/java/dependencies/resolve', action: 'resolve java dependencies', permission: 'servers.mods.resolve_dependencies', composite: ['servers.mods.install'], plugin: 'core', risk: 'normal' },
  { method: 'POST', route: '/api/mods/upload', action: 'upload library file', permission: 'library.upload', plugin: 'core', risk: 'normal' },
  { method: 'PUT', route: '/api/mods/:id', action: 'edit library metadata', permission: 'library.edit_metadata', plugin: 'core', risk: 'normal' },
  { method: 'DELETE', route: '/api/mods/:id', action: 'delete library entry', permission: 'library.delete_entry', plugin: 'core', risk: 'destructive' },
  { method: 'POST', route: '/api/mods/catalog/download/:slug', action: 'download catalog item', permission: 'catalog.download_to_library', plugin: 'core', risk: 'normal' },
  { method: 'PUT', route: '/api/mods/catalog/multi-file-mode', action: 'change file handling', permission: 'catalog.change_file_handling', plugin: 'core', risk: 'elevated' },
  { method: 'POST', route: '/api/plugins/upload', action: 'install plugin', permission: 'plugins.install', plugin: 'core', risk: 'elevated' },
  { method: 'PUT', route: '/api/plugins/:pluginId/enabled', action: 'enable or disable plugin', permission: 'plugins.enable / plugins.disable', plugin: 'core', risk: 'elevated' },
  { method: 'PUT', route: '/api/plugins/:pluginId/backend-enabled', action: 'enable plugin backend', permission: 'plugins.enable_backend', plugin: 'core', risk: 'elevated' },
  { method: 'POST', route: '/api/user-management/users', action: 'create user', permission: 'users.create', plugin: 'core', risk: 'elevated' },
  { method: 'PUT', route: '/api/user-management/users/:id', action: 'update user', permission: 'field-mapped user permissions', plugin: 'core', risk: 'elevated' },
  { method: 'DELETE', route: '/api/user-management/users/:id', action: 'delete user', permission: 'users.delete', plugin: 'core', risk: 'destructive' },
  { method: 'POST', route: '/api/user-management/groups', action: 'create group', permission: 'groups.create', plugin: 'core', risk: 'elevated' },
  { method: 'PUT', route: '/api/user-management/groups/:id', action: 'update group', permission: 'field-mapped group permissions', plugin: 'core', risk: 'elevated' },
  { method: 'DELETE', route: '/api/user-management/groups/:id', action: 'delete group', permission: 'groups.delete', plugin: 'core', risk: 'destructive' },
  { method: 'POST', route: '/api/user-management/groups/:id/reset-defaults', action: 'reset system group defaults', permission: 'groups.reset_system_defaults', plugin: 'core', risk: 'administrator-only' },
  { method: 'PUT', route: '/api/user-management/settings', action: 'save security settings', permission: 'security.configure_session_timeout / security.configure_password_policy', plugin: 'core', risk: 'administrator-only' },
  { method: 'PUT', route: '/api/bedrock-connect/dns', action: 'update DNS settings', permission: 'field-mapped bedrock_connect.dns.*', plugin: 'server-edition-bedrock-connect', risk: 'elevated' },
  { method: 'WS', route: 'join-server', action: 'subscribe to console', permission: 'servers.console.view', plugin: 'core', risk: 'normal' },
  { method: 'WS', route: 'send-command', action: 'send console command', permission: 'servers.console.send_commands', plugin: 'core', risk: 'elevated' },
  { method: 'WS', route: 'start-server', action: 'start server', permission: 'kind-specific start', plugin: 'core', risk: 'normal' },
  { method: 'WS', route: 'stop-server', action: 'stop server', permission: 'kind-specific stop', plugin: 'core', risk: 'normal' },
];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function mutatingEntries() {
  return ACTION_MATRIX.filter((item) => MUTATING_METHODS.has(item.method) || item.method === 'WS');
}

module.exports = {
  ACTION_MATRIX,
  MUTATING_METHODS,
  mutatingEntries,
};
