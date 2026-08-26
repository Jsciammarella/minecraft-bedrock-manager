export const FIELD_PERMISSIONS = {
  name: 'servers.edit_display_name',
  server_description: 'servers.edit_description',
  server_motd: 'servers.properties.server_name',
  level_seed: 'servers.properties.level_seed',
  max_players: 'servers.properties.max_players',
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
  ipv6_port: 'servers.properties.ipv6_port',
  ipv6Port: 'servers.properties.ipv6_port',
  remote_discovery: 'servers.properties.lan_visibility',
  view_distance: 'servers.properties.view_distance',
  tick_distance: 'servers.properties.tick_distance',
  texture_pack_required: 'servers.properties.texture_pack_required',
  server_authoritative: 'servers.properties.movement_authority',
  server_authoritative_inventory: 'servers.properties.server_authoritative_inventory',
};

export const REMOTE_FIELD_PERMISSIONS = {
  port: 'servers.remote.change_local_port',
  ipv6_port: 'servers.remote.change_local_port',
  ipv6Port: 'servers.remote.change_local_port',
  remote_host: 'servers.remote.change_target_host',
  remoteHost: 'servers.remote.change_target_host',
  remote_ipv4_port: 'servers.remote.change_target_port',
  remoteIpv4Port: 'servers.remote.change_target_port',
  remote_ipv6_port: 'servers.remote.change_target_port',
  remoteIpv6Port: 'servers.remote.change_target_port',
};

export const JAVA_FIELD_PERMISSIONS = {
  pvp: 'servers.java.pvp',
  allow_nether: 'servers.java.allow_nether',
  allow_flight: 'servers.java.allow_flight',
  enable_command_block: 'servers.java.enable_command_block',
  hardcore: 'servers.java.hardcore',
  spawn_animals: 'servers.java.spawn_animals',
  spawn_npcs: 'servers.java.spawn_npcs',
  spawn_monsters: 'servers.java.spawn_monsters',
  generate_structures: 'servers.java.generate_structures',
  hide_online_players: 'servers.java.hide_online_players',
  enforce_whitelist: 'servers.java.enforce_whitelist',
  require_resource_pack: 'servers.java.require_resource_pack',
  broadcast_console_to_ops: 'servers.java.broadcast_console_to_ops',
  enable_status: 'servers.java.enable_status',
  enable_query: 'servers.java.enable_query',
  enable_rcon: 'servers.java.enable_rcon',
  sync_chunk_writes: 'servers.java.sync_chunk_writes',
  prevent_proxy_connections: 'servers.java.prevent_proxy_connections',
  enforce_secure_profile: 'servers.java.enforce_secure_profile',
  network_compression_threshold: 'servers.java.network_compression_threshold',
  entity_broadcast_range_percentage: 'servers.java.entity_broadcast_range_percentage',
  query_port: 'servers.java.query_port',
  rcon_port: 'servers.java.rcon_port',
  rcon_password: 'servers.java.rcon_password',
  resource_pack: 'servers.java.resource_pack',
  resource_pack_sha1: 'servers.java.resource_pack_sha1',
  level_type: 'servers.java.level_type',
  max_world_size: 'servers.java.max_world_size',
  simulation_distance: 'servers.java.simulation_distance',
  spawn_protection: 'servers.java.spawn_protection',
  op_permission_level: 'servers.java.op_permission_level',
  function_permission_level: 'servers.java.function_permission_level',
};

export function fieldPermission(name, kind) {
  if (kind === 'remote') return REMOTE_FIELD_PERMISSIONS[name] || null;
  if (JAVA_FIELD_PERMISSIONS[name]) return JAVA_FIELD_PERMISSIONS[name];
  return FIELD_PERMISSIONS[name] || null;
}

export function permissionLockTitle(permission, canFn) {
  if (!permission || canFn(permission)) return '';
  return `Requires permission ${permission}`;
}
