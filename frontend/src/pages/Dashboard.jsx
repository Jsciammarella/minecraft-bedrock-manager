import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Server, Plus, Play, Square, RotateCcw, Terminal, Users, 
  Clock, Trash2, Settings, Activity, RefreshCw, AlertTriangle, Radio, Loader2, Search
} from 'lucide-react';
import { serverApi } from '../services/api';
import { useApi } from '../context/ApiContext';
import { useSocket } from '../context/SocketContext';

function isBedrockConnect(server) {
  return server?.kind === 'bedrock_connect';
}

function isRemote(server) {
  return server?.kind === 'remote';
}

const STATUS_ORDER = { running: 0, starting: 1, creating: 2, stopped: 3 };

function serverMatchesSearch(server, search) {
  if (!search) return true;
  return String(server.name || '').toLowerCase().includes(search.toLowerCase());
}

function compareServers(a, b, sortBy) {
  if (sortBy === 'status') {
    const delta = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (delta) return delta;
  } else if (sortBy === 'port') {
    const delta = Number(a.port) - Number(b.port);
    if (delta) return delta;
  } else if (sortBy === 'type') {
    const delta = (isRemote(a) ? 1 : 0) - (isRemote(b) ? 1 : 0);
    if (delta) return delta;
  } else if (isBedrockConnect(a) !== isBedrockConnect(b)) {
    return isBedrockConnect(a) ? -1 : 1;
  }
  return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
}

