import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Plus, Search, Users, UsersRound } from 'lucide-react';
import { serverAccessApi, serverApi } from '../services/api';

function ServerAccess() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [server, setServer] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newGroup, setNewGroup] = useState('');

  const load = async () => {
    try {
      const [serverRes, accessRes] = await Promise.all([
        serverApi.getById(id),
        serverAccessApi.server(id),
      ]);
      setServer(serverRes.data);
      setData(accessRes.data);
      setError('');
    } catch (err) {
      if (err.response?.data?.code === 'FEATURE_UNAVAILABLE') {
        navigate(`/servers/${id}`, { replace: true });
        return;
      }
      setError(err.response?.data?.error || err.message || 'Failed to load server access');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const users = data?.users || [];
  const groups = data?.groups || [];
  const directory = data?.directoryUsers || [];
  const q = search.trim().toLowerCase();
  const visibleUsers = useMemo(() => users.filter((user) => (
    !q || user.fullName?.toLowerCase().includes(q) || user.username?.toLowerCase().includes(q)
  )), [users, q]);
  const visibleGroups = useMemo(() => groups.filter((group) => (
    !q || group.name?.toLowerCase().includes(q)
  )), [groups, q]);
  const unassigned = directory.filter((user) => !users.some((item) => item.id === user.id));

  const changeMode = async (accessMode) => {
    try {
      await serverAccessApi.setMode(id, accessMode);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const addUser = async (userId) => {
    try {
      await serverAccessApi.addUser(id, userId);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const createGroup = async () => {
    if (!newGroup.trim() || creating) return;
    setCreating(true);
    try {
      const created = await serverAccessApi.createGroup(id, { name: newGroup.trim() });
      navigate(`/servers/${id}/users/groups/${created.data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <button type="button" onClick={() => navigate(`/servers/${id}`)} className="p-2 hover:bg-mc-surfaceLight rounded-lg">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">Users</h1>
          <p className="text-mc-textMuted mt-1">
            {server?.name} — management-console access for this server
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{error}</div>
      )}

      <div className="card mb-6">
        <h2 className="font-semibold text-white mb-2">Access mode</h2>
        <p className="text-sm text-mc-textMuted mb-4">
          Inherited keeps global permissions and lets server assignments add allows or denies.
          Restricted hides this server from anyone who is not an administrator, an assigned user, or a member of an active server group.
        </p>
        <div className="flex gap-3 max-md:flex-col">
          {['inherited', 'restricted'].map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => changeMode(mode)}
              className={`btn flex-1 ${data?.policy?.accessMode === mode ? 'btn-primary' : 'btn-secondary'}`}
            >
              {mode === 'inherited' ? 'Inherited' : 'Restricted'}
            </button>
          ))}
        </div>
      </div>

      <div className="card mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mc-textMuted" />
          <input className="input pl-10" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search users or groups..." />
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-white flex items-center gap-2"><Users className="w-4 h-4" /> Users</h2>
          </div>
          {visibleUsers.length === 0 ? (
            <p className="text-sm text-mc-textMuted">No assigned management users.</p>
          ) : visibleUsers.map((user) => (
            <button
              key={user.id}
              type="button"
              onClick={() => navigate(`/servers/${id}/users/${user.id}`)}
              className="w-full text-left p-3 rounded-lg hover:bg-mc-surfaceLight mb-2"
            >
              <p className="text-white font-medium">{user.fullName}</p>
              <p className="text-xs text-mc-textMuted">@{user.username}{user.viaGroup ? ' · via group' : ''}{user.explicit ? ' · assigned' : ''}</p>
            </button>
          ))}
          {unassigned.length > 0 && (
            <div className="mt-4">
              <p className="text-xs text-mc-textMuted mb-2">Add a management-console user</p>
              <select className="input" defaultValue="" onChange={(e) => { if (e.target.value) addUser(Number(e.target.value)); e.target.value = ''; }}>
                <option value="">Select user...</option>
                {unassigned.map((user) => (
                  <option key={user.id} value={user.id}>{user.fullName} (@{user.username})</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-white flex items-center gap-2"><UsersRound className="w-4 h-4" /> Server Groups</h2>
          </div>
          <div className="flex gap-2 mb-4">
            <input className="input flex-1" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group name" />
            <button type="button" className="btn btn-primary" onClick={createGroup} disabled={creating || !newGroup.trim()}>
              <Plus className="w-4 h-4" />
            </button>
          </div>
          {visibleGroups.length === 0 ? (
            <p className="text-sm text-mc-textMuted">No server groups yet.</p>
          ) : visibleGroups.map((group) => (
            <button
              key={group.id}
              type="button"
              onClick={() => navigate(`/servers/${id}/users/groups/${group.id}`)}
              className="w-full text-left p-3 rounded-lg hover:bg-mc-surfaceLight mb-2"
            >
              <p className="text-white font-medium">{group.name}</p>
              <p className="text-xs text-mc-textMuted">{group.memberCount} members{group.isActive ? '' : ' · inactive'}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ServerAccess;
