const connectHost = require('./connectHost');

const RUNTIME_STATUS_FIELDS = [
  'status',
  'uptime',
  'started_at',
  'pending_restart',
  'pending_restart_reason',
  'pending_restart_at',
  'restart_scheduled_at',
  'remoteReachable',
  'health',
  'loaderState',
  'loader_state',
];

const CONNECTION_FIELDS = [
  'port',
  'ipv6_port',
  'pending_port',
  'pending_ipv6_port',
  'lan_broadcast',
  'lan_proxy_port',
  'lan',
  'connectHost',
  'lanIp',
  'managerHostname',
  'connectAddress',
  'geyserGateways',
];

const REMOTE_TARGET_FIELDS = [
  'remote_host',
  'remote_ipv4_port',
  'remote_ipv6_port',
];

const PROPERTY_FIELDS = [
  'max_players',
  'whitelist_mode',
  'difficulty',
  'gamemode',
  'default_1st_person',
  'server_authoritative',
  'enable_cheats',
  'texture_pack_required',
  'server_description',
  'server_motd',
  'level_seed',
  'version',
  'minecraft_version',
  'minecraftVersion',
  'java_major',
  'javaMajor',
  'loader_version',
  'loaderVersion',
  'view_distance',
  'tick_distance',
  'player_idle_timeout',
  'online_mode',
  'force_gamemode',
  'default_player_permission',
  'allow_third_party_pictures',
  'allow_third_party_requests',
  'require_secure_chat',
  'enable_player_data_initialization',
  'auto_ice',
  'natural_regeneration',
  'tx_rate',
  'remote_discovery',
  'server_authoritative_inventory',
];

const ALWAYS_OMIT = [
  'pid',
  'pm2_id',
  'data_path',
  'loader_metadata',
  'missing_mod_dependencies',
  'missingModDependencies',
];

const CONNECTION_CONTRIBUTION_KEYS = new Set([
  'connectAddress',
  'connectHost',
  'lanIp',
  'port',
  'ipv6Port',
  'ipv6_port',
  'targetSummary',
  'targetHost',
  'targetPort',
  'endpoint',
  'address',
  'hostname',
]);

const RUNTIME_CONTRIBUTION_KEYS = new Set([
  'status',
  'health',
  'uptime',
  'onlinePlayers',
  'playerCount',
  'restartRequired',
  'pendingRestart',
  'loaderState',
]);

const REMOTE_CONTRIBUTION_KEYS = new Set([
  'remoteHost',
  'remote_host',
  'targetHost',
  'targetIpv4Port',
  'targetIpv6Port',
  'remoteIpv4Port',
  'remoteIpv6Port',
]);

function can(principal, permission, resource) {
  if (!permission) return true;
  try {
    return require('../security').authorize(principal, permission, resource);
  } catch {
    return false;
  }
}

function capabilitiesFor(principal, server) {
  const catalog = require('./permissionCatalog');
  const scoped = Boolean(require('./resourceAuthorizationRegistry').get('server'));
  let userManagement = false;
  try {
    userManagement = require('../security').supports('userManagement');
  } catch {
    userManagement = false;
  }
  const startKey = catalog.startPermissionForKind(server?.kind);
  const stopKey = catalog.stopPermissionForKind(server?.kind);
  return {
    authorizationScoped: scoped,
    view: can(principal, 'servers.view', server),
    details: can(principal, 'servers.view_details', server),
    start: Boolean(startKey) && can(principal, startKey, server),
    stop: Boolean(stopKey) && can(principal, stopKey, server),
    restart: can(principal, catalog.restartPermissionForKind(server?.kind), server),
    consoleView: can(principal, 'servers.console.view', server),
    consoleSend: can(principal, 'servers.console.send_commands', server),
    propertiesView: can(principal, 'servers.view_properties', server),
    propertiesEdit: can(principal, 'servers.view_properties', server),
    modsView: can(principal, 'servers.mods.view', server),
    modsInstall: can(principal, 'servers.mods.install', server),
    modsRemove: can(principal, 'servers.mods.remove', server),
    lan: can(principal, 'servers.manage_lan_broadcast', server),
    update: can(principal, 'servers.update_software', server),
    delete: can(principal, catalog.deletePermissionForKind(server?.kind), server),
    runtime: can(principal, 'servers.view_runtime_status', server),
    connection: can(principal, 'servers.view_connection_details', server),
    remoteTarget: can(principal, 'servers.remote.view_target', server),
    membership: can(principal, 'players.view_server_membership', server),
    allowView: can(principal, 'servers.allowlist.view', server),
    allowAdd: can(principal, 'servers.allowlist.add', server),
    allowRemove: can(principal, 'servers.allowlist.remove', server),
    banView: can(principal, 'servers.banlist.view', server),
    banAdd: can(principal, 'servers.banlist.add', server),
    banRemove: can(principal, 'servers.banlist.remove', server),
    playerRoles: can(principal, 'servers.player_permissions.view', server),
    playerPermsEdit: can(principal, 'servers.player_permissions.set_visitor', server)
      || can(principal, 'servers.player_permissions.set_member', server)
      || can(principal, 'servers.player_permissions.set_operator', server)
      || can(principal, 'servers.player_permissions.reset', server),
    serverAccess: scoped && userManagement && can(principal, 'server_access.view', server),
  };
}

