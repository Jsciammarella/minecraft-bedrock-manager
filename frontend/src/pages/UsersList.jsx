import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Loader2, Plus, Search, Shield, Trash2, User, UserX, Users, X
} from 'lucide-react';
import { userManagementApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

function UsersList() {
  const navigate = useNavigate();
  const { can, isAdmin } = useAuth();
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    username: '',
    fullName: '',
    password: '',
    isAdmin: false,
    groupIds: [],
  });

  const canCreate = isAdmin || can('users.change_user_permissions');
  const canToggle = canCreate;
  const canDelete = canCreate;
  const activeAdmins = users.filter((user) => user.isAdmin && user.isActive).length;

  const load = async () => {
    try {
      const [userRes, groupRes] = await Promise.all([
        userManagementApi.users(),
        userManagementApi.groups(),
      ]);
      setUsers(userRes.data || []);
      setGroups(groupRes.data || []);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const visibleGroups = groups.filter((group) => group.isActive);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((user) => {
      const matchesName = !q
        || String(user.fullName || '').toLowerCase().includes(q)
        || String(user.username || '').toLowerCase().includes(q);
      if (!matchesName) return false;
      if (groupFilter === 'all') return true;
      if (groupFilter === 'admins') return user.isAdmin;
      return (user.groups || []).some((group) => String(group.id) === String(groupFilter));
    });
  }, [users, search, groupFilter]);

  const handleToggle = async (event, user) => {
    event.stopPropagation();
    if (!canToggle) return;
    const nextActive = !user.isActive;
    if (user.isAdmin && !isAdmin) return;
    if (user.isAdmin && user.isActive && activeAdmins <= 1) return;
    setBusyId(user.id);
    try {
      await userManagementApi.updateUser(user.id, { isActive: nextActive });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (event, user) => {
    event.stopPropagation();
    if (!canDelete) return;
    if (user.isAdmin && !isAdmin) return;
    if (user.isAdmin && activeAdmins <= 1) return;
    if (!confirm(`Delete ${user.fullName}? This cannot be undone.`)) return;
    setBusyId(user.id);
    try {
      await userManagementApi.deleteUser(user.id);
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
      const created = await userManagementApi.createUser({
        username: form.username,
        fullName: form.fullName,
        password: form.password,
        isAdmin: Boolean(form.isAdmin && isAdmin),
        groupIds: form.groupIds,
      });
      setShowCreate(false);
      setForm({ username: '', fullName: '', password: '', isAdmin: false, groupIds: [] });
      await load();
      navigate(`/users/${created.data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create user');
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
              placeholder="Search by name..."
            />
          </div>
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            className="input w-full md:w-56"
          >
            <option value="all">All users</option>
            <option value="admins">Administrators</option>
            {visibleGroups.map((group) => (
              <option key={group.id} value={String(group.id)}>{group.name}</option>
            ))}
          </select>
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4" />
              New User
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <div className="max-h-[70vh] overflow-y-auto divide-y divide-mc-surfaceLight">
          {filtered.length === 0 ? (
            <div className="p-10 text-center text-mc-textMuted">No users match this search or filter.</div>
          ) : filtered.map((user) => {
            const lastAdmin = user.isAdmin && user.isActive && activeAdmins <= 1;
            const disableAdminAction = user.isAdmin && !isAdmin;
            const toggleDisabled = !canToggle || disableAdminAction || lastAdmin || busyId === user.id;
            const deleteDisabled = !canDelete || disableAdminAction || lastAdmin || busyId === user.id;
            return (
              <button
                key={user.id}
                type="button"
                onClick={() => navigate(`/users/${user.id}`)}
                className="w-full text-left px-4 py-3 hover:bg-mc-surfaceLight/60 transition-colors flex items-center gap-3"
              >
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                  user.isActive ? 'bg-mc-accent/15 text-mc-accent' : 'bg-red-500/15 text-red-400'
                }`}>
                  {user.isActive ? <User className="w-5 h-5" /> : <UserX className="w-5 h-5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-white truncate">{user.fullName}</p>
                    {user.isAdmin && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                        Admin
                      </span>
                    )}
                    {!user.isActive && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30">
                        Deactivated
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-mc-textMuted truncate">@{user.username}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="hidden sm:inline-flex items-center gap-1 text-xs text-mc-textMuted mr-2">
                    <Users className="w-3.5 h-3.5" />
                    {user.groupCount || 0}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    title={lastAdmin ? 'There must always be one administrator' : (user.isActive ? 'Deactivate user' : 'Activate user')}
                    onClick={(event) => handleToggle(event, user)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') handleToggle(event, user);
                    }}
                    className={`p-2 rounded-lg ${toggleDisabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-mc-darker'}`}
                  >
                    {user.isActive
                      ? <User className="w-4 h-4 text-mc-text" />
                      : <UserX className="w-4 h-4 text-red-400" />}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    title={lastAdmin ? 'There must always be one administrator' : 'Delete user'}
                    onClick={(event) => handleDelete(event, user)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') handleDelete(event, user);
                    }}
                    className={`p-2 rounded-lg ${deleteDisabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-red-500/15 text-mc-danger'}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleCreate} className="card max-w-lg w-full relative">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="absolute top-4 right-4 p-1 text-mc-textMuted hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
            <h3 className="text-lg font-semibold text-white mb-4">Create user</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Username</label>
                <input className="input" value={form.username} onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))} required />
              </div>
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Full name</label>
                <input className="input" value={form.fullName} onChange={(e) => setForm((prev) => ({ ...prev, fullName: e.target.value }))} required />
              </div>
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Password</label>
                <input type="password" className="input" value={form.password} onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))} required minLength={6} />
              </div>
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Groups</label>
                <div className="max-h-40 overflow-y-auto space-y-2">
                  {groups.map((group) => (
                    <label key={group.id} className="flex items-center gap-2 text-sm text-mc-text">
                      <input
                        type="checkbox"
                        checked={form.groupIds.includes(group.id)}
                        onChange={(e) => {
                          setForm((prev) => ({
                            ...prev,
                            groupIds: e.target.checked
                              ? [...prev.groupIds, group.id]
                              : prev.groupIds.filter((id) => id !== group.id),
                          }));
                        }}
                      />
                      {group.name}
                    </label>
                  ))}
                </div>
              </div>
              {isAdmin && (
                <label className="flex items-center gap-2 text-sm text-white">
                  <input
                    type="checkbox"
                    checked={form.isAdmin}
                    onChange={(e) => setForm((prev) => ({ ...prev, isAdmin: e.target.checked }))}
                  />
                  <Shield className="w-4 h-4 text-amber-300" />
                  Administrator
                </label>
              )}
              <div className="flex gap-3">
                <button type="submit" disabled={creating} className="btn btn-primary flex-1">
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Create
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default UsersList;
