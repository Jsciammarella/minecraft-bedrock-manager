import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { serverApi, playerApi } from '../services/api';
import {
  ArrowLeft, Users, UserPlus, AlertCircle, Check, Loader2, Ban, Shield
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

function ServerUsers() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [server, setServer] = useState(null);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [query, setQuery] = useState('');
  const [permission, setPermission] = useState('member');

  const isBC = server?.kind === 'bedrock_connect';
  const customPlayers = players.filter((player) => Number(player.has_custom_permission) === 1);

  useEffect(() => {
    loadPage();
  }, [id]);

  const loadPage = async () => {
    try {
      const [serverRes, accessRes] = await Promise.all([
        serverApi.getById(id),
        playerApi.getByServer(id),
      ]);
      setServer(serverRes.data);
      setPlayers(accessRes.data.players || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  const resolvePlayerId = async (nameQuery) => {
    const name = String(nameQuery || '').trim();
    if (!name) throw new Error('Enter a player name');
    const match = players.find((player) => (
      String(player.id) === name || player.username.toLowerCase() === name.toLowerCase()
    ));
    if (match) return match.id;
    const created = await playerApi.add({ username: name });
    return created.data.id;
  };

  const saveAccess = async (playerId, changes, message) => {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await playerApi.updateServerAccess(id, playerId, changes);
      const res = await playerApi.getByServer(id);
      setPlayers(res.data.players || []);
      setSuccess(message);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const addCustomPermission = async () => {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const playerId = await resolvePlayerId(query);
      await playerApi.updateServerAccess(id, playerId, {
        permission,
        hasCustomPermission: true,
      });
      const res = await playerApi.getByServer(id);
      setPlayers(res.data.players || []);
      setQuery('');
      setSuccess('Player permission saved. This does not add them to the allow list.');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
          <p className="text-sm text-mc-textMuted">Loading users...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => navigate(`/servers/${id}`)}
          className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">Users</h1>
          <p className="text-mc-textMuted mt-1">
            {server?.name} — custom permissions for this server
          </p>
        </div>
      </div>

      {isBC && (
        <div className="mb-6 p-4 bg-mc-darker border border-mc-surfaceLight rounded-lg text-sm text-mc-textMuted">
          Bedrock Connect does not have per-player permissions.
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

      <div className={`card ${isBC ? 'opacity-60' : ''}`}>
        <h2 className="font-semibold text-white flex items-center gap-2 mb-2">
          <Users className="w-4 h-4" />
          Permission list
        </h2>
        <p className="text-xs text-mc-textMuted mb-4">
          Players listed here receive these permissions whenever they join this server.
          This is not an allow list — adding a player here does not let them in if whitelist
          mode is on, and they can still be banned. Players not listed here use the default
          permission from Properties. If a player is also on the allow list, permission
          changes stay in sync.
        </p>

        <div className="flex flex-col sm:flex-row gap-2 mb-4">
          <PlayerCombobox
            value={query}
            onChange={setQuery}
            options={players.filter((player) => Number(player.has_custom_permission) !== 1)}
            disabled={isBC}
            placeholder="Type a player name..."
            onEnter={addCustomPermission}
          />
          <select
            value={permission}
            onChange={(e) => setPermission(e.target.value)}
            disabled={isBC || busy}
            className="input sm:w-36 text-sm"
            aria-label="Permission level"
          >
            <option value="visitor">Visitor</option>
            <option value="member">Member</option>
            <option value="operator">Operator</option>
          </select>
          <button
            onClick={addCustomPermission}
            disabled={isBC || !query.trim() || busy}
            className="btn btn-primary"
          >
            <UserPlus className="w-4 h-4" /> Add Player
          </button>
        </div>

        <div className="space-y-2">
          {customPlayers.length === 0 ? (
            <p className="text-sm text-mc-textMuted text-center py-4">
              No custom permissions. Joining players will use this server&apos;s default permission.
            </p>
          ) : customPlayers.map((player) => (
            <div key={player.id} className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 bg-mc-darker rounded-lg">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{player.username}</p>
                <p className="text-xs text-mc-textMuted">
                  {player.xuid
                    ? `XUID: ${player.xuid}`
                    : 'XUID will be captured when the player joins'}
                  {Number(player.is_whitelisted) === 1 ? ' · On allow list' : ''}
                  {Number(player.is_banned) === 1 ? ' · Banned' : ''}
                </p>
              </div>
              {Number(player.is_banned) === 1 && (
                <span className="text-xs text-red-400 flex items-center gap-1">
                  <Ban className="w-3 h-3" /> Banned
                </span>
              )}
              {Number(player.is_whitelisted) === 1 && (
                <span className="text-xs text-green-400 flex items-center gap-1">
                  <Shield className="w-3 h-3" /> Allow list
                </span>
              )}
              <select
                value={player.permission}
                onChange={(e) => saveAccess(
                  player.id,
                  { permission: e.target.value, hasCustomPermission: true },
                  `${player.username}'s permission updated.`
                )}
                disabled={isBC || busy}
                className="input sm:w-36 text-sm"
                aria-label={`Permission for ${player.username}`}
              >
                <option value="visitor">Visitor</option>
                <option value="member">Member</option>
                <option value="operator">Operator</option>
              </select>
              <button
                onClick={() => saveAccess(
                  player.id,
                  { hasCustomPermission: false },
                  `${player.username} will now use this server's default permission.`
                )}
                disabled={isBC || busy}
                className="btn btn-secondary text-sm text-mc-danger"
                title="Remove custom permission. This does not change allow list or ban status."
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ServerUsers;