function editionOf(server) {
  if (server?.edition) return server.edition;
  if (server?.kind === 'java') return 'java';
  if (server?.kind === 'bedrock_connect') return 'bedrock-connect';
  if (server?.kind === 'remote') return 'remote';
  return 'bedrock';
}

function omitKeys(obj, keys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const next = { ...obj };
  for (const key of keys) delete next[key];
  return next;
}

function runtimePermission(context) {
  return context === 'dashboard' ? 'dashboard.view_runtime_status' : 'servers.view_runtime_status';
}

function connectionPermission(context) {
  return context === 'dashboard' ? 'dashboard.view_connection_details' : 'servers.view_connection_details';
}

function redactValue(value, principal, context, resource) {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, principal, context, resource));
  }
  if (!value || typeof value !== 'object') return value;
  const required = value.requiresPermission || value.permission;
  if (required && !can(principal, required, resource)) return undefined;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'requiresPermission' || key === 'permission') {
      out[key] = nested;
      continue;
    }
    if (CONNECTION_CONTRIBUTION_KEYS.has(key) && !can(principal, connectionPermission(context), resource)) continue;
    if (RUNTIME_CONTRIBUTION_KEYS.has(key) && !can(principal, runtimePermission(context), resource)) continue;
    if (REMOTE_CONTRIBUTION_KEYS.has(key) && !can(principal, 'servers.remote.view_target', resource)) continue;
    const redacted = redactValue(nested, principal, context, resource);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}

function redactContributions(contributions, principal, context, resource) {
  if (!Array.isArray(contributions)) return [];
  return contributions
    .map((item) => redactValue(item, principal, context, resource))
    .filter((item) => item && typeof item === 'object');
}

function publicTags(server) {
  const tags = [];
  if (server?.kind) tags.push({ id: `kind:${server.kind}`, label: String(server.kind) });
  if (server?.provider_id) tags.push({ id: `provider:${server.provider_id}`, label: String(server.provider_id) });
  const fromPlugin = Array.isArray(server?.pluginContributions)
    ? server.pluginContributions.flatMap((item) => item?.tags || [])
    : [];
  for (const tag of fromPlugin) {
    if (tag && tag.id && !/address|port|host|status|health/i.test(String(tag.id))) tags.push(tag);
  }
  return tags;
}

function serializeGatewayForPrincipal(entity, principal, { context = 'dashboard' } = {}) {
  if (!entity) return entity;
  const showRuntime = can(principal, runtimePermission(context));
  const showConnection = can(principal, connectionPermission(context));
  const out = {
    id: entity.id,
    kind: entity.kind || 'geyser_gateway',
    name: entity.name,
    typeLabel: entity.typeLabel,
    gatewayProvider: entity.gatewayProvider,
    pluginId: entity.pluginId,
    pluginDisabled: entity.pluginDisabled,
    managedByPlugin: entity.managedByPlugin,
    readOnly: entity.readOnly,
    managementUrl: entity.managementUrl,
    projected: entity.projected,
    unresolvedTarget: entity.unresolvedTarget,
    controlPolicy: entity.controlPolicy,
    coreActionsDisabled: entity.coreActionsDisabled,
    disabledReasonId: entity.disabledReasonId,
    compatibilityMode: entity.compatibilityMode,
    authentication: entity.authentication,
    geyserVersion: entity.geyserVersion,
    viaproxyVersion: entity.viaproxyVersion,
  };
  if (showRuntime) {
    out.status = entity.status;
    out.health = entity.health;
    out.lastError = entity.lastError;
  }
  if (showConnection) {
    out.connectAddress = entity.connectAddress;
    out.port = entity.port;
  }
  if (can(principal, 'servers.remote.view_target')) {
    out.targetSummary = entity.targetSummary;
  }
  if (entity.pluginContributions) {
    out.pluginContributions = redactContributions(entity.pluginContributions, principal, context);
  }
  return out;
}

