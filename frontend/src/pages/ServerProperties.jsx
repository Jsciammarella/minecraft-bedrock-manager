import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { serverApi, portApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { ArrowLeft, Save, Loader2, Check, AlertCircle, RefreshCw } from 'lucide-react';
import { isFieldDisabled, isJavaServer } from '../utils/editionSettings';
import { fieldPermission, permissionLockTitle } from '../utils/fieldPermissions';

function ServerProperties() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [server, setServer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  // Auto-update state
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(false);
  const [autoUpdateInterval, setAutoUpdateInterval] = useState(24);
  const [autoUpdating, setAutoUpdating] = useState(false);

  const [ports, setPorts] = useState({ used: [], available: [] });

  const [formData, setFormData] = useState({
    port: '',
    ipv6_port: '',
    max_players: '10',
    difficulty: 'peaceful',
    gamemode: 'survival',
    whitelist_mode: 0,
    server_description: '',
    server_motd: '',
    texture_pack_required: 0,
    enable_cheats: 1,
    server_authoritative: 1,
    default_1st_person: 1,
    view_distance: '32',
    tick_distance: '4',
    player_idle_timeout: '30',
    allow_third_party_requests: 0,
    allow_third_party_pictures: 0,
    online_mode: 1,
    require_secure_chat: 0,
    server_authoritative_inventory: 1,
    enable_player_data_initialization: 1,
    level_seed: '',
    default_player_permission: 'member',
    auto_ice: 1,
    natural_regeneration: 1,
    remote_discovery: 0,
    tx_rate: '30',
    remote_host: '',
    remote_ipv4_port: '19132',
    remote_ipv6_port: '19133',
    pvp: 1,
    spawn_protection: '16',
    simulation_distance: '10',
    allow_nether: 1,
    allow_flight: 0,
    enable_command_block: 0,
    hardcore: 0,
    force_gamemode: 0,
    spawn_animals: 1,
    spawn_npcs: 1,
    spawn_monsters: 1,
    generate_structures: 1,
    hide_online_players: 0,
    enforce_whitelist: 0,
    network_compression_threshold: '256',
    resource_pack: '',
    resource_pack_sha1: '',
    require_resource_pack: 0,
    function_permission_level: '2',
    op_permission_level: '4',
    broadcast_console_to_ops: 1,
    enable_rcon: 0,
    rcon_port: '25575',
    rcon_password: '',
    enable_query: 0,
    query_port: '',
    sync_chunk_writes: 1,
    prevent_proxy_connections: 0,
    entity_broadcast_range_percentage: '100',
    enforce_secure_profile: 1,
    level_type: 'minecraft:normal',
    max_world_size: '29999984',
    enable_status: 1,
  });
  const [permissionFilter, setPermissionFilter] = useState('all');

  useEffect(() => {
    loadServer();
    loadAutoUpdateConfig();
    loadPorts();
  }, [id]);

  const loadServer = async () => {
    try {
      const res = await serverApi.getById(id);
      setServer(res.data);
      // Populate form with current values
      setFormData(prev => ({
        ...prev,
        port: String(res.data.port || ''),
        ipv6_port: String(res.data.ipv6_port || ''),
        remote_host: res.data.remote_host || '',
        remote_ipv4_port: String(res.data.remote_ipv4_port || '19132'),
        remote_ipv6_port: String(res.data.remote_ipv6_port || '19133'),
        max_players: String(res.data.max_players || 10),
        difficulty: res.data.difficulty || 'peaceful',
        gamemode: res.data.gamemode || 'survival',
        whitelist_mode: res.data.whitelist_mode || 0,
        server_description: res.data.server_description || '',
        server_motd: res.data.server_motd || '',
        texture_pack_required: res.data.texture_pack_required || 0,
        enable_cheats: res.data.enable_cheats ?? 1,
        server_authoritative: res.data.server_authoritative ?? 1,
        default_1st_person: res.data.default_1st_person ?? 1,
        pvp: res.data.pvp ?? 1,
        spawn_protection: String(res.data.spawn_protection ?? '16'),
        simulation_distance: String(res.data.simulation_distance ?? '10'),
        allow_nether: res.data.allow_nether ?? 1,
        allow_flight: res.data.allow_flight ?? 0,
        enable_command_block: res.data.enable_command_block ?? 0,
        hardcore: res.data.hardcore ?? 0,
        force_gamemode: res.data.force_gamemode ?? 0,
        spawn_animals: res.data.spawn_animals ?? 1,
        spawn_npcs: res.data.spawn_npcs ?? 1,
        spawn_monsters: res.data.spawn_monsters ?? 1,
        generate_structures: res.data.generate_structures ?? 1,
        hide_online_players: res.data.hide_online_players ?? 0,
        enforce_whitelist: res.data.enforce_whitelist ?? 0,
        network_compression_threshold: String(res.data.network_compression_threshold ?? '256'),
        resource_pack: res.data.resource_pack || '',
        resource_pack_sha1: res.data.resource_pack_sha1 || '',
        require_resource_pack: res.data.require_resource_pack ?? 0,
        function_permission_level: String(res.data.function_permission_level ?? '2'),
        op_permission_level: String(res.data.op_permission_level ?? '4'),
        broadcast_console_to_ops: res.data.broadcast_console_to_ops ?? 1,
        enable_rcon: res.data.enable_rcon ?? 0,
        rcon_port: String(res.data.rcon_port ?? '25575'),
        rcon_password: res.data.rcon_password || '',
        enable_query: res.data.enable_query ?? 0,
        query_port: String(res.data.query_port || res.data.port || ''),
        sync_chunk_writes: res.data.sync_chunk_writes ?? 1,
        prevent_proxy_connections: res.data.prevent_proxy_connections ?? 0,
        entity_broadcast_range_percentage: String(res.data.entity_broadcast_range_percentage ?? '100'),
        enforce_secure_profile: res.data.enforce_secure_profile ?? 1,
        level_type: res.data.level_type || 'minecraft:normal',
        max_world_size: String(res.data.max_world_size ?? '29999984'),
        enable_status: res.data.enable_status ?? 1,
        view_distance: String(res.data.view_distance ?? (res.data.kind === 'java' ? '10' : '32')),
        player_idle_timeout: String(res.data.player_idle_timeout ?? (res.data.kind === 'java' ? '0' : '30')),
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadPorts = async () => {
    try {
      const res = await portApi.getAll();
      setPorts(res.data);
    } catch (err) {
      console.error('Failed to load ports:', err);
    }
  };

  const loadAutoUpdateConfig = async () => {
    try {
      const res = await serverApi.getAutoUpdate(id);
      if (res.data) {
        setAutoUpdateEnabled(!!res.data.enabled);
        setAutoUpdateInterval(res.data.check_interval_hours || 24);
      }
    } catch (err) {
      console.error('Failed to load auto-update config:', err);
    }
  };

  const handleAutoUpdateToggle = async () => {
    setAutoUpdating(true);
    setError('');
    setSuccess('');
    try {
      if (autoUpdateEnabled) {
        await serverApi.disableAutoUpdate(id);
        setAutoUpdateEnabled(false);
        setSuccess('Auto-update disabled');
      } else {
        await serverApi.enableAutoUpdate(id, autoUpdateInterval);
        setAutoUpdateEnabled(true);
        setSuccess('Auto-update enabled');
      }
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to update auto-update settings');
    } finally {
      setAutoUpdating(false);
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (checked ? 1 : 0) : value
    }));
  };

  const handleToggle = (name) => {
    setFormData(prev => ({
      ...prev,
      [name]: prev[name] === 1 ? 0 : 1
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      if (server?.kind === 'bedrock_connect') {
        if (autoUpdateEnabled) {
          await serverApi.enableAutoUpdate(id, autoUpdateInterval);
        }
        navigate(`/servers/${id}`, {
          replace: true,
          state: { message: 'Auto-update settings saved successfully.' },
        });
        return;
      }
      if (server?.kind === 'remote') {
        await serverApi.update(id, {
          port: formData.port === '' ? undefined : parseInt(formData.port, 10),
          ipv6Port: formData.ipv6_port === '' ? undefined : parseInt(formData.ipv6_port, 10),
          remoteHost: formData.remote_host,
          remoteIpv4Port: parseInt(formData.remote_ipv4_port, 10),
          remoteIpv6Port: formData.remote_ipv6_port === '' ? undefined : parseInt(formData.remote_ipv6_port, 10),
        });
        navigate(`/servers/${id}`, {
          replace: true,
          state: { message: 'Remote server addresses saved successfully.' },
        });
        return;
      }
      const payload = {
        ...formData,
        port: formData.port === '' ? undefined : parseInt(formData.port, 10),
      };
      delete payload.ipv6_port;
      if (
        server?.kind !== 'java'
        && formData.ipv6_port !== ''
        && Number(formData.ipv6_port) !== Number(server.ipv6_port)
      ) {
        payload.ipv6Port = parseInt(formData.ipv6_port, 10);
      }
      await serverApi.update(id, payload);
      navigate(`/servers/${id}`, {
        replace: true,
        state: { message: 'Server properties saved successfully.' },
      });
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-mc-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-mc-textMuted">Loading...</p>
        </div>
      </div>
    );
  }

  const isBC = server?.kind === 'bedrock_connect';
  const isRemote = server?.kind === 'remote';
  const isJava = isJavaServer(server);
  const settingsLocked = isBC || isRemote;
  const lockUpdate = !can('servers.configure_auto_update');
  const fieldPerm = (name) => fieldPermission(name, server?.kind);
  const fieldLocked = (name) => {
    const permission = fieldPerm(name);
    return Boolean(permission) && !can(permission);
  };
  const fieldTitle = (name) => permissionLockTitle(fieldPerm(name), can);

  const fieldOff = (name, permissionLocked = false) => settingsLocked || permissionLocked || fieldLocked(name) || isFieldDisabled(name, server);
  const showPerm = (edition) => permissionFilter === 'all' || permissionFilter === edition;

  const ipv4Available = (ports.available || []).filter((item) => item.family !== 'ipv6');
  const ipv6Available = (ports.available || []).filter((item) => item.family === 'ipv6');
  const portOptions = [];
  if (server?.port) portOptions.push(Number(server.port));
  if (server?.pending_port && !portOptions.includes(Number(server.pending_port))) {
    portOptions.push(Number(server.pending_port));
  }
  for (const item of ipv4Available) {
    if (!portOptions.includes(item.port)) portOptions.push(item.port);
  }
  const ipv6Options = [];
  if (server?.ipv6_port) ipv6Options.push(Number(server.ipv6_port));
  if (server?.pending_ipv6_port && !ipv6Options.includes(Number(server.pending_ipv6_port))) {
    ipv6Options.push(Number(server.pending_ipv6_port));
  }
  for (const item of ipv6Available) {
    if (!ipv6Options.includes(item.port)) ipv6Options.push(item.port);
  }
  const ipv4Select = isRemote
    ? portOptions.filter((port) => port === Number(server?.port) || (port !== 19132 && port !== 19133))
    : portOptions;
  const ipv6Select = isRemote
    ? ipv6Options.filter((port) => port === Number(server?.ipv6_port) || (port !== 19132 && port !== 19133))
    : ipv6Options;

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">Server Properties</h1>
          <p className="text-mc-textMuted mt-1">
            {isRemote
              ? `${server?.name} — Local ports and remote host`
              : `${server?.name} — Configure all server settings`}
          </p>
        </div>
      </div>

      {isBC && (
        <div className="mb-6 p-4 bg-mc-darker border border-mc-surfaceLight rounded-lg text-sm text-mc-textMuted">
          Bedrock Connect port and gameplay settings cannot be changed. Auto-update works the same as a normal server.
        </div>
      )}
      {isRemote && (
        <div className="mb-6 p-4 bg-mc-darker border border-mc-surfaceLight rounded-lg text-sm text-mc-textMuted">
          Remote servers only allow changing local ports and the remote host and ports. Gameplay settings, mods, and updates are not available from this manager.
        </div>
      )}
      {isJava && (
        <div className="mb-6 p-4 bg-mc-darker border border-mc-surfaceLight rounded-lg text-sm text-mc-textMuted">
          This is a Java Edition server. Bedrock-only settings stay visible but are disabled. Java-only settings are disabled on Bedrock servers.
        </div>
      )}
      {!isJava && !isBC && !isRemote && (
        <div className="mb-6 p-4 bg-mc-darker border border-mc-surfaceLight rounded-lg text-sm text-mc-textMuted">
          Java-only settings stay visible so every server looks the same, but they are disabled on Bedrock.
        </div>
      )}

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {success && (
        <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-3">
          <Check className="w-5 h-5 text-green-400 flex-shrink-0" />
          <p className="text-sm text-green-400">{success}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* General Settings */}
        <Section title={isRemote ? 'Local Ports' : 'General Settings'}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">{isRemote ? 'Local IPv4 Port' : 'IPv4 Port'}</label>
              <select
                name="port"
                value={formData.port}
                onChange={handleChange}
                className="input"
                disabled={fieldOff('port')}
                required
              >
                {ipv4Select.map((port) => (
                  <option key={port} value={port}>{port}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-mc-textMuted">
                {isBC
                  ? 'Bedrock Connect must stay on UDP 19132 so consoles can reach it.'
                  : isRemote
                    ? 'This host listens here and forwards UDP to the remote server. UDP 19132 and 19133 stay free for LAN discovery and Bedrock Connect.'
                    : 'Only the current IPv4 port and other open IPv4 manager ports are shown. A new port applies after restart if the server is running.'}
              </p>
              {server?.pending_port && Number(server.pending_port) !== Number(server.port) && (
                <p className="mt-1 text-xs text-amber-300">
                  IPv4 port {server.pending_port} is queued and will apply on the next restart.
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">{isRemote ? 'Local IPv6 Port' : 'IPv6 Port'}</label>
              <select
                name="ipv6_port"
                value={formData.ipv6_port}
                onChange={handleChange}
                className={`input ${isJava ? 'opacity-50' : ''}`}
                disabled={fieldOff('ipv6_port') || isJava}
                required={!isBC && !isJava}

              >
                {(isBC || isJava) && !formData.ipv6_port && <option value="">n/a</option>}
                {ipv6Select.map((port) => (
                  <option key={port} value={port}>{port}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-mc-textMuted">
                {isBC
                  ? 'Bedrock Connect uses UDP 19133 for IPv6 discovery.'
                  : isJava
                    ? 'Java Edition uses one TCP listen port for IPv4 and IPv6. This Bedrock IPv6 port is unused.'
                  : isRemote
                    ? 'Must be a different number from the local IPv4 port. A new port applies after restart if the gateway is running.'
                    : 'Must be a different number from the IPv4 port. Defaults to 1000 below IPv4 when that port is free. A new port applies after restart if the server is running.'}
              </p>
              {server?.pending_ipv6_port && Number(server.pending_ipv6_port) !== Number(server.ipv6_port) && (
                <p className="mt-1 text-xs text-amber-300">
                  IPv6 port {server.pending_ipv6_port} is queued and will apply on the next restart.
                </p>
              )}
            </div>
            {!isRemote && (
              <>
                <FormField label="Server Description" name="server_description" value={formData.server_description} onChange={handleChange} type="text" disabled={fieldOff('server_description')} title={fieldTitle('server_description')} />
                <FormField label="Server MOTD" name="server_motd" value={formData.server_motd} onChange={handleChange} type="text" disabled={fieldOff('server_motd')} title={fieldTitle('server_motd')} />
                <FormField label="Max Players" name="max_players" value={formData.max_players} onChange={handleChange} type="number" min="1" max="1000" disabled={fieldOff('max_players')} title={fieldTitle('max_players')} />
                <FormField label="Level Seed" name="level_seed" value={formData.level_seed} onChange={handleChange} type="text" placeholder="Leave empty for random" disabled={fieldOff('level_seed')} title={fieldTitle('level_seed')} />
              </>
            )}
          </div>
        </Section>

        {isRemote && (
          <Section title="Remote Target">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField label="Remote IP or Hostname" name="remote_host" value={formData.remote_host} onChange={handleChange} type="text" required disabled={fieldOff('remote_host')} title={fieldTitle('remote_host')} />
              <FormField label="Remote IPv4 Port" name="remote_ipv4_port" value={formData.remote_ipv4_port} onChange={handleChange} type="number" min="1" max="65535" required disabled={fieldOff('remote_ipv4_port')} title={fieldTitle('remote_ipv4_port')} />
              <FormField label="Remote IPv6 Port" name="remote_ipv6_port" value={formData.remote_ipv6_port} onChange={handleChange} type="number" min="1" max="65535" required disabled={fieldOff('remote_ipv6_port')} title={fieldTitle('remote_ipv6_port')} />
            </div>
            <p className="mt-3 text-xs text-mc-textMuted">
              This manager must be able to ping the host. Changing the target while the gateway is running restarts forwarding.
            </p>
          </Section>
        )}

        {!isRemote && (
        <>
        {/* Game Settings */}
        <Section title="Game Settings">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SelectField label="Game Mode" name="gamemode" value={formData.gamemode} onChange={handleChange} disabled={fieldOff('gamemode')} title={fieldTitle('gamemode')} options={[
              { value: 'survival', label: 'Survival' },
              { value: 'creative', label: 'Creative' },
              { value: 'adventure', label: 'Adventure' },
              { value: 'default', label: 'Default' },
            ]} />
            <SelectField label="Difficulty" name="difficulty" value={formData.difficulty} onChange={handleChange} disabled={fieldOff('difficulty')} title={fieldTitle('difficulty')} options={[
              { value: 'peaceful', label: 'Peaceful' },
              { value: 'easy', label: 'Easy' },
              { value: 'normal', label: 'Normal' },
              { value: 'hard', label: 'Hard' },
            ]} />
            <FormField label="View Distance" name="view_distance" value={formData.view_distance} onChange={handleChange} type="number" min="2" max="32" disabled={fieldOff('view_distance')} />
            <FormField label="Tick Distance" name="tick_distance" value={formData.tick_distance} onChange={handleChange} type="number" min="1" max="10" disabled={fieldOff('tick_distance')} />
            <FormField label="Player Idle Timeout (min)" name="player_idle_timeout" value={formData.player_idle_timeout} onChange={handleChange} type="number" min="0" max="1440" disabled={fieldOff('player_idle_timeout')} />
            <FormField label="TX Rate (FPS)" name="tx_rate" value={formData.tx_rate} onChange={handleChange} type="number" min="1" max="60" disabled={fieldOff('tx_rate')} />
            <FormField label="Simulation Distance" name="simulation_distance" value={formData.simulation_distance} onChange={handleChange} type="number" min="3" max="32" disabled={fieldOff('simulation_distance')} />
            <FormField label="Spawn Protection" name="spawn_protection" value={formData.spawn_protection} onChange={handleChange} type="number" min="0" max="1024" disabled={fieldOff('spawn_protection')} />

          </div>
        </Section>

        {/* Toggles */}
        <Section title="Server Options">
          <div className="space-y-4">
            <ToggleRow label="Enable Cheats" name="enable_cheats" value={formData.enable_cheats} onToggle={handleToggle} description="Allow cheats and commands" disabled={fieldOff('enable_cheats')} />
            <ToggleRow label="Server Authoritative" name="server_authoritative" value={formData.server_authoritative} onToggle={handleToggle} description="Server controls game logic" disabled={fieldOff('server_authoritative')} />
            <ToggleRow label="Whitelist Mode" name="whitelist_mode" value={formData.whitelist_mode} onToggle={handleToggle} description="Only whitelisted players can join" disabled={fieldOff('whitelist_mode')} />
            <ToggleRow label="Texture Pack Required" name="texture_pack_required" value={formData.texture_pack_required} onToggle={handleToggle} description="Players must accept texture packs" disabled={fieldOff('texture_pack_required')} />
            <ToggleRow label="Auto Ice" name="auto_ice" value={formData.auto_ice} onToggle={handleToggle} description="Water freezes into ice" disabled={fieldOff('auto_ice')} />
            <ToggleRow label="Natural Regeneration" name="natural_regeneration" value={formData.natural_regeneration} onToggle={handleToggle} description="Health regenerates over time" disabled={fieldOff('natural_regeneration')} />
            <ToggleRow label="Online Mode" name="online_mode" value={formData.online_mode} onToggle={handleToggle} description={isJava ? 'Require a paid Minecraft Java account' : 'Require Xbox Live authentication'} disabled={fieldOff('online_mode')} />
            <ToggleRow label="Remote Discovery" name="remote_discovery" value={formData.remote_discovery} onToggle={handleToggle} description="Show server in external listings" disabled={fieldOff('remote_discovery')} />
            <ToggleRow label="Allow Third-Party Requests" name="allow_third_party_requests" value={formData.allow_third_party_requests} onToggle={handleToggle} description="Allow realms invites" disabled={fieldOff('allow_third_party_requests')} />
            <ToggleRow label="Allow Third-Party Pictures" name="allow_third_party_pictures" value={formData.allow_third_party_pictures} onToggle={handleToggle} description="Allow skin data from third parties" disabled={fieldOff('allow_third_party_pictures')} />
            <ToggleRow label="Require Secure Chat" name="require_secure_chat" value={formData.require_secure_chat} onToggle={handleToggle} description="Enforce chat signing" disabled={fieldOff('require_secure_chat')} />
            <ToggleRow label="Server Authoritative Inventory" name="server_authoritative_inventory" value={formData.server_authoritative_inventory} onToggle={handleToggle} description="Server manages inventory" disabled={fieldOff('server_authoritative_inventory')} />
            <ToggleRow label="Enable Player Data Init" name="enable_player_data_initialization" value={formData.enable_player_data_initialization} onToggle={handleToggle} description="Create player data on first join" disabled={fieldOff('enable_player_data_initialization')} />
            <ToggleRow label="PvP" name="pvp" value={formData.pvp} onToggle={handleToggle} description="Players can damage each other" disabled={fieldOff('pvp')} />
            <ToggleRow label="Allow Nether" name="allow_nether" value={formData.allow_nether} onToggle={handleToggle} description="Enable nether portals" disabled={fieldOff('allow_nether')} />
            <ToggleRow label="Allow Flight" name="allow_flight" value={formData.allow_flight} onToggle={handleToggle} description="Allow survival flight without kicking" disabled={fieldOff('allow_flight')} />
            <ToggleRow label="Enable Command Blocks" name="enable_command_block" value={formData.enable_command_block} onToggle={handleToggle} description="Command blocks can run" disabled={fieldOff('enable_command_block')} />
            <ToggleRow label="Hardcore" name="hardcore" value={formData.hardcore} onToggle={handleToggle} description="Ban players on death" disabled={fieldOff('hardcore')} />
            <ToggleRow label="Force Gamemode" name="force_gamemode" value={formData.force_gamemode} onToggle={handleToggle} description="Reset joining players to the server gamemode" disabled={fieldOff('force_gamemode')} />
            <ToggleRow label="Spawn Animals" name="spawn_animals" value={formData.spawn_animals} onToggle={handleToggle} description="Animals spawn naturally" disabled={fieldOff('spawn_animals')} />
            <ToggleRow label="Spawn Villagers" name="spawn_npcs" value={formData.spawn_npcs} onToggle={handleToggle} description="Villagers spawn" disabled={fieldOff('spawn_npcs')} />
            <ToggleRow label="Spawn Monsters" name="spawn_monsters" value={formData.spawn_monsters} onToggle={handleToggle} description="Hostile mobs spawn" disabled={fieldOff('spawn_monsters')} />
            <ToggleRow label="Generate Structures" name="generate_structures" value={formData.generate_structures} onToggle={handleToggle} description="Villages, strongholds, and other structures" disabled={fieldOff('generate_structures')} />
            <ToggleRow label="Hide Online Players" name="hide_online_players" value={formData.hide_online_players} onToggle={handleToggle} description="Do not show player names in server list ping" disabled={fieldOff('hide_online_players')} />
            <ToggleRow label="Enforce Whitelist" name="enforce_whitelist" value={formData.enforce_whitelist} onToggle={handleToggle} description="Kick players who are removed from the whitelist" disabled={fieldOff('enforce_whitelist')} />
            <ToggleRow label="Require Resource Pack" name="require_resource_pack" value={formData.require_resource_pack} onToggle={handleToggle} description="Players must accept the server resource pack" disabled={fieldOff('require_resource_pack')} />
            <ToggleRow label="Broadcast Console to Ops" name="broadcast_console_to_ops" value={formData.broadcast_console_to_ops} onToggle={handleToggle} description="Ops see console output in-game" disabled={fieldOff('broadcast_console_to_ops')} />
            <ToggleRow label="Enable Status" name="enable_status" value={formData.enable_status} onToggle={handleToggle} description="Reply to Minecraft server list pings" disabled={fieldOff('enable_status')} />
            <ToggleRow label="Enable Query" name="enable_query" value={formData.enable_query} onToggle={handleToggle} description="Enable GameSpy query protocol" disabled={fieldOff('enable_query')} />
            <ToggleRow label="Enable RCON" name="enable_rcon" value={formData.enable_rcon} onToggle={handleToggle} description="Remote console protocol" disabled={fieldOff('enable_rcon')} />
            <ToggleRow label="Sync Chunk Writes" name="sync_chunk_writes" value={formData.sync_chunk_writes} onToggle={handleToggle} description="Flush chunks synchronously" disabled={fieldOff('sync_chunk_writes')} />
            <ToggleRow label="Prevent Proxy Connections" name="prevent_proxy_connections" value={formData.prevent_proxy_connections} onToggle={handleToggle} description="Reject connections through proxies" disabled={fieldOff('prevent_proxy_connections')} />
            <ToggleRow label="Enforce Secure Profile" name="enforce_secure_profile" value={formData.enforce_secure_profile} onToggle={handleToggle} description="Require a Mojang signed player profile" disabled={fieldOff('enforce_secure_profile')} />

          </div>
        </Section>

        {/* Permission */}
        <Section title="Permissions">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
            <p className="text-xs text-mc-textMuted flex-1">
              Bedrock visitor/member/operator levels stay on every server. Java ops and function permissions stay visible too; each side is disabled on the other edition.
            </p>
            <select
              value={permissionFilter}
              onChange={(e) => setPermissionFilter(e.target.value)}
              className="input sm:w-40 text-sm"
              aria-label="Permission list filter"
            >
              <option value="all">All permissions</option>
              <option value="bedrock">Bedrock only</option>
              <option value="java">Java only</option>
            </select>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {showPerm('bedrock') && (
              <>
                <SelectField label="Default Player Permission" name="default_player_permission" value={formData.default_player_permission} onChange={handleChange} disabled={fieldOff('default_player_permission')} options={[
                  { value: 'visitor', label: 'Visitor' },
                  { value: 'member', label: 'Member' },
                  { value: 'operator', label: 'Operator' },
                ]} />
                <SelectField label="Default 1st Person" name="default_1st_person" value={String(formData.default_1st_person)} onChange={handleChange} disabled={fieldOff('default_1st_person')} options={[
                  { value: '0', label: 'Off' },
                  { value: '1', label: 'On' },
                ]} />
              </>
            )}
            {showPerm('java') && (
              <>
                <SelectField label="Op Permission Level" name="op_permission_level" value={formData.op_permission_level} onChange={handleChange} disabled={fieldOff('op_permission_level')} options={[
                  { value: '1', label: '1 — Bypass spawn protection' },
                  { value: '2', label: '2 — Use command blocks / clear' },
                  { value: '3', label: '3 — Ban, op, and kick' },
                  { value: '4', label: '4 — All commands' },
                ]} />
                <SelectField label="Function Permission Level" name="function_permission_level" value={formData.function_permission_level} onChange={handleChange} disabled={fieldOff('function_permission_level')} options={[
                  { value: '1', label: '1' },
                  { value: '2', label: '2' },
                  { value: '3', label: '3' },
                  { value: '4', label: '4' },
                ]} />
              </>
            )}
          </div>
        </Section>

        <Section title="Java Network">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField label="Network Compression Threshold" name="network_compression_threshold" value={formData.network_compression_threshold} onChange={handleChange} type="number" disabled={fieldOff('network_compression_threshold')} />
            <FormField label="Entity Broadcast Range %" name="entity_broadcast_range_percentage" value={formData.entity_broadcast_range_percentage} onChange={handleChange} type="number" min="10" max="1000" disabled={fieldOff('entity_broadcast_range_percentage')} />
            <FormField label="Query Port" name="query_port" value={formData.query_port} onChange={handleChange} type="number" min="1" max="65535" disabled={fieldOff('query_port')} />
            <FormField label="RCON Port" name="rcon_port" value={formData.rcon_port} onChange={handleChange} type="number" min="1" max="65535" disabled={fieldOff('rcon_port')} />
            <FormField label="RCON Password" name="rcon_password" value={formData.rcon_password} onChange={handleChange} type="text" disabled={fieldOff('rcon_password')} />
            <FormField label="Resource Pack URL" name="resource_pack" value={formData.resource_pack} onChange={handleChange} type="text" disabled={fieldOff('resource_pack')} />
            <FormField label="Resource Pack SHA-1" name="resource_pack_sha1" value={formData.resource_pack_sha1} onChange={handleChange} type="text" disabled={fieldOff('resource_pack_sha1')} />
            <SelectField label="Level Type" name="level_type" value={formData.level_type} onChange={handleChange} disabled={fieldOff('level_type')} options={[
              { value: 'minecraft:normal', label: 'Normal' },
              { value: 'minecraft:flat', label: 'Superflat' },
              { value: 'minecraft:large_biomes', label: 'Large Biomes' },
              { value: 'minecraft:amplified', label: 'Amplified' },

            ]} />
            <FormField label="Max World Size" name="max_world_size" value={formData.max_world_size} onChange={handleChange} type="number" min="1" disabled={fieldOff('max_world_size')} />
          </div>
        </Section>

        {/* Auto-Update Settings */}
        <Section title="Auto-Update">
          <div className="space-y-4">
            <div className="p-4 bg-mc-darker rounded-lg">
              <p className="text-sm text-mc-textMuted mb-3">
                {isBC
                  ? 'Automatically check for and install Bedrock Connect JAR updates. Updates apply when Bedrock Connect is stopped.'
                  : isJava
                    ? 'Automatically check for and install official Java server.jar updates. Updates apply when the server is stopped, and worlds are preserved.'
                  : 'Automatically check for and install server updates. Updates will only be applied when the server is stopped, and addons/worlds will be preserved.'}
              </p>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">Enable Auto-Update</p>
                  <p className="text-xs text-mc-textMuted">Automatically update to the latest version</p>
                </div>
                <button
                  type="button"
                  onClick={handleAutoUpdateToggle}
                  disabled={autoUpdating || isRemote || lockUpdate}
                  className={`toggle ${autoUpdateEnabled ? 'toggle-active' : 'toggle-inactive'} ${isRemote ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <span className={`toggle-thumb ${autoUpdateEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>
            {autoUpdateEnabled && (
              <div className="animate-slide-up">
                <label className="block text-sm font-medium text-mc-text mb-2">Check Interval (hours)</label>
                <select
                  value={autoUpdateInterval}
                  onChange={(e) => setAutoUpdateInterval(parseInt(e.target.value))}
                  className="input"
                >
                  <option value={1}>Every hour</option>
                  <option value={4}>Every 4 hours</option>
                  <option value={12}>Every 12 hours</option>
                  <option value={24}>Every 24 hours</option>
                  <option value={48}>Every 48 hours</option>
                  <option value={72}>Every 72 hours</option>
                  <option value={168}>Once a week</option>
                </select>
              </div>
            )}
          </div>
        </Section>
        </>
        )}

        {/* Submit */}
        <div className="flex items-center gap-3 pt-4 border-t border-mc-surfaceLight">
          <button type="submit" disabled={saving} className="btn btn-primary flex-1">
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Settings
              </>
            )}
          </button>
          <button type="button" onClick={loadServer} className="btn btn-secondary">
            <RefreshCw className="w-4 h-4" />
            Reset
          </button>
          <button type="button" onClick={() => navigate(-1)} className="btn btn-secondary">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-white mb-4">{title}</h2>
      {children}
    </div>
  );
}

function FormField({ label, name, value, onChange, type = 'text', disabled = false, title = '', ...props }) {
  return (
    <div className={disabled ? 'opacity-50' : ''} title={title}>
      <label className="block text-sm font-medium text-mc-text mb-2">{label}</label>
      <input type={type} name={name} value={value} onChange={onChange} className="input" disabled={disabled} title={title} {...props} />
    </div>
  );
}

function SelectField({ label, name, value, onChange, options, disabled = false, title = '' }) {
  return (
    <div className={disabled ? 'opacity-50' : ''} title={title}>
      <label className="block text-sm font-medium text-mc-text mb-2">{label}</label>
      <select name={name} value={value} onChange={onChange} className="input" disabled={disabled} title={title}>
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

function ToggleRow({ label, name, value, onToggle, description, disabled = false, title = '' }) {
  return (
    <div className={`flex items-center justify-between p-3 bg-mc-darker rounded-lg ${disabled ? 'opacity-50' : ''}`} title={title}>
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="text-xs text-mc-textMuted">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => { if (!disabled) onToggle(name); }}
        disabled={disabled}
        title={title}
        className={`toggle ${value === 1 ? 'toggle-active' : 'toggle-inactive'} ${disabled ? 'cursor-not-allowed' : ''}`}
      >
        <span className={`toggle-thumb ${value === 1 ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}

export default ServerProperties;
