import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Plus, Search, Users, User, UserX, X } from 'lucide-react';
import { userManagementApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

function GroupsList() {
  const navigate = useNavigate();
  const { can, isAdmin } = useAuth();
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const canCreate = isAdmin || can('groups.create');
  const canToggle = isAdmin || can('groups.activate') || can('groups.deactivate');

  const load = async () => {
    try {
      const res = await userManagementApi.groups();
      setGroups(res.data || []);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load groups');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups.filter((group) => !q || String(group.name || '').toLowerCase().includes(q));
  }, [groups, search]);

  const handleToggle = async (event, group) => {
    event.stopPropagation();
    if (!canToggle) return;
    setBusyId(group.id);
    try {
      await userManagementApi.updateGroup(group.id, { isActive: !group.isActive });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    setCreating(true);
    setError('');
    try {
      const created = await userManagementApi.createGroup({ name });
      setShowCreate(false);
      setName('');
      await load();
      navigate(`/users/groups/${created.data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create group');
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <div className="card mb-6">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mc-textMuted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-10"
              placeholder="Search groups..."
            />
          </div>
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4" />
              New Group
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{error}</div>
      )}

      <div className="card p-0 overflow-hidden">
        <div className="max-h-[70vh] overflow-y-auto divide-y divide-mc-surfaceLight">
          {filtered.length === 0 ? (
            <div className="p-10 text-center text-mc-textMuted">No groups match this search.</div>
          ) : filtered.map((group) => (
            <button
              key={group.id}
              type="button"
              onClick={() => navigate(`/users/groups/${group.id}`)}
              className="w-full text-left px-4 py-3 hover:bg-mc-surfaceLight/60 transition-colors flex items-center gap-3"
            >
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                group.isActive ? 'bg-mc-accent/15 text-mc-accent' : 'bg-red-500/15 text-red-400'
              }`}>
                {group.isActive ? <User className="w-5 h-5" /> : <UserX className="w-5 h-5" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-white truncate">{group.name}</p>
                {!group.isActive && (
                  <p className="text-xs text-red-400">Deactivated — members no longer inherit these permissions</p>
                )}
              </div>
              <span className="inline-flex items-center gap-1 text-xs text-mc-textMuted mr-2">
                <Users className="w-3.5 h-3.5" />
                {group.userCount || 0}
              </span>
              <span
                role="button"
                tabIndex={0}
                title={group.isActive ? 'Deactivate group' : 'Activate group'}
                onClick={(event) => handleToggle(event, group)}
                className={`p-2 rounded-lg ${!canToggle || busyId === group.id ? 'opacity-40 cursor-not-allowed' : 'hover:bg-mc-darker'}`}
              >
                {group.isActive
                  ? <User className="w-4 h-4 text-mc-text" />
                  : <UserX className="w-4 h-4 text-red-400" />}
              </span>
            </button>
          ))}
        </div>
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleCreate} className="card max-w-lg w-full relative">
            <button type="button" onClick={() => setShowCreate(false)} className="absolute top-4 right-4 p-1 text-mc-textMuted hover:text-white">
              <X className="w-4 h-4" />
            </button>
            <h3 className="text-lg font-semibold text-white mb-4">Create group</h3>
            <label className="block text-sm font-medium text-mc-text mb-2">Group name</label>
            <input className="input mb-4" value={name} onChange={(e) => setName(e.target.value)} required />
            <div className="flex gap-3">
              <button type="submit" disabled={creating} className="btn btn-primary flex-1">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Create
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default GroupsList;