function serializeServerForPrincipal(server, principal, options = {}) {
  const context = options.context || 'list';
  if (!server) return server;
  const stats = options.stats || server.stats || null;
  const contributions = options.pluginContributions || server.pluginContributions || [];
  const showRuntime = can(principal, runtimePermission(context), server);
  const showConnection = can(principal, connectionPermission(context), server);
  const showProperties = context === 'dashboard' ? false : can(principal, 'servers.view_properties', server);
  const showRemote = can(principal, 'servers.remote.view_target', server);
  const showMods = can(principal, 'servers.mods.view', server);
  const showPlayerNames = can(principal, 'players.view_server_membership', server);

  const out = {
    id: server.id,
    name: server.name,
    kind: server.kind || 'bedrock',
    edition: editionOf(server),
    provider_id: server.provider_id || null,
    capability_id: server.capability_id || null,
    loaderProviderId: server.loaderProviderId || server.loader_provider_id || null,
    created_at: server.created_at,
    updated_at: server.updated_at,
    tags: publicTags({ ...server, pluginContributions: contributions }),
  };

  if (showRuntime) {
    out.status = server.status;
    out.pending_restart = server.pending_restart;
    out.pending_restart_reason = server.pending_restart_reason;
    out.pending_restart_at = server.pending_restart_at;
    out.restart_scheduled_at = server.restart_scheduled_at;
    out.remoteReachable = stats?.remoteReachable ?? server.remoteReachable ?? null;
    out.loaderState = server.loaderState || server.loader_state || null;
    const playerCount = stats && typeof stats.onlinePlayers === 'number'
      ? stats.onlinePlayers
      : Array.isArray(options.onlinePlayers)
        ? options.onlinePlayers.length
        : undefined;
    out.stats = {
      uptime: stats?.uptime || '0m',
      health: stats?.health || server.health || server.status,
    };
    if (typeof playerCount === 'number') out.stats.onlinePlayers = playerCount;
  }

  if (showConnection) {
    out.port = server.port;
    out.ipv6_port = server.ipv6_port;
    out.pending_port = server.pending_port;
    out.pending_ipv6_port = server.pending_ipv6_port;
    out.lan_broadcast = server.lan_broadcast;
    out.lan_proxy_port = server.lan_proxy_port;
    out.lan = stats?.lan || server.lan || null;
    const attached = options.skipAttach
      ? server
      : connectHost.attach({ ...server, port: server.port }, options.req);
    out.connectHost = attached.connectHost;
    out.lanIp = attached.lanIp;
    out.managerHostname = attached.managerHostname;
    out.connectAddress = attached.connectAddress;
    if (server.geyserGateways) out.geyserGateways = server.geyserGateways;
  }

  if (showRemote) {
    out.remote_host = server.remote_host;
    out.remote_ipv4_port = server.remote_ipv4_port;
    out.remote_ipv6_port = server.remote_ipv6_port;
  }

  if (showProperties) {
    for (const field of PROPERTY_FIELDS) {
      if (server[field] !== undefined) out[field] = server[field];
    }
    if (server.optionalIntegrations) out.optionalIntegrations = server.optionalIntegrations;
  }

  if (showMods) {
    if (Array.isArray(options.installedMods)) out.installedMods = options.installedMods;
    if (Array.isArray(server.installedModIds) || Array.isArray(options.installedModIds)) {
      out.installedModIds = options.installedModIds || server.installedModIds;
    }
    if (out.stats) out.stats.installedMods = stats?.installedMods ?? (Array.isArray(out.installedMods) ? out.installedMods.length : 0);
    else if (stats?.installedMods != null) {
      out.stats = { ...(out.stats || {}), installedMods: stats.installedMods };
    }
    if (server.missingModDependencies || options.missingModDependencies) {
      out.missingModDependencies = server.missingModDependencies || options.missingModDependencies;
    }
  }

  if (showPlayerNames && Array.isArray(options.onlinePlayers)) {
    out.onlinePlayers = options.onlinePlayers;
  }

  out.pluginContributions = redactContributions(contributions, principal, context, server);
  out.authorizationScoped = Boolean(require('./resourceAuthorizationRegistry').get('server'));
  out.capabilities = capabilitiesFor(principal, server);
  return omitKeys(out, ALWAYS_OMIT);
}

function serializeServersForPrincipal(servers, principal, options = {}) {
  return (servers || []).map((server) => serializeServerForPrincipal(server, principal, options));
}

module.exports = {
  serializeServerForPrincipal,
  serializeServersForPrincipal,
  serializeGatewayForPrincipal,
  redactContributions,
  can,
  capabilitiesFor,
  runtimePermission,
  connectionPermission,
  RUNTIME_STATUS_FIELDS,
  CONNECTION_FIELDS,
  REMOTE_TARGET_FIELDS,
  PROPERTY_FIELDS,
};
