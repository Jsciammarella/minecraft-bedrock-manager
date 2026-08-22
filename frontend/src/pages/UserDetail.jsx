import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Save, Shield } from 'lucide-react';
import { playerApi, userManagementApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import PermissionTriState from '../components/PermissionTriState.jsx';

function UserDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, isAdmin, user: currentUser, refresh } = useAuth();
  const [user, setUser] = useState(null);
  const [groups, setGroups] = useState([]);
  const [players, setPlayers] = useState([]);
  const [catalog, setCatalog] = useState({ categories: [], permissions: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm] = useState({
    fullName: '',
    password: '',
    isAdmin: false,
    groupIds: [],
    playerId: '',
    userPermissions: {},
  });

  const load = async () => {
    try {
      const [userRes, groupRes, catalogRes, playerRes] = await Promise.all([
        userManagementApi.getUser(id),
        userManagementApi.groups(),
        userManagementApi.catalog(),
        playerApi.getAll().catch(() => ({ data: [] })),
      ]);
      const next = userRes.data;
      setUser(next);
      setGroups(groupRes.data || []);
      setCatalog(catalogRes.data || { categories: [], permissions: [] });
      setPlayers(playerRes.data || []);
      setForm({
        fullName: next.fullName || '',
        password: '',
        isAdmin: Boolean(next.isAdmin),
        groupIds: (next.groups || []).map((group) => group.id),
        playerId: next.playerId ? String(next.playerId) : '',
        userPermissions: next.userPermissions || {},
      });
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load user');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const groupedPermissions = useMemo(() => {
    const byCategory = {};
    for (const perm of catalog.permissions || []) {
      if (!byCategory[perm.category]) byCategory[perm.category] = [];
      byCategory[perm.category].push(perm);
    }
    return catalog.categories || [];
  }, [catalog]);

  const handleSave = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const payload = {};
      if (can('users.change_name') || isAdmin) payload.fullName = form.fullName;
      if (form.password && (can('users.change_password') || isAdmin)) payload.password = form.password;
      if (can('users.change_group_membership') || isAdmin) payload.groupIds = form.groupIds;
      if (can('users.change_user_permissions') || isAdmin) payload.userPermissions = form.userPermissions;
      if (isAdmin) payload.isAdmin = form.isAdmin;
      if (isAdmin || can('users.change_user_permissions')) {
        payload.playerId = form.playerId === '' ? null : Number(form.playerId);
      }
      await userManagementApi.updateUser(id, payload);
      setSuccess('User saved');
      setForm((prev) => ({ ...prev, password: '' }));
      await load();
      if (currentUser?.id === Number(id)) await refresh();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save user');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="card text-center py-12">
        <p className="text-mc-textMuted mb-4">{error || 'User not found'}</p>
        <button type="button" className="btn btn-secondary" onClick={() => navigate('/users')}>Back</button>
      </div>
    );
  }

  const activeGroups = groups.filter((group) => group.isActive || form.groupIds.includes(group.id));
  const lastAdmin = Boolean(user.isLastAdmin);

  return (
    <form onSubmit={handleSave} className="space-y-6">
      <div className="flex items-center gap-4">
        <button type="button" onClick={() => navigate('/users')} className="p-2 hover:bg-mc-surfaceLight rounded-lg">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h2 className="text-2xl font-bold text-white">{user.fullName}</h2>
          <p className="text-sm text-mc-textMuted">@{user.username}</p>
        </div>
      </div>

      {error && <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{error}</div>}
      {success && <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-400">{success}</div>}
      {user.isAdmin && (
        <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-200">
          Administrator accounts have every permission. Group and user deny/allow overrides do not apply.
        </div>
      )}

      <div className="card space-y-4">
        <h3 className="text-lg font-semibold text-white">Profile</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-mc-text mb-2">Full name</label>
            <input
              className="input"
              value={form.fullName}
              disabled={!isAdmin && !can('users.change_name')}
              onChange={(e) => setForm((prev) => ({ ...prev, fullName: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-mc-text mb-2">New password</label>
            <input
              type="password"
              className="input"
              value={form.password}
              placeholder="Leave blank to keep current password"
              disabled={!isAdmin && !can('users.change_password')}
              onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-mc-text mb-2">Linked player</label>
            <select
              className="input"
              value={form.playerId}
              disabled={!isAdmin && !can('users.change_user_permissions')}
              onChange={(e) => setForm((prev) => ({ ...prev, playerId: e.target.value }))}
            >
              <option value="">None</option>
              {players.map((player) => (
                <option key={player.id} value={String(player.id)}>{player.username}</option>
              ))}
            </select>
            <p className="text-xs text-mc-textMuted mt-2">Players and users are optional and independent. Linking them does not share permissions.</p>
          </div>
          {isAdmin && (
            <label className="flex items-center gap-3 p-3 bg-mc-darker rounded-lg">
              <input
                type="checkbox"
                checked={form.isAdmin}
                disabled={lastAdmin && user.isAdmin}
                onChange={(e) => setForm((prev) => ({ ...prev, isAdmin: e.target.checked }))}
              />
              <span>
                <span className="flex items-center gap-2 text-white">
                  <Shield className="w-4 h-4 text-amber-300" />
                  Administrator
                </span>
                <span className="block text-xs text-mc-textMuted">
                  {lastAdmin ? 'This is the last administrator and cannot be demoted.' : 'Only another administrator can set this.'}
                </span>
              </span>
            </label>
          )}
        </div>
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-4">Groups</h3>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {activeGroups.map((group) => (
            <label key={group.id} className={`flex items-center justify-between p-3 rounded-lg bg-mc-darker ${!group.isActive ? 'opacity-60' : ''}`}>
              <span className="text-sm text-white">
                {group.name}
                {!group.isActive && <span className="ml-2 text-xs text-mc-textMuted">Deactivated</span>}
              </span>
              <input
                type="checkbox"
                checked={form.groupIds.includes(group.id)}
                disabled={!isAdmin && !can('users.change_group_membership')}
                onChange={(e) => {
                  setForm((prev) => ({
                    ...prev,
                    groupIds: e.target.checked
                      ? [...prev.groupIds, group.id]
                      : prev.groupIds.filter((gid) => gid !== group.id),
                  }));
                }}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-1">User permissions</h3>
        <p className="text-xs text-mc-textMuted mb-4">
          Blank inherits from groups. Allow grants this user the permission. Deny blocks it even if a group allows it. A group deny always wins.
        </p>
        <div className="space-y-6">
          {groupedPermissions.map((category) => (
            <div key={category.id}>
              <h4 className="text-sm font-semibold text-mc-text mb-3">{category.label}</h4>
              <div className="space-y-2">
                {(catalog.permissions || []).filter((perm) => perm.category === category.id).map((perm) => (
                  <div key={perm.key} className="flex items-start justify-between gap-3 p-3 bg-mc-darker rounded-lg">
                    <div>
                      <p className="text-sm text-white">{perm.name}</p>
                      <p className="text-xs text-mc-textMuted">{perm.description}</p>
                    </div>
                    <PermissionTriState
                      value={form.userPermissions[perm.key] || ''}
                      allowAssignment={perm.allowUser !== false}
                      disabled={user.isAdmin || (!isAdmin && !can('users.change_user_permissions'))}
                      onChange={(next) => {
                        setForm((prev) => {
                          const userPermissions = { ...prev.userPermissions };
                          if (!next) delete userPermissions[perm.key];
                          else userPermissions[perm.key] = next;
                          return { ...prev, userPermissions };
                        });
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-3">
        <button type="submit" disabled={saving} className="btn btn-primary">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => navigate('/users')}>Cancel</button>
      </div>
    </form>
  );
}

export default UserDetail;
