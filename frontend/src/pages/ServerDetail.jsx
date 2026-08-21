import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { serverApi, modApi, playerApi } from '../services/api';
import { useApi } from '../context/ApiContext';
import { useSocket } from '../context/SocketContext';
import {
  ArrowLeft, Play, Square, RotateCcw, Terminal, Send, Users,
  Settings, ArrowUpRight, Clock, Package, ChevronDown, ChevronUp,
  Copy, Trash2, Download, AlertCircle, AlertTriangle, Check, Loader2,
  Shield, ShieldOff, Ban, UserPlus, Radio, Plus, X, Search
} from 'lucide-react';

function PlayerCombobox({ value, onChange, options, disabled, placeholder, onEnter }) {
  const [open, setOpen] = useState(false);
  const query = String(value || '').trim().toLowerCase();
  const filtered = options.filter((player) => (
    !query || player.username.toLowerCase().includes(query)
  ));

  return (
    <div className="relative flex-1">
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onEnter?.();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        className="input w-full"
        autoComplete="off"
      />
      {open && !disabled && filtered.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-48 overflow-auto bg-mc-darker border border-mc-surfaceLight rounded-lg shadow-lg">
          {filtered.map((player) => (
            <button
              type="button"
              key={player.id}
              className="w-full text-left px-3 py-2 text-sm text-white hover:bg-mc-surfaceLight"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(player.username);
                setOpen(false);
              }}
            >
              {player.username}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ServerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh, servers } = useApi();
  const { connected, joinServer, serverOutputs, addServerOutput } = useSocket();
  
  const [server, setServer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [command, setCommand] = useState('');
  const [commandHistory, setCommandHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(null);
  const [showTerminal, setShowTerminal] = useState(true);
  const [showPlayers, setShowPlayers] = useState(true);
  const [showMods, setShowMods] = useState(true);
  const [actions, setActions] = useState({});
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateVersion, setUpdateVersion] = useState('latest');
  const [updateVersions, setUpdateVersions] = useState([]);
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(false);
  const [playerAccess, setPlayerAccess] = useState([]);
  const [allowQuery, setAllowQuery] = useState('');
  const [banQuery, setBanQuery] = useState('');
  const [accessMessage, setAccessMessage] = useState(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [removingModId, setRemovingModId] = useState(null);
  const [modMessage, setModMessage] = useState(null);
  const [showManageMods, setShowManageMods] = useState(false);
  const [libraryMods, setLibraryMods] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [busyModId, setBusyModId] = useState(null);
  const [removeModModal, setRemoveModModal] = useState(null);
  const [restartScheduling, setRestartScheduling] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const [lanBusy, setLanBusy] = useState(false);
  const [lanError, setLanError] = useState('');
  const [lanMessage, setLanMessage] = useState('');
  const [lanConflict, setLanConflict] = useState(null);
  const [lanRestartMode, setLanRestartMode] = useState('immediate');
  const terminalRef = useRef(null);
  const terminalOutput = (serverOutputs[String(id)] || []).slice(-200);

  useEffect(() => {
    setLoading(true);
    loadServer();
    joinServer(id);
    setCommand('');
    setHistoryIndex(null);
    try {
      const saved = JSON.parse(localStorage.getItem(`mcmanager-command-history-${id}`) || '[]');
      setCommandHistory(Array.isArray(saved) ? saved.slice(-50) : []);
    } catch {
      setCommandHistory([]);
    }
    const refreshInterval = setInterval(loadServer, 60 * 1000);
    return () => clearInterval(refreshInterval);
  }, [id]);

  useEffect(() => {
    const handleStatusChange = (event) => {
      if (String(event.detail?.serverId) === String(id)) loadServer();
    };
    window.addEventListener('server-status-change', handleStatusChange);
    return () => window.removeEventListener('server-status-change', handleStatusChange);
  }, [id]);

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalOutput.length, id]);

  const loadServer = async () => {
    try {
      const [res, accessRes] = await Promise.all([
        serverApi.getById(id),
        playerApi.getByServer(id),
      ]);
      setServer(res.data);
      setPlayerAccess(accessRes.data.players || []);
      // Load auto-update status
      try {
        const auRes = await serverApi.getAutoUpdate(id);
        setAutoUpdateEnabled(!!auRes.data?.enabled);
      } catch {}
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const updatePlayerAccess = async (playerId, changes, message) => {
    setAccessBusy(true);
    setAccessMessage(null);
    try {
      await playerApi.updateServerAccess(id, playerId, changes);
      const res = await playerApi.getByServer(id);
      setPlayerAccess(res.data.players || []);
      setAllowQuery('');
      setBanQuery('');
      setAccessMessage({ type: 'success', text: message });
    } catch (err) {
      setAccessMessage({ type: 'error', text: err.response?.data?.error || err.message });
    } finally {
      setAccessBusy(false);
    }
  };

  const resolvePlayerId = async (query) => {
    const name = String(query || '').trim();
    if (!name) throw new Error('Enter a player name');
    const match = playerAccess.find((player) => (
      String(player.id) === name || player.username.toLowerCase() === name.toLowerCase()
    ));
    if (match) return match.id;
    const created = await playerApi.add({ username: name });
    return created.data.id;
  };

  const addAllowPlayer = async () => {
    setAccessBusy(true);
    setAccessMessage(null);
    try {
      const playerId = await resolvePlayerId(allowQuery);
      await playerApi.updateServerAccess(id, playerId, { isWhitelisted: true });
      const res = await playerApi.getByServer(id);
      setPlayerAccess(res.data.players || []);
      setAllowQuery('');
      setAccessMessage({ type: 'success', text: 'Player added to this server allow list.' });
    } catch (err) {
      setAccessMessage({ type: 'error', text: err.response?.data?.error || err.message });
    } finally {
      setAccessBusy(false);
    }
  };

  const addBanPlayer = async () => {
    setAccessBusy(true);
    setAccessMessage(null);
    try {
      const playerId = await resolvePlayerId(banQuery);
      await playerApi.updateServerAccess(id, playerId, {
        isBanned: true,
        banReason: 'Banned by server administrator',
      });
      const res = await playerApi.getByServer(id);
      setPlayerAccess(res.data.players || []);
      setBanQuery('');
      setAccessMessage({ type: 'success', text: 'Player banned from this server.' });
    } catch (err) {
      setAccessMessage({ type: 'error', text: err.response?.data?.error || err.message });
    } finally {
      setAccessBusy(false);
    }
  };

  const applyLanBroadcast = async (payload) => {
    setLanBusy(true);
    setLanError('');
    try {
      const res = await serverApi.setLanBroadcast(id, payload);
      setLanConflict(null);
      if (res.data?.pending) {
        setLanMessage(res.data.message);
      } else if (res.data?.native) {
        setLanMessage('This server already uses UDP 19132, so consoles on the same LAN can see it without a proxy.');
      } else if (payload.enabled) {
        setLanMessage('LAN listing is on. Xbox, PlayStation, Windows, iOS, and Android can find this server under Friends → LAN Games. Nintendo Switch still needs Bedrock Connect.');
      } else {
        setLanMessage('');
      }
      await loadServer();
      await refresh();
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.conflict) {
        setLanConflict(err.response.data.conflict);
        setLanError(err.response.data.error || '');
        return;
      }
      setLanError(err.response?.data?.error || err.message || 'Failed to update LAN listing');
    } finally {
      setLanBusy(false);
    }
  };

  const beginLanToggle = async () => {
    const lan = server?.stats?.lan || server?.lan || {};
    if (server?.kind === 'bedrock_connect' || lan.native || server?.status === 'creating') return;
    if (servers.some(item => item.kind === 'bedrock_connect' && (item.status === 'running' || item.status === 'starting'))) return;
    setLanError('');
    setLanMessage('');
    if (lan.enabled) {
      await applyLanBroadcast({ enabled: false });
      return;
    }
    setLanBusy(true);
    try {
      const res = await serverApi.previewLanBroadcast(id);
      const preview = res.data;
      if (!preview.allowed) {
        setLanError(preview.message);
        return;
      }
      if (preview.conflict) {
        setLanRestartMode('immediate');
        setLanConflict(preview.conflict);
        return;
      }
      await applyLanBroadcast({ enabled: true });
    } catch (err) {
      setLanError(err.response?.data?.error || err.message || 'Failed to update LAN listing');
    } finally {
      setLanBusy(false);
    }
  };

  const handleAction = async (action) => {
    setActions(prev => ({ ...prev, [action]: true }));
    setError('');
    try {
      switch (action) {
        case 'start':
          await serverApi.start(id);
          break;
        case 'stop':
          await serverApi.stop(id);
          break;
        case 'restart':
          await serverApi.restart(id);
          break;
        default:
          break;
      }
      await loadServer();
      await refresh();
    } catch (err) {
      console.error(`Failed to ${action} server:`, err);
      setError(err.response?.data?.error || err.message || `Failed to ${action} server`);
    } finally {
      setActions(prev => ({ ...prev, [action]: false }));
    }
  };

  const sendCommand = async (cmd) => {
    if (server?.kind === 'bedrock_connect' || server?.kind === 'remote') return;
    if (!cmd.trim()) return;
    const trimmedCommand = cmd.trim();
    addServerOutput(id, `[You] ${trimmedCommand}`);
    const nextHistory = [...commandHistory, trimmedCommand].slice(-50);
    setCommandHistory(nextHistory);
    localStorage.setItem(`mcmanager-command-history-${id}`, JSON.stringify(nextHistory));
    setHistoryIndex(null);
    setCommand('');

    try {
      await serverApi.command(id, trimmedCommand);
    } catch (err) {
      addServerOutput(id, `[Error] ${err.response?.data?.error || err.message}`);
    }
  };

  const handleCommandKeyDown = (event) => {
    if (event.key === 'Enter') {
      sendCommand(command);
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (commandHistory.length === 0) return;

    if (event.key === 'ArrowUp') {
      const nextIndex = historyIndex == null
        ? commandHistory.length - 1
        : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setCommand(commandHistory[nextIndex]);
    } else if (historyIndex != null) {
      const nextIndex = historyIndex + 1;
      if (nextIndex >= commandHistory.length) {
        setHistoryIndex(null);
        setCommand('');
      } else {
        setHistoryIndex(nextIndex);
        setCommand(commandHistory[nextIndex]);
      }
    }
  };

  const handleRemoveMod = (mod) => {
    if (!mod?.id || gameplayLocked || busyModId) return;
    setRemoveModModal(mod);
  };

  const confirmRemoveMod = async () => {
    const mod = removeModModal;
    if (!mod || busyModId) return;
    setRemoveModModal(null);
    setRemovingModId(mod.id);
    setBusyModId(mod.id);
    setModMessage(null);
    try {
      await modApi.uninstall(mod.id, id);
      await loadServer();
      await refresh();
      setModMessage({ type: 'success', text: `${mod.name} was removed from this server.` });
    } catch (err) {
      setModMessage({ type: 'error', text: err.response?.data?.error || err.message });
    } finally {
      setRemovingModId(null);
      setBusyModId(null);
    }
  };

  const openManageMods = async () => {
    setShowManageMods(true);
    setLibrarySearch('');
    setModMessage(null);
    setLibraryLoading(true);
    try {
      const res = await modApi.getAll();
      setLibraryMods(res.data || []);
    } catch (err) {
      setModMessage({ type: 'error', text: err.response?.data?.error || err.message || 'Failed to load mods' });
    } finally {
      setLibraryLoading(false);
    }
  };

  const handleInstallMod = async (mod) => {
    if (busyModId) return;
    setBusyModId(mod.id);
    setModMessage(null);
    try {
      await modApi.install(mod.id, id);
      await loadServer();
      await refresh();
      setModMessage({ type: 'success', text: `${mod.name} was installed on this server.` });
    } catch (err) {
      setModMessage({ type: 'error', text: err.response?.data?.error || err.message });
    } finally {
      setBusyModId(null);
    }
  };

  const handleUpdate = async () => {
    setUpdateError('');
    try {
      await serverApi.updateVersion(id, updateVersion);
      setShowUpdateModal(false);
      loadServer();
    } catch (err) {
      setUpdateError(err.response?.data?.error || err.message || 'Update failed');
    }
  };

  const openUpdateModal = async () => {
    if (server?.kind === 'remote') return;
    setUpdateError('');
    setUpdateVersion('latest');
    setShowUpdateModal(true);
    if (server?.kind === 'bedrock_connect') {
      try {
        const res = await serverApi.bedrockConnectVersions();
        setUpdateVersions((res.data?.stored || []).map(item => item.tag).filter(Boolean));
      } catch {
        setUpdateVersions([]);
      }
      return;
    }
    setUpdateVersions(['1.20.80', '1.20.70', '1.20.60']);
  };

  const handleWarnedRestart = async () => {
    if (!confirm('Schedule a restart in 5 minutes and warn all connected players at 5, 2, and 1 minutes?')) return;
    setRestartScheduling(true);
    setError('');
    try {
      await serverApi.restartWithWarning(id);
      await loadServer();
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setRestartScheduling(false);
    }
  };

  const handleCancelWarnedRestart = async () => {
    setRestartScheduling(true);
    try {
      await serverApi.cancelWarnedRestart(id);
      await loadServer();
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setRestartScheduling(false);
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'running':
        return <span className="badge badge-success"><span className="w-1.5 h-1.5 bg-green-400 rounded-full mr-1.5" />Online</span>;
      case 'starting':
        return <span className="badge badge-warning"><span className="w-1.5 h-1.5 bg-yellow-400 rounded-full mr-1.5 animate-pulse" />Starting</span>;
      case 'stopped':
        return <span className="badge badge-danger"><span className="w-1.5 h-1.5 bg-red-400 rounded-full mr-1.5" />Offline</span>;
      default:
        return <span className="badge badge-info">{status}</span>;
    }
  };

  const getRemoteReachableBadge = () => {
    if (!server || server.kind !== 'remote' || server.status !== 'running' || typeof server.remoteReachable !== 'boolean') {
      return null;
    }
    if (server.remoteReachable) {
      return (
        <span className="badge badge-success">
          <span className="w-1.5 h-1.5 bg-green-400 rounded-full mr-1.5" />
          Remote Online
        </span>
      );
    }
    return (
      <span className="badge badge-danger">
        <span className="w-1.5 h-1.5 bg-red-400 rounded-full mr-1.5" />
        Remote Offline
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-mc-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-mc-textMuted">Loading server details...</p>
        </div>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="p-4 md:p-6 text-center">
        <AlertCircle className="w-12 h-12 text-mc-textMuted mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-white mb-2">Server not found</h2>
        <button onClick={() => navigate('/servers')} className="btn btn-secondary mt-4">
          <ArrowLeft className="w-4 h-4" /> Back to Dashboard
        </button>
      </div>
    );
  }

  const isBC = server.kind === 'bedrock_connect';
  const isRemote = server.kind === 'remote';
  const gameplayLocked = isBC || isRemote;
  const isBuilding = server.status === 'creating';
  const createFailed = String(server.pending_restart_reason || '').startsWith('Create failed');
  const lan = server.stats?.lan || server.lan || {};
  const lanOn = Boolean(lan.native || lan.enabled);
  const bcRunning = servers.some(item => item.kind === 'bedrock_connect' && (item.status === 'running' || item.status === 'starting'));
  const lanLocked = isBC || lan.native || bcRunning || isBuilding;
  const connectLabel = server.connectAddress || `Port ${server.port}`;
  const onlinePlayers = Array.isArray(server.onlinePlayers) ? server.onlinePlayers : [];

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      {/* Header */}
      {isBC && (
        <div className="mb-4 p-3 bg-mc-darker border border-mc-surfaceLight rounded-lg text-sm text-mc-textMuted">
          Bedrock Connect supports start, stop, restart, JAR updates, and auto-update. Console commands, port, players, and mods do not apply.
        </div>
      )}
      {isRemote && (
        <div className="mb-4 p-3 bg-mc-darker border border-mc-surfaceLight rounded-lg text-sm text-mc-textMuted">
          This is a UDP gateway to another Bedrock host. Start/stop, LAN listing, and local/remote ports can be changed. Console, players, mods, and updates are not available.
        </div>
      )}
      {location.state?.message && (
        <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-2 text-sm text-green-400">
          <Check className="w-4 h-4" /> {location.state.message}
        </div>
      )}
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2 text-sm text-red-400">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}
      {lanError && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2 text-sm text-red-400">
          <AlertCircle className="w-4 h-4" /> {lanError}
        </div>
      )}
      {lanMessage && (
        <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-2 text-sm text-green-400">
          <Check className="w-4 h-4" /> {lanMessage}
        </div>
      )}
      {isBuilding && (
        <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg flex items-start gap-2 text-sm text-yellow-300">
          <Loader2 className="w-4 h-4 mt-0.5 flex-shrink-0 animate-spin" />
          <div>
            <p className="font-medium">Building Server</p>
            <p className="text-xs mt-1">Downloading Minecraft Bedrock Dedicated Server. Start and LAN unlock when this finishes.</p>
          </div>
        </div>
      )}
      {createFailed && server.pending_restart !== 1 && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-2 text-sm text-red-400">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {server.pending_restart_reason}
        </div>
      )}
      {server.pending_restart === 1 && (
        <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-start gap-2 text-sm text-amber-300">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Restart required</p>
            <p className="text-xs mt-1">
              {server.pending_restart_reason || 'Server changes'} will not be applied until this server restarts.
            </p>
          </div>
        </div>
      )}
      {server.pending_port && (
        <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm text-blue-300">
          IPv4 port will change from {server.port} to {server.pending_port} after the next restart.
        </div>
      )}
      {server.pending_ipv6_port && (
        <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm text-blue-300">
          IPv6 port will change from {server.ipv6_port || 'unset'} to {server.pending_ipv6_port} after the next restart.
        </div>
      )}
      {server.restart_scheduled_at && (
        <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm text-blue-300">
          Warned restart scheduled for {new Date(server.restart_scheduled_at).toLocaleTimeString()}.
        </div>
      )}
      <div className="page-header flex items-center justify-between mb-6">
        <div className="flex items-center gap-4 min-w-0">
          <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors flex-shrink-0">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-white break-words">{server.name}</h1>
              <div className="flex flex-col items-start gap-1">
                {getStatusBadge(server.status)}
                {getRemoteReachableBadge()}
              </div>
              {isBC && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/30">
                  Console list
                </span>
              )}
              {isRemote && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30">
                  Remote
                </span>
              )}
              {lan.active && !lan.native && !isBC && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30">
                  LAN
                </span>
              )}
              {lan.native && !isBC && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30">
                  LAN native
                </span>
              )}
            </div>
            <p className="text-mc-textMuted mt-1 break-words">
              {isRemote
                ? <>{server.remote_host || 'Remote'}{server.remote_ipv4_port ? `:${server.remote_ipv4_port}` : ''} • {connectLabel}</>
                : <>v{server.version} • {connectLabel} • {server.gamemode} • {server.difficulty}</>}
            </p>
          </div>
        </div>
        <div className="page-header-actions flex items-center gap-2">
          {!isRemote && (
            <button
              onClick={openUpdateModal}
              className="btn btn-secondary text-sm"
              title="Update server"
            >
              <Download className="w-4 h-4" />
              Update
            </button>
          )}
          {!gameplayLocked && (
            <button
              onClick={() => navigate(`/servers/${id}/users`)}
              className="btn btn-secondary text-sm"
              title="Manage player permissions for this server"
            >
              <Users className="w-4 h-4" />
              Users
            </button>
          )}
          <button
            onClick={() => navigate(`/servers/${id}/properties`)}
            className="btn btn-secondary text-sm"
          >
            <Settings className="w-4 h-4" />
            Properties
          </button>
        </div>
      </div>

      {!isBC && (
        <div className="card mb-6">
          <div className="flex items-start justify-between gap-4 max-md:flex-col">
            <div>
              <h2 className="font-semibold text-white flex items-center gap-2">
                <Radio className="w-4 h-4 text-sky-400" />
                Console LAN listing
              </h2>
              <p className="text-sm text-mc-textMuted mt-1">
                Show this server under Friends → LAN Games on Xbox, PlayStation, Windows, iOS, and Android.
                Nintendo Switch is not supported by this method; use Bedrock Connect for Switch.
              </p>
              {lan.native && (
                <p className="text-xs text-sky-300 mt-2">
                  This server already uses UDP 19132, so consoles on the same LAN can see it without a proxy.
                </p>
              )}
              {lan.active && lan.proxyPort && !lan.native && (
                <p className="text-xs text-mc-textMuted mt-2">
                  Proxy on UDP {lan.proxyPort}. Consoles discover it on UDP {lan.discoveryPort || 19132}.
                </p>
              )}
              {lan.error && !/Stop or remove Bedrock Connect/i.test(lan.error) && (
                <p className="text-xs text-red-400 mt-2">{lan.error}</p>
              )}
            </div>
            <button
              onClick={beginLanToggle}
              disabled={lanLocked || lanBusy}
              className={`btn text-sm flex-shrink-0 ${
                lanLocked
                  ? 'bg-mc-surfaceLight text-mc-textMuted'
                  : lanOn
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 hover:bg-sky-500/30'
                    : 'btn-secondary'
              }`}
              title={lanLocked
                ? (isBC
                  ? 'Bedrock Connect is not a LAN game'
                  : isBuilding
                    ? 'Wait until this server finishes building'
                    : lan.native
                    ? 'Already visible on LAN via UDP 19132'
                    : 'Stop or remove Bedrock Connect to start LAN proxy.')
                : (lanOn ? 'Turn off LAN listing' : 'Advertise this server as a LAN game')}
            >
              <Radio className="w-4 h-4" />
              {lanBusy ? 'Working...' : lanOn ? 'LAN on' : 'LAN off'}
            </button>
          </div>
        </div>
      )}

      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-green-500/20 rounded-lg flex items-center justify-center">
              <Users className="w-4 h-4 text-green-400" />
            </div>
            <div>
              <p className="text-xs text-mc-textMuted">Players</p>
              <p className={`text-lg font-bold ${gameplayLocked ? 'text-mc-textMuted' : 'text-white'}`}>{isRemote ? 'N/A' : `${onlinePlayers.length}/${server.max_players}`}</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-500/20 rounded-lg flex items-center justify-center">
              <Clock className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <p className="text-xs text-mc-textMuted">Uptime</p>
              <p className="text-lg font-bold text-white">{server.stats?.uptime || '0m'}</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-purple-500/20 rounded-lg flex items-center justify-center">
              <PackageIcon className="w-4 h-4 text-purple-400" />
            </div>
            <div>
              <p className="text-xs text-mc-textMuted">Mods</p>
              <p className={`text-lg font-bold ${gameplayLocked ? 'text-mc-textMuted' : 'text-white'}`}>{isRemote ? 'N/A' : (server.installedMods?.length || 0)}</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              connected ? 'bg-green-500/20' : 'bg-red-500/20'
            }`}>
              <Terminal className={`w-4 h-4 ${connected ? 'text-green-400' : 'text-red-400'}`} />
            </div>
            <div>
              <p className="text-xs text-mc-textMuted">Console</p>
              <p className={`text-sm font-bold ${connected ? 'text-green-400' : 'text-red-400'}`}>
                {connected ? 'Connected' : 'Offline'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Server Actions */}
      <div className="page-actions flex items-center gap-3 mb-6">
        {server.status === 'creating' ? (
          <button disabled className="btn btn-primary">
            <Loader2 className="w-4 h-4 animate-spin" /> Building Server...
          </button>
        ) : server.status === 'starting' ? (
          <button disabled className="btn btn-primary">
            <Loader2 className="w-4 h-4 animate-spin" /> Starting...
          </button>
        ) : server.status !== 'running' ? (
          <button
            onClick={() => handleAction('start')}
            disabled={actions.start}
            className="btn btn-primary"
          >
            <Play className="w-4 h-4" />
            {actions.start ? 'Starting...' : 'Start Server'}
          </button>
        ) : (
          <>
            <button
              onClick={() => handleAction('stop')}
              disabled={actions.stop}
              className="btn btn-danger"
            >
              <Square className="w-4 h-4" />
              {actions.stop ? 'Stopping...' : 'Stop Server'}
            </button>
            <button
              onClick={() => handleAction('restart')}
              disabled={actions.restart}
              className="btn btn-secondary"
            >
              <RotateCcw className="w-4 h-4" />
              Restart
            </button>
            {server.restart_scheduled_at ? (
              <button
                onClick={handleCancelWarnedRestart}
                disabled={restartScheduling}
                className="btn btn-secondary"
              >
                {restartScheduling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />}
                Cancel Warned Restart
              </button>
            ) : !gameplayLocked ? (
              <button
                onClick={handleWarnedRestart}
                disabled={restartScheduling}
                className="btn btn-secondary"
              >
                {restartScheduling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />}
                Restart with Warning
              </button>
            ) : null}
          </>
        )}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Terminal - Takes 2 columns */}
        <div className="lg:col-span-2 space-y-6">
          {isRemote ? (
            <div className="card text-sm text-mc-textMuted">
              <h2 className="font-semibold text-white mb-2">UDP gateway</h2>
              <p>
                This manager forwards local UDP traffic to {server.remote_host || 'the remote host'}
                {server.remote_ipv4_port ? `:${server.remote_ipv4_port}` : ''}.
                Console, players, mods, allow lists, and updates stay on the remote Bedrock server.
              </p>
            </div>
          ) : (
          <>
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-white flex items-center gap-2">
                <Terminal className="w-4 h-4" />
                Server Console
              </h2>
              <button
                onClick={() => setShowTerminal(!showTerminal)}
                className="p-1 hover:bg-mc-surfaceLight rounded transition-colors"
              >
                {showTerminal ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            </div>
            
            {showTerminal && (
              <div className="animate-slide-up">
                <div
                  ref={terminalRef}
                  className="terminal overflow-y-auto mb-3 h-56 md:h-[14.5rem]"
                >
                  {terminalOutput.length === 0 ? (
                    <div className="text-mc-textMuted text-center py-8">
                      {server.status === 'running' 
                        ? 'Server console output will appear here...'
                        : 'Start the server to see console output'}
                    </div>
                  ) : (
                    terminalOutput.map((line, i) => (
                      <div key={i} className="terminal-output">
                        {line}
                      </div>
                    ))
                  )}
                </div>
                
                {server.status === 'running' && (
                  <div className={`flex items-center gap-2 ${gameplayLocked ? 'opacity-50' : ''}`}>
                    <span className="terminal-prompt">{'>'}</span>
                    <input
                      type="text"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      onKeyDown={handleCommandKeyDown}
                      placeholder={gameplayLocked ? 'Commands are not available for this server' : 'Enter command...'}
                      className="terminal-input flex-1"
                      disabled={gameplayLocked || server.status !== 'running'}
                    />
                    <button
                      onClick={() => sendCommand(command)}
                      disabled={gameplayLocked}
                      className="p-2 hover:bg-mc-surfaceLight rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className={`card ${gameplayLocked ? 'opacity-60' : ''}`}>
            <h2 className="font-semibold text-white flex items-center gap-2 mb-2">
              <Shield className="w-4 h-4" />
              Allow List & Player Permissions
            </h2>
            <p className="text-xs text-mc-textMuted mb-4">
              These settings apply only to {server.name}. Changing a player&apos;s permission here also
              updates the Users list. Players without a custom permission use the default from Properties.
              Being on this allow list is separate from the Users permission list.
            </p>
            {accessMessage && (
              <div className={`mb-4 p-3 rounded-lg border text-sm ${accessMessage.type === 'error'
                ? 'bg-red-500/10 border-red-500/30 text-red-400'
                : 'bg-green-500/10 border-green-500/30 text-green-400'}`}>
                {accessMessage.text}
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-2 mb-4">
              <PlayerCombobox
                value={allowQuery}
                onChange={setAllowQuery}
                options={playerAccess.filter(player => !player.is_whitelisted && !player.is_banned)}
                disabled={gameplayLocked}
                placeholder="Type a player name..."
                onEnter={addAllowPlayer}
              />
              <button
                onClick={addAllowPlayer}
                disabled={gameplayLocked || !allowQuery.trim() || accessBusy}
                className="btn btn-primary"
              >
                <UserPlus className="w-4 h-4" /> Add Player
              </button>
            </div>
            <div className="space-y-2">
              {playerAccess.filter(player => player.is_whitelisted).length === 0 ? (
                <p className="text-sm text-mc-textMuted text-center py-4">No players are on this server's allow list</p>
              ) : playerAccess.filter(player => player.is_whitelisted).map(player => (
                <div key={player.id} className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 bg-mc-darker rounded-lg">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{player.username}</p>
                    <p className="text-xs text-mc-textMuted">{player.xuid ? `XUID: ${player.xuid}` : 'XUID will be captured when the player joins'}</p>
                  </div>
                  <select
                    value={player.permission}
                    onChange={(e) => updatePlayerAccess(player.id, { permission: e.target.value, hasCustomPermission: true }, `${player.username}'s permission updated.`)}
                    disabled={gameplayLocked || accessBusy}
                    className="input sm:w-36 text-sm"
                    aria-label={`Permission for ${player.username}`}
                  >
                    <option value="visitor">Visitor</option>
                    <option value="member">Member</option>
                    <option value="operator">Operator</option>
                  </select>
                  <button
                    onClick={() => updatePlayerAccess(player.id, { isWhitelisted: false }, `${player.username} removed from this server allow list.`)}
                    disabled={gameplayLocked || accessBusy}
                    className="btn btn-secondary text-sm text-mc-danger"
                    title="Remove from this server's allow list"
                  >
                    <ShieldOff className="w-4 h-4" /> Remove
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Per-server ban list */}
          <div className={`card ${gameplayLocked ? 'opacity-60' : ''}`}>
            <h2 className="font-semibold text-white flex items-center gap-2 mb-2">
              <Ban className="w-4 h-4 text-red-400" />
              Ban List
            </h2>
            <p className="text-xs text-mc-textMuted mb-4">Banned players are removed from this server's allow list and kicked if they connect.</p>
            <div className="flex flex-col sm:flex-row gap-2 mb-4">
              <PlayerCombobox
                value={banQuery}
                onChange={setBanQuery}
                options={playerAccess.filter(player => !player.is_banned)}
                disabled={gameplayLocked}
                placeholder="Type a player name..."
                onEnter={addBanPlayer}
              />
              <button
                onClick={addBanPlayer}
                disabled={gameplayLocked || !banQuery.trim() || accessBusy}
                className="btn btn-danger"
              >
                <Ban className="w-4 h-4" /> Ban Player
              </button>
            </div>
            <div className="space-y-2">
              {playerAccess.filter(player => player.is_banned).length === 0 ? (
                <p className="text-sm text-mc-textMuted text-center py-4">No players are banned from this server</p>
              ) : playerAccess.filter(player => player.is_banned).map(player => (
                <div key={player.id} className="flex items-center gap-3 p-3 bg-mc-darker rounded-lg">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{player.username}</p>
                    <p className="text-xs text-mc-textMuted truncate">
                      {player.is_globally_banned
                        ? 'Banned on all servers'
                        : (player.ban_reason || 'Banned by server administrator')}
                    </p>
                  </div>
                  <button
                    onClick={() => updatePlayerAccess(player.id, { isBanned: false }, `${player.username} unbanned from this server.`)}
                    disabled={gameplayLocked || accessBusy || player.is_globally_banned}
                    className="btn btn-secondary text-sm"
                    title={player.is_globally_banned
                      ? 'This player is banned on all servers. Remove the global ban from Player Management.'
                      : 'Unban from this server'}
                  >
                    Unban
                  </button>
                </div>
              ))}
            </div>
          </div>
          </>
          )}
        </div>

        {/* Right sidebar - Players & Mods */}
        <div className="space-y-6">
          {!isRemote && (
          <>
          {/* Online Players */}
          <div className={`card ${gameplayLocked ? 'opacity-60' : ''}`}>
            <button
              onClick={() => setShowPlayers(!showPlayers)}
              className="w-full flex items-center justify-between"
            >
              <h2 className="font-semibold text-white flex items-center gap-2">
                <Users className="w-4 h-4" />
                Online Players
              </h2>
              {showPlayers ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            
            {showPlayers && (
              <div className="mt-3 space-y-2 animate-slide-up">
                {onlinePlayers.length === 0 ? (
                  <p className="text-sm text-mc-textMuted text-center py-4">No players online</p>
                ) : (
                  onlinePlayers.map(player => (
                    <div key={player.id} className="flex items-center gap-3 p-2 bg-mc-darker rounded-lg">
                      <div className="w-8 h-8 bg-mc-surfaceLight rounded-full flex items-center justify-center">
                        <span className="text-xs font-bold text-mc-textMuted">
                          {player.username?.charAt(0)?.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">{player.username}</p>
                        <p className="text-xs text-mc-textMuted">
                          Joined {new Date(player.joined_at).toLocaleTimeString()}
                        </p>
                      </div>
                      <div className="w-2 h-2 bg-green-400 rounded-full" />
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Installed Mods */}
          <div className={`card ${gameplayLocked ? 'opacity-60' : ''}`}>
            <button
              onClick={() => setShowMods(!showMods)}
              className="w-full flex items-center justify-between"
            >
              <h2 className="font-semibold text-white flex items-center gap-2">
                <PackageIcon className="w-4 h-4" />
                Installed Mods
              </h2>
              {showMods ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            
            {showMods && (
              <div className="mt-3 space-y-2 animate-slide-up max-h-64 overflow-y-auto">
                {modMessage && (
                  <div className={`p-2 rounded border text-xs ${modMessage.type === 'error'
                    ? 'bg-red-500/10 border-red-500/30 text-red-400'
                    : 'bg-green-500/10 border-green-500/30 text-green-400'}`}>
                    {modMessage.text}
                  </div>
                )}
                {server.installedMods?.length === 0 ? (
                  <p className="text-sm text-mc-textMuted text-center py-4">No mods installed</p>
                ) : (
                  server.installedMods.map(mod => {
                    const thumb = modThumbnailSrc(mod);
                    return (
                    <div key={mod.id} className="flex items-center gap-3 p-2 bg-mc-darker rounded-lg">
                      <div className="w-8 h-8 bg-mc-surfaceLight rounded flex items-center justify-center flex-shrink-0 overflow-hidden">
                        {thumb ? (
                          <img src={thumb} alt="" className="mod-thumbnail-img" />
                        ) : (
                          <PackageIcon className="w-4 h-4 text-mc-textMuted" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">{mod.name}</p>
                        <p className="text-xs text-mc-textMuted capitalize">{mod.type}</p>
                      </div>
                      <button
                        onClick={() => handleRemoveMod(mod)}
                        disabled={gameplayLocked || removingModId === mod.id || Boolean(busyModId)}
                        className="p-2 text-mc-textMuted hover:text-red-400 hover:bg-red-500/10 rounded transition-colors disabled:opacity-50"
                        title="Remove from this server only"
                        aria-label={`Remove ${mod.name} from this server`}
                      >
                        {removingModId === mod.id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Trash2 className="w-4 h-4" />}
                      </button>
                    </div>
                    );
                  })
                )}
                <button
                  onClick={openManageMods}
                  disabled={gameplayLocked}
                  className="w-full btn btn-secondary text-sm mt-2"
                >
                  Manage Mods
                </button>
              </div>
            )}
          </div>
          </>
          )}

          {/* Server Info */}
          <div className="card">
            <h2 className="font-semibold text-white mb-3">Server Info</h2>
            <div className="space-y-2 text-sm">
              {!isRemote && <InfoRow label="Version" value={server.version} />}
              <InfoRow label="Address" value={connectLabel} />
              <InfoRow label={isRemote ? 'Local IPv4 Port' : 'IPv4 Port'} value={server.pending_port ? `${server.port} → ${server.pending_port}` : server.port} />
              <InfoRow label={isRemote ? 'Local IPv6 Port' : 'IPv6 Port'} value={server.pending_ipv6_port ? `${server.ipv6_port || 'unset'} → ${server.pending_ipv6_port}` : (server.ipv6_port || 'unset')} />
              {isRemote && (
                <>
                  <InfoRow label="Remote Host" value={server.remote_host || 'N/A'} />
                  <InfoRow label="Remote IPv4 Port" value={server.remote_ipv4_port || 'N/A'} />
                  <InfoRow label="Remote IPv6 Port" value={server.remote_ipv6_port || 'N/A'} />
                </>
              )}
              <InfoRow label="LAN listing" value={isBC ? 'n/a' : (lan.native ? 'Native (19132)' : (lan.active && lan.enabled) ? 'On' : (lan.enabled && bcRunning) ? 'Paused' : 'Off')} />
              {!isRemote && (
                <>
                  <InfoRow label="Max Players" value={server.max_players} />
                  <InfoRow label="Game Mode" value={server.gamemode} />
                  <InfoRow label="Difficulty" value={server.difficulty} />
                  <InfoRow label="Auto-Update" value={autoUpdateEnabled ? 'Enabled' : 'Disabled'} />
                  <InfoRow label="Created" value={new Date(server.created_at).toLocaleDateString()} />
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Update Modal */}
      {showUpdateModal && !isRemote && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <h3 className="text-lg font-semibold text-white mb-4">Update Server</h3>
            <p className="text-sm text-mc-textMuted mb-4">
              {isBC
                ? 'This will update the Bedrock Connect JAR. Choose Latest or a stored version. Older JARs stay on disk if they drop off this list.'
                : 'This will update the server binary while preserving your addons, worlds, and configuration.'}
            </p>
            {updateError && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
                {updateError}
              </div>
            )}
            <div className="mb-4">
              <label className="block text-sm font-medium text-mc-text mb-2">Target Version</label>
              <select
                value={updateVersion}
                onChange={(e) => setUpdateVersion(e.target.value)}
                className="input"
              >
                <option value="latest">Latest</option>
                {updateVersions.map((version) => (
                  <option key={version} value={version}>{version}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleUpdate}
                className="btn btn-primary flex-1"
              >
                <Download className="w-4 h-4" />
                Update
              </button>
              <button
                onClick={() => setShowUpdateModal(false)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {removeModModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[80] p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Remove mod</h3>
              <button
                onClick={() => setRemoveModModal(null)}
                className="p-1 hover:bg-mc-surfaceLight rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-mc-textMuted mb-4">
              Remove <strong className="text-white">{removeModModal.name}</strong> from{' '}
              <strong className="text-white">{server.name}</strong>? It will remain in the manager's mod library.
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={confirmRemoveMod}
                className="btn btn-primary flex-1"
              >
                Yes
              </button>
              <button
                onClick={() => setRemoveModModal(null)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showManageMods && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4">
          <div className="card max-w-lg w-full max-h-[85vh] flex flex-col animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Manage Mods</h3>
              <button
                onClick={() => setShowManageMods(false)}
                className="p-1 hover:bg-mc-surfaceLight rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-mc-textMuted mb-3">
              Install or remove library packs on <strong className="text-white">{server.name}</strong>.
            </p>

            {modMessage && (
              <div className={`mb-3 p-2 rounded border text-xs ${modMessage.type === 'error'
                ? 'bg-red-500/10 border-red-500/30 text-red-400'
                : 'bg-green-500/10 border-green-500/30 text-green-400'}`}>
                {modMessage.text}
              </div>
            )}

            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mc-textMuted" />
              <input
                type="text"
                value={librarySearch}
                onChange={(e) => setLibrarySearch(e.target.value)}
                className="input pl-10"
                placeholder="Search library..."
              />
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 min-h-[12rem]">
              {libraryLoading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="w-6 h-6 text-mc-accent animate-spin" />
                </div>
              ) : libraryMods.length === 0 ? (
                <p className="text-sm text-mc-textMuted text-center py-8">No mods in the library yet.</p>
              ) : (
                libraryMods
                  .filter((mod) => !librarySearch || mod.name.toLowerCase().includes(librarySearch.toLowerCase()))
                  .map((mod) => {
                    const installed = Boolean(server.installedMods?.some((row) => row.id === mod.id));
                    const thumb = modThumbnailSrc(mod);
                    const busy = busyModId === mod.id;
                    const removing = busy && removingModId === mod.id;
                    return (
                      <div
                        key={mod.id}
                        className="flex items-center gap-3 p-2 bg-mc-darker rounded-lg"
                      >
                        <div className="w-10 h-10 bg-mc-surfaceLight rounded flex items-center justify-center flex-shrink-0 overflow-hidden">
                          {thumb ? (
                            <img src={thumb} alt="" className="mod-thumbnail-img" />
                          ) : (
                            <PackageIcon className="w-4 h-4 text-mc-textMuted" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-white truncate">{mod.name}</p>
                          <p className="text-xs text-mc-textMuted capitalize">
                            {(mod.type || 'addon').replace('_', ' ')}
                          </p>
                        </div>
                        {busy ? (
                          <button
                            type="button"
                            disabled
                            className="btn text-xs px-3 py-1.5 bg-yellow-500 hover:bg-yellow-500 text-yellow-950 cursor-not-allowed disabled:opacity-100"
                          >
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            {removing ? 'Removing' : 'Installing'}
                          </button>
                        ) : installed ? (
                          <button
                            type="button"
                            onClick={() => handleRemoveMod(mod)}
                            disabled={Boolean(busyModId)}
                            className="btn btn-danger text-xs px-3 py-1.5"
                          >
                            Remove
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleInstallMod(mod)}
                            disabled={Boolean(busyModId)}
                            className="btn text-xs px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Install
                          </button>
                        )}
                      </div>
                    );
                  })
              )}
            </div>
          </div>
        </div>
      )}

      {lanConflict && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-lg w-full animate-slide-up">
            <h3 className="text-lg font-semibold text-white mb-3">Move server off port 19132?</h3>
            <p className="text-sm text-mc-textMuted mb-4">
              Consoles look for LAN games on UDP <span className="font-mono text-white">19132</span>.
              <span className="text-white"> {lanConflict.serverName}</span> currently uses that port and will be moved to{' '}
              <span className="font-mono text-white">{lanConflict.nextPort}</span>.
              That server will also be listed on LAN so it does not disappear from consoles.
            </p>
            {lanConflict.status === 'running' ? (
              <div className="mb-4 space-y-2">
                <p className="text-sm font-medium text-white">When should that server restart?</p>
                <label className="flex items-start gap-3 p-3 bg-mc-darker rounded-lg cursor-pointer">
                  <input
                    type="radio"
                    name="detail-lan-restart-mode"
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
                    name="detail-lan-restart-mode"
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
                onClick={() => applyLanBroadcast({
                  enabled: true,
                  acceptConflict: true,
                  restartMode: lanConflict.status === 'running' ? lanRestartMode : 'immediate',
                })}
                disabled={lanBusy}
                className="btn bg-sky-500 hover:bg-sky-600 text-white flex-1"
              >
                {lanBusy ? 'Working...' : 'Accept and continue'}
              </button>
              <button
                onClick={() => setLanConflict(null)}
                disabled={lanBusy}
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

function modThumbnailSrc(mod) {
  if (!mod?.thumbnail) return '';
  const value = String(mod.thumbnail);
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/api/')) {
    return value;
  }
  return `/api/mods/${mod.id}/thumbnail?v=${encodeURIComponent(mod.downloaded_at || mod.id)}`;
}

function InfoRow({ label, value }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-mc-surfaceLight/50 last:border-0">
      <span className="text-mc-textMuted">{label}</span>
      <span className="text-white font-medium capitalize">{value}</span>
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

export default ServerDetail;
