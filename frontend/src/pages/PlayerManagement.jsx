import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { playerApi } from '../services/api';
import { useApi } from '../context/ApiContext';
import {
  ArrowLeft, Users, Search, Plus, Shield, ShieldOff, Ban,
  AlertCircle, AlertTriangle, Check, Loader2, Scan, X
} from 'lucide-react';

function PlayerManagement() {
  const navigate = useNavigate();
  const { servers } = useApi();

  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [busyPlayerId, setBusyPlayerId] = useState(null);

  // Add player modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [adding, setAdding] = useState(false);

  // Scan state
  const [scanning, setScanning] = useState(false);
  const [scanServerId, setScanServerId] = useState(null);

  useEffect(() => {
    loadPlayers();
  }, []);

  const loadPlayers = async () => {
    try {
      const res = await playerApi.getAll();
      setPlayers(res.data);
    } catch (err) {
      setError('Failed to load players');
    } finally {
      setLoading(false);
    }
  };

  const handleAddPlayer = async () => {
    if (!newPlayerName.trim()) {
      setError('Player name is required');
      return;
    }
    setAdding(true);
    setError('');
    try {
      await playerApi.add({ username: newPlayerName.trim() });
      setSuccess(`Player "${newPlayerName.trim()}" added!`);
      setShowAddModal(false);
      setNewPlayerName('');
      loadPlayers();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to add player');
    } finally {
      setAdding(false);
    }
  };

  const whitelistCount = (player) => Number(player.whitelist_count || 0);

  const handleUnwhitelistAll = async (player) => {
    setBusyPlayerId(player.id);
    setError('');
    setNotice('');
    try {
      await playerApi.unwhitelistAll(player.id);
      setSuccess(`${player.username} removed from all allow lists`);
      loadPlayers();
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyPlayerId(null);
    }
  };

  const handleToggleBan = async (player) => {
    setBusyPlayerId(player.id);
    setError('');
    setSuccess('');
    setNotice('');
    try {
      if (player.is_banned) {
        await playerApi.unbanAll(player.id);
        setNotice(
          `${player.username} is no longer banned, but they are no longer on ANY allow lists and will need to be added manually.`
        );
      } else {
        await playerApi.banAll(player.id, 'Banned by administrator');
        setSuccess(`${player.username} is banned from all servers, including servers created later.`);
        setTimeout(() => setSuccess(''), 4000);
      }
      loadPlayers();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyPlayerId(null);
    }
  };

  const runningGameServers = servers.filter(
    (s) => s.status === 'running' && s.kind !== 'bedrock_connect'
  );

  const handleScan = async (serverId) => {
    setScanning(true);
    setScanServerId(serverId);
    setError('');
    try {
      const res = await playerApi.scan(serverId);
      const scanned = res.data?.scanned ?? 0;
      const added = res.data?.added ?? 0;
      setSuccess(`Scanned ${scanned} players, added ${added} new`);
      loadPlayers();
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Scan failed');
    } finally {
      setScanning(false);
      setScanServerId(null);
    }
  };

  const handleScanAll = async () => {
    if (runningGameServers.length === 0) {
      setError('No running game servers to scan');
      return;
    }
    setScanning(true);
    setScanServerId('all');
    setError('');
    try {
      let scanned = 0;
      let added = 0;
      for (const srv of runningGameServers) {
        const res = await playerApi.scan(srv.id);
        scanned += res.data?.scanned ?? 0;
        added += res.data?.added ?? 0;
      }
      setSuccess(`Scanned ${scanned} players, added ${added} new`);
      loadPlayers();
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Scan failed');
    } finally {
      setScanning(false);
      setScanServerId(null);
    }
  };

  const filteredPlayers = players.filter(p =>
    !search || p.username.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
          <p className="text-sm text-mc-textMuted">Loading players...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="page-header flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-white">Player Management</h1>
            <p className="text-mc-textMuted mt-1">Manage known players, allow lists, and global bans</p>
          </div>
        </div>
        <div className="page-header-actions flex items-center gap-3">
          {runningGameServers.length > 0 && (
            <button
              onClick={handleScanAll}
              disabled={scanning}
              className="btn btn-secondary"
            >
              {scanning && scanServerId === 'all' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Scan className="w-4 h-4" />
              )}
              Scan Server
            </button>
          )}
          <button
            onClick={() => setShowAddModal(true)}
            className="btn btn-primary"
          >
            <Plus className="w-4 h-4" />
            Add Player
          </button>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-2">
          <Check className="w-4 h-4 text-green-400 flex-shrink-0" />
          <p className="text-sm text-green-400">{success}</p>
        </div>
      )}
      {notice && (
        <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
          <p className="text-sm text-amber-300">{notice}</p>
        </div>
      )}

      {/* Search & Scan Section */}
      <div className="card mb-6">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mc-textMuted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-10"
              placeholder="Search players..."
            />
          </div>
        </div>

        {/* Scan servers */}
        <div className="mt-4 pt-4 border-t border-mc-surfaceLight">
          <p className="text-sm text-mc-textMuted mb-3">Scan running servers for players:</p>
          <div className="flex flex-wrap gap-2">
            {runningGameServers.length === 0 ? (
              <p className="text-sm text-mc-textMuted">No running servers to scan</p>
            ) : (
              runningGameServers.map(server => (
                <button
                  key={server.id}
                  onClick={() => handleScan(server.id)}
                  disabled={scanning}
                  className="btn btn-secondary text-sm"
                >
                  {scanning && scanServerId === server.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Scan className="w-4 h-4" />
                  )}
                  Scan {server.name}
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Player List */}
      {filteredPlayers.length === 0 ? (
        <div className="card text-center py-16">
          <Users className="w-16 h-16 text-mc-textMuted mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-white mb-2">No players found</h3>
          <p className="text-mc-textMuted mb-6">
            {search ? 'No players match your search' : 'Add players or scan running servers'}
          </p>
          {!search && (
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => setShowAddModal(true)} className="btn btn-primary">
                <Plus className="w-4 h-4" /> Add Player
              </button>
              {runningGameServers.length > 0 && (
                <button onClick={handleScanAll} disabled={scanning} className="btn btn-secondary">
                  <Scan className="w-4 h-4" /> Scan Server
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredPlayers.map(player => (
            <div key={player.id} className="card animate-slide-up">
              <div className="flex items-center gap-4 max-md:flex-wrap">
                {/* Avatar */}
                <div className="w-10 h-10 bg-mc-darker rounded-full flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-bold text-mc-textMuted">
                    {player.username?.charAt(0)?.toUpperCase()}
                  </span>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-white truncate">{player.username}</h3>
                    {whitelistCount(player) > 0 && (
                      <span className="badge badge-success">
                        <Shield className="w-3 h-3 mr-1" />
                        whitelisted on {whitelistCount(player)} {whitelistCount(player) === 1 ? 'server' : 'servers'}
                      </span>
                    )}
                    {player.is_banned === 1 && (
                      <span className="badge badge-danger">
                        <Ban className="w-3 h-3 mr-1" />
                        Banned
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-xs text-mc-textMuted">
                    {player.xuid && <span>XUID: {player.xuid}</span>}
                    <span>Discovered: {new Date(player.discovered_at).toLocaleDateString()}</span>
                    {player.last_seen && <span>Last seen: {new Date(player.last_seen).toLocaleDateString()}</span>}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {whitelistCount(player) > 0 ? (
                    <button
                      onClick={() => handleUnwhitelistAll(player)}
                      disabled={busyPlayerId === player.id}
                      className="btn btn-secondary text-sm text-mc-danger hover:bg-red-500/20"
                      title="Remove this user from all allow lists"
                    >
                      {busyPlayerId === player.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <ShieldOff className="w-4 h-4" />
                      )}
                    </button>
                  ) : (
                    <span
                      className="btn btn-secondary text-sm opacity-60 cursor-default pointer-events-auto"
                      title="User is not included in any whitelists"
                    >
                      <Shield className="w-4 h-4" />
                    </span>
                  )}
                  <button
                    onClick={() => handleToggleBan(player)}
                    disabled={busyPlayerId === player.id}
                    className={`btn btn-secondary text-sm ${player.is_banned ? 'text-mc-danger hover:bg-red-500/20' : ''}`}
                    title={player.is_banned
                      ? 'Remove this user from all ban lists'
                      : 'Ban this user from all servers, including servers created later'}
                  >
                    {busyPlayerId === player.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Ban className={`w-4 h-4 ${player.is_banned ? 'text-red-400' : ''}`} />
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Player Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Add Player</h3>
              <button onClick={() => setShowAddModal(false)} className="p-1 hover:bg-mc-surfaceLight rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">GamerTag / Username</label>
                <input
                  type="text"
                  value={newPlayerName}
                  onChange={(e) => setNewPlayerName(e.target.value)}
                  className="input"
                  placeholder="Enter player name..."
                  onKeyDown={(e) => e.key === 'Enter' && handleAddPlayer()}
                  autoFocus
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleAddPlayer}
                  disabled={adding || !newPlayerName.trim()}
                  className="btn btn-primary flex-1"
                >
                  {adding ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Adding...
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4" />
                      Add Player
                    </>
                  )}
                </button>
                <button
                  onClick={() => setShowAddModal(false)}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PlayerManagement;
