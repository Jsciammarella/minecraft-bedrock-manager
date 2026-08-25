export const BEDROCK_ONLY_FIELDS = [
  'ipv6_port',
  'tick_distance',
  'tx_rate',
  'enable_cheats',
  'server_authoritative',
  'texture_pack_required',
  'auto_ice',
  'natural_regeneration',
  'remote_discovery',
  'allow_third_party_requests',
  'allow_third_party_pictures',
  'require_secure_chat',
  'server_authoritative_inventory',
  'enable_player_data_initialization',
  'default_player_permission',
  'default_1st_person',
];

export const JAVA_ONLY_FIELDS = [
  'pvp',
  'spawn_protection',
  'simulation_distance',
  'allow_nether',
  'allow_flight',
  'enable_command_block',
  'hardcore',
  'force_gamemode',
  'spawn_animals',
  'spawn_npcs',
  'spawn_monsters',
  'generate_structures',
  'hide_online_players',
  'enforce_whitelist',
  'network_compression_threshold',
  'resource_pack',
  'resource_pack_sha1',
  'require_resource_pack',
  'function_permission_level',
  'op_permission_level',
  'broadcast_console_to_ops',
  'enable_rcon',
  'rcon_port',
  'rcon_password',
  'enable_query',
  'query_port',
  'sync_chunk_writes',
  'prevent_proxy_connections',
  'entity_broadcast_range_percentage',
  'enforce_secure_profile',
  'level_type',
  'max_world_size',
  'enable_status',
];

const BEDROCK_SET = new Set(BEDROCK_ONLY_FIELDS);
const JAVA_SET = new Set(JAVA_ONLY_FIELDS);

export function fieldEdition(name) {
  if (JAVA_SET.has(name)) return 'java';
  if (BEDROCK_SET.has(name)) return 'bedrock';
  return 'shared';
}

export function isJavaServer(server) {
  return server?.kind === 'java';
}

export function isBedrockEdition(server) {
  return !isJavaServer(server);
}

export function isFieldDisabled(name, server, extraLocked = false) {
  if (extraLocked) return true;
  const edition = fieldEdition(name);
  if (edition === 'java' && !isJavaServer(server)) return true;
  if (edition === 'bedrock' && isJavaServer(server)) return true;
  return false;
}

export function matchesEditionFilter(name, filter) {
  if (!filter || filter === 'all') return true;
  return fieldEdition(name) === filter;
}