function Dashboard() {
  const navigate = useNavigate();
  const { servers, loading, refresh } = useApi();
  const { connected } = useSocket();
  const [actions, setActions] = useState({});
  const [bcPreview, setBcPreview] = useState(null);
  const [bcBusy, setBcBusy] = useState(false);
  const [bcError, setBcError] = useState('');
  const [bcConflict, setBcConflict] = useState(null);
  const [bcRestartMode, setBcRestartMode] = useState('immediate');
  const [bcMessage, setBcMessage] = useState('');
  const [lanBusy, setLanBusy] = useState({});
  const [lanError, setLanError] = useState('');
  const [lanMessage, setLanMessage] = useState('');
  const [lanConflict, setLanConflict] = useState(null);
  const [lanRestartMode, setLanRestartMode] = useState('immediate');
  const [actionError, setActionError] = useState('');
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [sortBy, setSortBy] = useState('name');

  const loadBcPreview = async () => {
    try {
      const res = await serverApi.previewBedrockConnect();
      setBcPreview(res.data);
    } catch (err) {
      console.error('Failed to load Bedrock Connect preview:', err);
    }
  };

  useEffect(() => {
    loadBcPreview();
  }, [servers]);

  const handleAction = async (serverId, action) => {
    setActions(prev => ({ ...prev, [`${serverId}-${action}`]: true }));
    setActionError('');
    try {
      switch (action) {
        case 'start':
          await serverApi.start(serverId);
          break;
        case 'stop':
          await serverApi.stop(serverId);
          break;
        case 'restart':
          await serverApi.restart(serverId);
          break;
        default:
          break;
      }
    } catch (err) {
      console.error(`Failed to ${action} server:`, err);
      setActionError(err.response?.data?.error || err.message || `Failed to ${action} server`);
    } finally {
      setActions(prev => ({ ...prev, [`${serverId}-${action}`]: false }));
      refresh();
    }
  };

  const handleDelete = async (serverId, serverName) => {
    if (!confirm(`Are you sure you want to delete "${serverName}"? This will remove all server data.`)) return;
    try {
      await serverApi.delete(serverId);
      refresh();
      loadBcPreview();
    } catch (err) {
      console.error('Failed to delete server:', err);
    }
  };

  const beginBedrockConnect = async () => {
    if (bcBusy || bcPreview?.exists || bcPreview?.pending) return;
    setBcError('');
    setBcMessage('');
    setBcBusy(true);
    try {
      const res = await serverApi.previewBedrockConnect();
      const preview = res.data;
      setBcPreview(preview);
      if (preview.exists || preview.pending) return;
      if (preview.portBlocked) {
        setBcError(`UDP port ${preview.port} is already in use by another process. Free it before creating Bedrock Connect.`);
        return;
      }
      if (preview.conflict) {
        setBcRestartMode('immediate');
        setBcConflict(preview.conflict);
        return;
      }
      await createBedrockConnect();
    } catch (err) {
      setBcError(err.response?.data?.error || err.message || 'Failed to create Bedrock Connect');
    } finally {
      setBcBusy(false);
    }
  };

  const lanOf = (server) => server?.stats?.lan || server?.lan || {};

  const applyLanBroadcast = async (serverId, payload) => {
    setLanBusy(prev => ({ ...prev, [serverId]: true }));
    setLanError('');
    try {
      const res = await serverApi.setLanBroadcast(serverId, payload);
      setLanConflict(null);
      if (res.data?.pending) {
        setLanMessage(res.data.message);
      } else if (res.data?.native) {
        setLanMessage('This server already uses UDP 19132, so consoles on the same LAN can see it without a proxy.');
      } else if (payload.enabled) {
        setLanMessage('LAN listing is on. Xbox, PlayStation, Windows, iOS, and Android can find this server under Friends → LAN Games. Nintendo Switch still needs Bedrock Connect.');
      }
      await refresh();
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.conflict) {
        setLanConflict({
          serverId,
          conflict: err.response.data.conflict,
          message: err.response.data.error,
        });
        return;
      }
      setLanError(err.response?.data?.error || err.message || 'Failed to update LAN listing');
    } finally {
      setLanBusy(prev => ({ ...prev, [serverId]: false }));
    }
  };

  const beginLanToggle = async (server, event) => {
    event?.stopPropagation();
    if (isBedrockConnect(server) || lanOf(server).native || server.status === 'creating') return;
    if (servers.some(item => isBedrockConnect(item) && (item.status === 'running' || item.status === 'starting'))) return;
    const enabled = Boolean(lanOf(server).enabled);
    setLanError('');
    setLanMessage('');
    if (enabled) {
      await applyLanBroadcast(server.id, { enabled: false });
      return;
    }
    setLanBusy(prev => ({ ...prev, [server.id]: true }));
    try {
      const res = await serverApi.previewLanBroadcast(server.id);
      const preview = res.data;
      if (!preview.allowed) {
        setLanError(preview.message);
        return;
      }
      if (preview.conflict) {
        setLanRestartMode('immediate');
        setLanConflict({
          serverId: server.id,
          conflict: preview.conflict,
          message: preview.message,
        });
        return;
      }
      await applyLanBroadcast(server.id, { enabled: true });
    } catch (err) {
      setLanError(err.response?.data?.error || err.message || 'Failed to update LAN listing');
    } finally {
      setLanBusy(prev => ({ ...prev, [server.id]: false }));
    }
  };

  const createBedrockConnect = async ({ acceptConflict = false, restartMode = 'immediate' } = {}) => {
    setBcBusy(true);
    setBcError('');
    try {
      const res = await serverApi.createBedrockConnect({ acceptConflict, restartMode });
      setBcConflict(null);
      if (res.data?.pending) {
        setBcMessage(res.data.message);
      } else {
        setBcMessage('Bedrock Connect was created on UDP port 19132.');
      }
      await refresh();
      await loadBcPreview();
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.conflict) {
        setBcConflict(err.response.data.conflict);
        return;
      }
      setBcError(err.response?.data?.error || err.message || 'Failed to create Bedrock Connect');
    } finally {
      setBcBusy(false);
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'running':
        return <span className="badge badge-success"><span className="w-1.5 h-1.5 bg-green-400 rounded-full mr-1.5" />Online</span>;
      case 'starting':
        return <span className="badge badge-warning"><span className="w-1.5 h-1.5 bg-yellow-400 rounded-full mr-1.5 animate-pulse" />Starting</span>;
      case 'creating':
        return <span className="badge badge-warning"><span className="w-1.5 h-1.5 bg-yellow-400 rounded-full mr-1.5 animate-pulse" />Building</span>;
      case 'stopped':
        return <span className="badge badge-danger"><span className="w-1.5 h-1.5 bg-red-400 rounded-full mr-1.5" />Offline</span>;
      default:
        return <span className="badge badge-info">{status}</span>;
    }
  };

  if (loading && servers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-mc-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-mc-textMuted">Loading servers...</p>
        </div>
      </div>
    );
  }

  const activeCount = servers.filter(s => s.status === 'running').length;
  const totalPlayers = servers.reduce((sum, s) => sum + (s.stats?.onlinePlayers || 0), 0);
  const bcExists = Boolean(bcPreview?.exists || servers.some(isBedrockConnect));
  const bcPending = Boolean(bcPreview?.pending);
  const bcDisabled = bcExists || bcPending || bcBusy;
  const bcRunning = servers.some(server => isBedrockConnect(server) && (server.status === 'running' || server.status === 'starting'));
  const buildingServers = servers.filter((server) => server.status === 'creating');
  const visibleServers = [...servers]
    .filter((server) => {
      if (filterType === 'remote') return isRemote(server);
      if (filterType === 'local') return !isRemote(server);
      return true;
    })
    .filter((server) => serverMatchesSearch(server, search))
    .sort((a, b) => compareServers(a, b, sortBy));

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="page-header flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-mc-textMuted mt-1">Manage your Minecraft Bedrock servers</p>
          <p className="text-xs text-mc-textMuted mt-1">Automatically updated every 5 minutes.</p>
        </div>
        <div className="flex flex-col items-end gap-2 max-md:items-stretch">
          <div className="page-header-actions flex items-center gap-2">
          <button
            onClick={() => refresh()}
            disabled={loading}
            className="btn btn-secondary"
            title="Refresh dashboard now"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={beginBedrockConnect}
            disabled={bcDisabled}
            className={`btn ${bcDisabled ? 'bg-mc-surfaceLight text-mc-textMuted' : 'bg-green-500 hover:bg-green-600 text-white'}`}
            title={bcExists ? 'Bedrock Connect already exists' : bcPending ? 'Bedrock Connect will be created after the warned restart' : 'Create Bedrock Connect on UDP 19132'}
          >
            <Plus className="w-4 h-4" />
            {bcBusy ? 'Creating...' : 'Bedrock Connect'}
          </button>
          <button
            onClick={() => navigate('/servers/new')}
            className="btn btn-primary"
          >
            <Plus className="w-4 h-4" />
            New Server
          </button>
          </div>
          <p className="text-xs text-mc-textMuted flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${bcRunning ? 'bg-red-400' : 'bg-green-400 animate-pulse-glow'}`} />
            {bcRunning
              ? 'LAN Proxy Disabled — Stop or remove Bedrock Connect to start LAN proxy'
              : 'LAN Proxy Enabled'}
          </p>
        </div>
      </div>

      {bcError && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
          {bcError}
        </div>
      )}
      {bcMessage && (
        <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-400">
          {bcMessage}
        </div>
      )}
      {bcPending && (
        <div className="mb-6 p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-300 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            Bedrock Connect will be created on UDP 19132 after the warned restart finishes and the occupying server moves to another port.
          </span>
        </div>
      )}

      {lanError && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
          {lanError}
        </div>
      )}
      {actionError && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
          {actionError}
        </div>
      )}
      {lanMessage && (
        <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-400">
          {lanMessage}
        </div>
      )}
      {buildingServers.length > 0 && (
        <div className="mb-6 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg text-sm text-yellow-300">
          Building {buildingServers.map((server) => server.name).join(', ')}. Start and LAN unlock when this finishes.
        </div>
      )}

      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-mc-textMuted">Total Servers</p>
              <p className="text-2xl font-bold text-white mt-1">{servers.length}</p>
            </div>
            <div className="w-10 h-10 bg-blue-500/20 rounded-lg flex items-center justify-center">
              <Server className="w-5 h-5 text-blue-400" />
            </div>
          </div>
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-mc-textMuted">Active</p>
              <p className="text-2xl font-bold text-green-400 mt-1">{activeCount}</p>
            </div>
            <div className="w-10 h-10 bg-green-500/20 rounded-lg flex items-center justify-center">
              <Activity className="w-5 h-5 text-green-400" />
            </div>
          </div>
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-mc-textMuted">Total Players</p>
              <p className="text-2xl font-bold text-mc-text mt-1">{totalPlayers}</p>
            </div>
            <div className="w-10 h-10 bg-purple-500/20 rounded-lg flex items-center justify-center">
              <Users className="w-5 h-5 text-purple-400" />
            </div>
          </div>
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-mc-textMuted">Connection</p>
              <p className={`text-sm font-bold mt-1 ${connected ? 'text-green-400' : 'text-red-400'}`}>
                {connected ? 'Connected' : 'Disconnected'}
              </p>
            </div>
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
              connected ? 'bg-green-500/20' : 'bg-red-500/20'
            }`}>
              <Clock className={`w-5 h-5 ${connected ? 'text-green-400' : 'text-red-400'}`} />
            </div>
          </div>
        </div>
      </div>

      {/* Server List */}
      {servers.length === 0 ? (
        <div className="card text-center py-16">
          <Server className="w-16 h-16 text-mc-textMuted mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-white mb-2">No servers yet</h3>
          <p className="text-mc-textMuted mb-6">Create your first Minecraft Bedrock server to get started</p>
          <div className="flex items-center justify-center gap-3 max-md:flex-col">
            <button
              onClick={beginBedrockConnect}
              disabled={bcDisabled}
              className={`btn ${bcDisabled ? 'bg-mc-surfaceLight text-mc-textMuted' : 'bg-green-500 hover:bg-green-600 text-white'}`}
            >
              <Plus className="w-4 h-4" />
              Bedrock Connect
            </button>
            <button
              onClick={() => navigate('/servers/new')}
              className="btn btn-primary"
            >
              <Plus className="w-4 h-4" />
              Create Server
            </button>
          </div>
        </div>
      ) : (
        <>
        <div className="card mb-6">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mc-textMuted" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input pl-10"
                placeholder="Search servers..."
              />
            </div>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="input w-40"
            >
              <option value="all">All Types</option>
              <option value="local">Local</option>
              <option value="remote">Remote</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="input w-40"
            >
              <option value="name">Sort by name</option>
              <option value="status">Sort by status</option>
              <option value="port">Sort by port</option>
              <option value="type">Sort by type</option>
            </select>
          </div>
        </div>
        {visibleServers.length === 0 ? (
          <div className="card text-center py-16">
            <Server className="w-16 h-16 text-mc-textMuted mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-white mb-2">No servers match</h3>
            <p className="text-mc-textMuted">Try a different search or filter.</p>
          </div>
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {visibleServers.map((server) => {
            const lan = lanOf(server);
            const lanOn = Boolean(lan.native || lan.enabled);
            const isBuilding = server.status === 'creating';
            const createFailed = String(server.pending_restart_reason || '').startsWith('Create failed');
            const lanLocked = isBedrockConnect(server) || lan.native || bcRunning || isBuilding;
            const lanTitle = isBedrockConnect(server)
              ? 'Bedrock Connect is a featured-server list, not a LAN game'
              : isBuilding
                ? 'Wait until this server finishes building'
                : lan.native
                ? 'This server already uses UDP 19132, so consoles on the same LAN can see it'
                : bcRunning
                  ? 'Stop or remove Bedrock Connect to start LAN proxy'
                  : lanOn
                    ? 'Hide this server from console LAN games'
                    : 'Show this server under Friends → LAN Games on consoles';
            const connectLabel = server.connectAddress || `Port ${server.port}`;
            return (
            <div
              key={server.id}
              className="card animate-slide-up cursor-pointer hover:border-mc-accent/40 transition-colors"
              onClick={() => navigate(`/servers/${server.id}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') navigate(`/servers/${server.id}`);
              }}
              role="link"
              tabIndex={0}
              aria-label={`View ${server.name} details`}
            >
              {/* Server Header */}
              <div className="server-card-header flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${
                    server.status === 'running' ? 'bg-green-400 animate-pulse-glow' : 
                    server.status === 'starting' || server.status === 'creating' ? 'bg-yellow-400 animate-pulse' : 'bg-red-400'
                  }`} />
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-white">{server.name}</h3>
                      {isBedrockConnect(server) && (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/30">
                          Console list
                        </span>
                      )}
                      {isRemote(server) && (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30">
                          Remote
                        </span>
                      )}
                      {lan.active && !lan.native && !isBedrockConnect(server) && (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30">
                          LAN
                        </span>
                      )}
                      {lan.native && !isBedrockConnect(server) && (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30">
                          LAN native
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-mc-textMuted" title={connectLabel}>
                      v{isRemote(server) ? 'N/A' : server.version} • <span className={connectLabel === 'Phantom Proxy' ? 'text-sky-300' : 'font-mono text-mc-text'}>{connectLabel}</span>
                    </p>
                  </div>
                </div>
                {getStatusBadge(server.status)}
              </div>

              {isBuilding && (
                <div className="mb-4 p-2.5 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-yellow-300 text-sm flex items-start gap-2">
                  <Loader2 className="w-4 h-4 flex-shrink-0 mt-0.5 animate-spin" />
                  <div>
                    <p className="font-medium">Building Server</p>
                    <p className="text-xs text-yellow-200/80 mt-1">Downloading Minecraft Bedrock Dedicated Server. Start and LAN unlock when this finishes.</p>
                  </div>
                </div>
              )}
              {createFailed && server.pending_restart !== 1 && (
                <div className="mb-4 p-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 text-xs flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  {server.pending_restart_reason}
                </div>
              )}
              {server.pending_restart === 1 && (
                <div className="mb-4 p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    Restart required. {server.pending_restart_reason || 'Changes are pending'} and will apply after the next restart.
                  </span>
                </div>
              )}
              {server.pending_port && (
                <div className="mb-4 p-2.5 rounded-lg border border-blue-500/30 bg-blue-500/10 text-blue-300 text-xs">
                  IPv4 port will change to {server.pending_port} after restart.
                </div>
              )}
              {server.pending_ipv6_port && (
                <div className="mb-4 p-2.5 rounded-lg border border-blue-500/30 bg-blue-500/10 text-blue-300 text-xs">
                  IPv6 port will change to {server.pending_ipv6_port} after restart.
                </div>
              )}

              {lan.error && !/Stop or remove Bedrock Connect/i.test(lan.error) && (
                <div className="mb-4 p-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-xs">
                  {lan.error}
                </div>
              )}

              {/* Server Info */}
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="text-center p-2 bg-mc-darker rounded-lg">
                  <Users className="w-4 h-4 text-mc-textMuted mx-auto mb-1" />
                  <p className="text-sm font-medium text-white">{isRemote(server) ? 'N/A' : (server.stats?.onlinePlayers || 0)}</p>
                  <p className="text-xs text-mc-textMuted">Players</p>
                </div>
                <div className="text-center p-2 bg-mc-darker rounded-lg">
                  <Clock className="w-4 h-4 text-mc-textMuted mx-auto mb-1" />
                  <p className="text-sm font-medium text-white">{server.stats?.uptime || '0m'}</p>
                  <p className="text-xs text-mc-textMuted">Uptime</p>
                </div>
                <div className="text-center p-2 bg-mc-darker rounded-lg">
                  <PackageIcon className="w-4 h-4 text-mc-textMuted mx-auto mb-1" />
                  <p className="text-sm font-medium text-white">{isRemote(server) ? 'N/A' : (server.stats?.installedMods || 0)}</p>
                  <p className="text-xs text-mc-textMuted">Mods</p>
                </div>
              </div>

              {/* Actions */}
              <div className="page-actions flex items-center gap-2">
                {server.status === 'creating' && (
                  <button disabled className="btn btn-secondary flex-1 text-sm">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Building...
                  </button>
                )}
                {server.status === 'starting' && (
                  <button disabled className="btn btn-primary flex-1 text-sm">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Starting...
                  </button>
                )}
                {server.status !== 'running' && server.status !== 'creating' && server.status !== 'starting' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleAction(server.id, 'start'); }}
                    disabled={actions[`${server.id}-start`]}
                    className="btn btn-primary flex-1 text-sm"
                  >
                    <Play className="w-3.5 h-3.5" />
                    {actions[`${server.id}-start`] ? 'Starting...' : 'Start'}
                  </button>
                )}
                {server.status === 'running' && (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleAction(server.id, 'stop'); }}
                      disabled={actions[`${server.id}-stop`]}
                      className="btn btn-danger flex-1 text-sm"
                    >
                      <Square className="w-3.5 h-3.5" />
                      {actions[`${server.id}-stop`] ? 'Stopping...' : 'Stop'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleAction(server.id, 'restart'); }}
                      disabled={actions[`${server.id}-restart`]}
                      className="btn btn-secondary text-sm"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); navigate(`/servers/${server.id}`); }}
                  className="btn btn-secondary text-sm"
                  title="View Details"
                >
                  <Terminal className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); navigate(`/servers/${server.id}/properties`); }}
                  className="btn btn-secondary text-sm"
                  title="Properties"
                >
                  <Settings className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => beginLanToggle(server, e)}
                  disabled={lanLocked || lanBusy[server.id]}
                  className={`btn text-sm ${
                    lanLocked
                      ? 'bg-mc-surfaceLight text-mc-textMuted'
                      : lanOn
                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 hover:bg-sky-500/30'
                        : 'btn-secondary'
                  }`}
                  title={lanTitle}
                >
                  <Radio className="w-3.5 h-3.5" />
                  {lanBusy[server.id] ? '...' : 'LAN'}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(server.id, server.name); }}
                  className="btn btn-secondary text-sm text-mc-danger hover:bg-red-500/20"
                  title="Delete Server"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            );
          })}
        </div>
        )}
        </>
      )}

      {bcConflict && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-lg w-full animate-slide-up">
            <h3 className="text-lg font-semibold text-white mb-3">Move server off port 19132?</h3>
            <p className="text-sm text-mc-textMuted mb-4">
              Bedrock Connect must listen on UDP <span className="font-mono text-white">19132</span> so consoles can find it.
              <span className="text-white"> {bcConflict.serverName}</span> currently uses that port and will be moved to{' '}
              <span className="font-mono text-white">{bcConflict.nextPort}</span>.
            </p>
            {bcConflict.status === 'running' ? (
              <div className="mb-4 space-y-2">
                <p className="text-sm font-medium text-white">When should that server restart?</p>
                <label className="flex items-start gap-3 p-3 bg-mc-darker rounded-lg cursor-pointer">
                  <input
                    type="radio"
                    name="bc-restart-mode"
                    value="immediate"
                    checked={bcRestartMode === 'immediate'}
                    onChange={() => setBcRestartMode('immediate')}
                    className="mt-1"
                  />
                  <span>
                    <span className="text-sm text-white">Restart immediately</span>
                    <span className="block text-xs text-mc-textMuted">Players will be disconnected now, then Bedrock Connect is created.</span>
                  </span>
                </label>
                <label className="flex items-start gap-3 p-3 bg-mc-darker rounded-lg cursor-pointer">
                  <input
                    type="radio"
                    name="bc-restart-mode"
                    value="warned"
                    checked={bcRestartMode === 'warned'}
                    onChange={() => setBcRestartMode('warned')}
                    className="mt-1"
                  />
                  <span>
                    <span className="text-sm text-white">Warn players and restart in 5 minutes</span>
                    <span className="block text-xs text-mc-textMuted">Bedrock Connect is created after that restart finishes.</span>
                  </span>
                </label>
              </div>
            ) : (
              <p className="text-sm text-mc-textMuted mb-4">
                That server is stopped, so the port can be changed immediately without a restart.
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={() => createBedrockConnect({
                  acceptConflict: true,
                  restartMode: bcConflict.status === 'running' ? bcRestartMode : 'immediate',
                })}
                disabled={bcBusy}
                className="btn bg-green-500 hover:bg-green-600 text-white flex-1"
              >
                {bcBusy ? 'Working...' : 'Accept and continue'}
              </button>
              <button
                onClick={() => setBcConflict(null)}
                disabled={bcBusy}
                className="btn btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {lanConflict && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={(e) => e.stopPropagation()}>
          <div className="card max-w-lg w-full animate-slide-up">
            <h3 className="text-lg font-semibold text-white mb-3">Move server off port 19132?</h3>
            <p className="text-sm text-mc-textMuted mb-4">
              Consoles look for LAN games on UDP <span className="font-mono text-white">19132</span>.
              <span className="text-white"> {lanConflict.conflict.serverName}</span> currently uses that port and will be moved to{' '}
              <span className="font-mono text-white">{lanConflict.conflict.nextPort}</span>.
              That server will also be listed on LAN so it does not disappear from consoles.
            </p>
            {lanConflict.conflict.status === 'running' ? (
              <div className="mb-4 space-y-2">
                <p className="text-sm font-medium text-white">When should that server restart?</p>
                <label className="flex items-start gap-3 p-3 bg-mc-darker rounded-lg cursor-pointer">
                  <input
                    type="radio"
                    name="lan-restart-mode"
                    value="immediate"
                    checked={lanRestartMode === 'immediate'}
                    onChange={() => setLanRestartMode('immediate')}
                    className="mt-1"
                  />
                  <span>
                    <span className="text-sm text-white">Restart immediately</span>
                    <span className="block text-xs text-mc-textMuted">Players will be disconnected now, then LAN listing starts.</span>
                  </span>
                </label>
                <label className="flex items-start gap-3 p-3 bg-mc-darker rounded-lg cursor-pointer">
                  <input
                    type="radio"
                    name="lan-restart-mode"
                    value="warned"
                    checked={lanRestartMode === 'warned'}
                    onChange={() => setLanRestartMode('warned')}
                    className="mt-1"
                  />
                  <span>
                    <span className="text-sm text-white">Warn players and restart in 5 minutes</span>
                    <span className="block text-xs text-mc-textMuted">LAN listing starts after that restart finishes.</span>
                  </span>
                </label>
              </div>
            ) : (
              <p className="text-sm text-mc-textMuted mb-4">
                That server is stopped, so the port can be changed immediately without a restart.
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={() => applyLanBroadcast(lanConflict.serverId, {
                  enabled: true,
                  acceptConflict: true,
                  restartMode: lanConflict.conflict.status === 'running' ? lanRestartMode : 'immediate',
                })}
                disabled={lanBusy[lanConflict.serverId]}
                className="btn bg-sky-500 hover:bg-sky-600 text-white flex-1"
              >
                {lanBusy[lanConflict.serverId] ? 'Working...' : 'Accept and continue'}
              </button>
              <button
                onClick={() => setLanConflict(null)}
                disabled={lanBusy[lanConflict.serverId]}
                className="btn btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PackageIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M16.5 9.4 7.55 4.24" />
      <path d="M3 7.36v9.26c0 .48.35.9.83.98l8.22 1.53c.5.09 1.01-.04 1.38-.37l4.06-3.63c.2-.18.35-.42.42-.68l2.5-10.33c.18-.74-.37-1.49-1.14-1.6L9.8 2.97a2 2 0 0 0-1.38.37L4.36 6.55A.5.5 0 0 0 3 7.36Z" />
    </svg>
  );
}

export default Dashboard;
