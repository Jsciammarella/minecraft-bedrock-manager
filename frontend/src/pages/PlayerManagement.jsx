import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { playerApi, serverApi } from '../services/api';
import { useApi } from '../context/ApiContext';
import {
  ArrowLeft, Users, Search, Plus, Shield, ShieldOff,
  AlertCircle, Check, Loader2, Scan, RefreshCw, Trash2, X
} from 'lucide-react';

function PlayerManagement() {
  const navigate = useNavigate();
  const { servers } = useApi();

  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');

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

  const handleWhitelist = async (playerId) => {
    // If there are running servers, whitelist for all of them
    const runningServers = servers.filter(s => s.status === 'running');
    if (runningServers.length === 0) {
      setError('No running servers to whitelist for. Start a server first.');
      return;
    }
    try {
      for (const srv of runningServers) {
        await playerApi.whitelist(playerId, srv.id);
      }
      setSuccess(`${players.find(p => p.id === playerId)?.username} whitelisted on ${runningServers.length} server(s)!`);
      loadPlayers();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleUnwhitelist = async (playerId) => {
    try {
      const runningServers = servers.filter(s => s.status === 'running');
      if (runningServers.length === 0) {
        setError('No running servers to update. Manage this player from a server details page.');
        return;
      }
      for (const srv of runningServers) {
        await playerApi.unwhitelist(playerId, srv.id);
      }
      setSuccess(`${players.find(p => p.id === playerId)?.username} removed from ${runningServers.length} running server whitelist(s)`);
      loadPlayers();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleScan = async (serverId) => {
    setScanning(true);
    setScanServerId(serverId);
    setError('');
    try {
      const res = await playerApi.scan(serverId);
      setSuccess(`Scanned ${res.scanned} players, added ${res.added || 0} new`);
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
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-white">Player Management</h1>
            <p className="text-mc-textMuted mt-1">Manage known players and whitelist</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
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
            {servers.filter(s => s.status === 'running').length === 0 ? (
              <p className="text-sm text-mc-textMuted">No running servers to scan</p>
            ) : (
              servers.filter(s => s.status === 'running').map(server => (
                <button
                  key={server.id}
                  onClick={() => handleScan(server.id)}
                  disabled={scanning && scanServerId !== server.id}
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
              {servers.some(s => s.status === 'running') && (
                <button onClick={() => handleScan(servers.find(s => s.status === 'running').id)} className="btn btn-secondary">
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
              <div className="flex items-center gap-4">
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
                    {player.is_whitelisted === 1 && (
                      <span className="badge badge-success"><Shield className="w-3 h-3 mr-1" />Whitelisted</span>
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
                  {player.is_whitelisted === 1 ? (
                    <button
                      onClick={() => handleUnwhitelist(player.id)}
                      className="btn btn-secondary text-sm text-mc-danger hover:bg-red-500/20"
                      title="Remove from whitelist"
                    >
                      <ShieldOff className="w-4 h-4" />
                    </button>
                  ) : (
                    <button
                      onClick={() => handleWhitelist(player.id)}
                      className="btn btn-secondary text-sm"
                      title="Add to whitelist (all running servers)"
                    >
                      <Shield className="w-4 h-4" />
                    </button>
                  )}
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
