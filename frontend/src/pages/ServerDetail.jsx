import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { serverApi, modApi, playerApi } from '../services/api';
import { useApi } from '../context/ApiContext';
import { useSocket } from '../context/SocketContext';
import {
  ArrowLeft, Play, Square, RotateCcw, Terminal, Send, Users,
  Settings, ArrowUpRight, Clock, Package, ChevronDown, ChevronUp,
  Copy, Trash2, Download, AlertCircle, AlertTriangle, Check, Loader2,
  Shield, ShieldOff, Ban, UserPlus
} from 'lucide-react';

function ServerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useApi();
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
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(false);
  const [playerAccess, setPlayerAccess] = useState([]);
  const [selectedAllowPlayer, setSelectedAllowPlayer] = useState('');
  const [selectedBanPlayer, setSelectedBanPlayer] = useState('');
  const [accessMessage, setAccessMessage] = useState(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [removingModId, setRemovingModId] = useState(null);
  const [modMessage, setModMessage] = useState(null);
  const [restartScheduling, setRestartScheduling] = useState(false);
  const terminalRef = useRef(null);
  const terminalOutput = serverOutputs[String(id)] || [];

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
      setSelectedAllowPlayer('');
      setSelectedBanPlayer('');
      setAccessMessage({ type: 'success', text: message });
    } catch (err) {
      setAccessMessage({ type: 'error', text: err.response?.data?.error || err.message });
    } finally {
      setAccessBusy(false);
    }
  };

  const handleAction = async (action) => {
    setActions(prev => ({ ...prev, [action]: true }));
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
    } finally {
      setActions(prev => ({ ...prev, [action]: false }));
    }
  };

  const sendCommand = async (cmd) => {
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

  const handleRemoveMod = async (mod) => {
    if (!confirm(`Remove "${mod.name}" from ${server.name}? It will remain in the manager's mod library.`)) return;
    setRemovingModId(mod.id);
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
    }
  };

  const handleUpdate = async () => {
    try {
      await serverApi.updateVersion(id, updateVersion);
      setShowUpdateModal(false);
      loadServer();
    } catch (err) {
      console.error('Update failed:', err);
    }
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
      <div className="p-6 text-center">
        <AlertCircle className="w-12 h-12 text-mc-textMuted mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-white mb-2">Server not found</h2>
        <button onClick={() => navigate('/servers')} className="btn btn-secondary mt-4">
          <ArrowLeft className="w-4 h-4" /> Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
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
      {server.restart_scheduled_at && (
        <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm text-blue-300">
          Warned restart scheduled for {new Date(server.restart_scheduled_at).toLocaleTimeString()}.
        </div>
      )}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-white">{server.name}</h1>
              {getStatusBadge(server.status)}
            </div>
            <p className="text-mc-textMuted mt-1">v{server.version} • Port {server.port} • {server.gamemode} • {server.difficulty}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowUpdateModal(true)}
            className="btn btn-secondary text-sm"
          >
            <Download className="w-4 h-4" />
            Update
          </button>
          <button
            onClick={() => navigate(`/servers/${id}/properties`)}
            className="btn btn-secondary text-sm"
          >
            <Settings className="w-4 h-4" />
            Properties
          </button>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-green-500/20 rounded-lg flex items-center justify-center">
              <Users className="w-4 h-4 text-green-400" />
            </div>
            <div>
              <p className="text-xs text-mc-textMuted">Players</p>
              <p className="text-lg font-bold text-white">{server.onlinePlayers?.length || 0}/{server.max_players}</p>
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
              <p className="text-lg font-bold text-white">{server.installedMods?.length || 0}</p>
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
      <div className="flex items-center gap-3 mb-6">
        {server.status === 'starting' ? (
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
            ) : (
              <button
                onClick={handleWarnedRestart}
                disabled={restartScheduling}
                className="btn btn-secondary"
              >
                {restartScheduling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />}
                Restart with Warning
              </button>
            )}
          </>
        )}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Terminal - Takes 2 columns */}
        <div className="lg:col-span-2 space-y-6">
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
                  className="terminal overflow-y-auto mb-3"
                  style={{ height: '14.5rem' }}
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
                  <div className="flex items-center gap-2">
                    <span className="terminal-prompt">{'>'}</span>
                    <input
                      type="text"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      onKeyDown={handleCommandKeyDown}
                      placeholder="Enter command..."
                      className="terminal-input flex-1"
                      disabled={server.status !== 'running'}
                    />
                    <button
                      onClick={() => sendCommand(command)}
                      className="p-2 hover:bg-mc-surfaceLight rounded transition-colors"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Per-server allowlist and individual permissions */}
          <div className="card">
            <h2 className="font-semibold text-white flex items-center gap-2 mb-2">
              <Shield className="w-4 h-4" />
              Allow List & Player Permissions
            </h2>
            <p className="text-xs text-mc-textMuted mb-4">
              These settings apply only to {server.name}. Permission changes are saved to this server's permissions file.
            </p>
            {accessMessage && (
              <div className={`mb-4 p-3 rounded-lg border text-sm ${accessMessage.type === 'error'
                ? 'bg-red-500/10 border-red-500/30 text-red-400'
                : 'bg-green-500/10 border-green-500/30 text-green-400'}`}>
                {accessMessage.text}
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-2 mb-4">
              <select
                value={selectedAllowPlayer}
                onChange={(e) => setSelectedAllowPlayer(e.target.value)}
                className="input flex-1"
              >
                <option value="">Select a console player...</option>
                {playerAccess.filter(player => !player.is_whitelisted && !player.is_banned).map(player => (
                  <option key={player.id} value={player.id}>{player.username}</option>
                ))}
              </select>
              <button
                onClick={() => updatePlayerAccess(selectedAllowPlayer, { isWhitelisted: true }, 'Player added to this server allow list.')}
                disabled={!selectedAllowPlayer || accessBusy}
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
                    onChange={(e) => updatePlayerAccess(player.id, { permission: e.target.value }, `${player.username}'s permission updated.`)}
                    disabled={accessBusy}
                    className="input sm:w-36 text-sm"
                    aria-label={`Permission for ${player.username}`}
                  >
                    <option value="visitor">Visitor</option>
                    <option value="member">Member</option>
                    <option value="operator">Operator</option>
                  </select>
                  <button
                    onClick={() => updatePlayerAccess(player.id, { isWhitelisted: false }, `${player.username} removed from this server allow list.`)}
                    disabled={accessBusy}
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
          <div className="card">
            <h2 className="font-semibold text-white flex items-center gap-2 mb-2">
              <Ban className="w-4 h-4 text-red-400" />
              Ban List
            </h2>
            <p className="text-xs text-mc-textMuted mb-4">Banned players are removed from this server's allow list and kicked if they connect.</p>
            <div className="flex flex-col sm:flex-row gap-2 mb-4">
              <select
                value={selectedBanPlayer}
                onChange={(e) => setSelectedBanPlayer(e.target.value)}
                className="input flex-1"
              >
                <option value="">Select a console player...</option>
                {playerAccess.filter(player => !player.is_banned).map(player => (
                  <option key={player.id} value={player.id}>{player.username}</option>
                ))}
              </select>
              <button
                onClick={() => updatePlayerAccess(selectedBanPlayer, { isBanned: true, banReason: 'Banned by server administrator' }, 'Player banned from this server.')}
                disabled={!selectedBanPlayer || accessBusy}
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
                    <p className="text-xs text-mc-textMuted truncate">{player.ban_reason || 'Banned by server administrator'}</p>
                  </div>
                  <button
                    onClick={() => updatePlayerAccess(player.id, { isBanned: false }, `${player.username} unbanned from this server.`)}
                    disabled={accessBusy}
                    className="btn btn-secondary text-sm"
                  >
                    Unban
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right sidebar - Players & Mods */}
        <div className="space-y-6">
          {/* Online Players */}
          <div className="card">
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
                {server.onlinePlayers?.length === 0 ? (
                  <p className="text-sm text-mc-textMuted text-center py-4">No players online</p>
                ) : (
                  server.onlinePlayers.map(player => (
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
          <div className="card">
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
                  server.installedMods.map(mod => (
                    <div key={mod.id} className="flex items-center gap-3 p-2 bg-mc-darker rounded-lg">
                      <div className="w-8 h-8 bg-mc-surfaceLight rounded flex items-center justify-center flex-shrink-0">
                        <PackageIcon className="w-4 h-4 text-mc-textMuted" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">{mod.name}</p>
                        <p className="text-xs text-mc-textMuted capitalize">{mod.type}</p>
                      </div>
                      <button
                        onClick={() => handleRemoveMod(mod)}
                        disabled={removingModId === mod.id}
                        className="p-2 text-mc-textMuted hover:text-red-400 hover:bg-red-500/10 rounded transition-colors disabled:opacity-50"
                        title="Remove from this server only"
                        aria-label={`Remove ${mod.name} from this server`}
                      >
                        {removingModId === mod.id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Trash2 className="w-4 h-4" />}
                      </button>
                    </div>
                  ))
                )}
                <button
                  onClick={() => navigate('/mods')}
                  className="w-full btn btn-secondary text-sm mt-2"
                >
                  Manage Mods
                </button>
              </div>
            )}
          </div>

          {/* Server Info */}
          <div className="card">
            <h2 className="font-semibold text-white mb-3">Server Info</h2>
            <div className="space-y-2 text-sm">
              <InfoRow label="Version" value={server.version} />
              <InfoRow label="Port" value={server.port} />
              <InfoRow label="Max Players" value={server.max_players} />
              <InfoRow label="Game Mode" value={server.gamemode} />
              <InfoRow label="Difficulty" value={server.difficulty} />
              <InfoRow label="Auto-Update" value={autoUpdateEnabled ? 'Enabled' : 'Disabled'} />
              <InfoRow label="Created" value={new Date(server.created_at).toLocaleDateString()} />
            </div>
          </div>
        </div>
      </div>

      {/* Update Modal */}
      {showUpdateModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <h3 className="text-lg font-semibold text-white mb-4">Update Server</h3>
            <p className="text-sm text-mc-textMuted mb-4">
              This will update the server binary while preserving your addons, worlds, and configuration.
            </p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-mc-text mb-2">Target Version</label>
              <select
                value={updateVersion}
                onChange={(e) => setUpdateVersion(e.target.value)}
                className="input"
              >
                <option value="latest">Latest</option>
                <option value="1.20.80">1.20.80</option>
                <option value="1.20.70">1.20.70</option>
                <option value="1.20.60">1.20.60</option>
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
    </div>
  );
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
