import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Save, Shield } from 'lucide-react';
import { authApi, playerApi, userManagementApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import PermissionEditor from '../components/PermissionEditor.jsx';
import PasswordPolicyHints from '../components/PasswordPolicyHints.jsx';
import ScrollableCheckList from '../components/ScrollableCheckList.jsx';
import { DEFAULT_PASSWORD_POLICY, validatePassword } from '../utils/passwordPolicy';
import { scrollPageTop } from '../utils/scrollPageTop';
import { splitPermissionCatalog } from '../utils/menuVisibility';

function UserDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, isAdmin, user: currentUser, refresh } = useAuth();
  const [user, setUser] = useState(null);
  const [groups, setGroups] = useState([]);
  const [players, setPlayers] = useState([]);
  const [catalog, setCatalog] = useState({ categories: [], permissions: [] });
  const [policy, setPolicy] = useState(DEFAULT_PASSWORD_POLICY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm] = useState({
    fullName: '',
    password: '',
    confirmPassword: '',
    isAdmin: false,
    groupIds: [],
    playerId: '',
    userPermissions: {},
  });

  const load = async () => {
    try {
      const [userRes, groupRes, catalogRes, playerRes, policyRes] = await Promise.all([
        userManagementApi.getUser(id),
        userManagementApi.groups(),
        userManagementApi.catalog(),
        playerApi.getAll().catch(() => ({ data: [] })),
        authApi.passwordPolicy().catch(() => ({ data: DEFAULT_PASSWORD_POLICY })),
      ]);
      const next = userRes.data;
      setUser(next);
      setGroups(groupRes.data || []);
      setCatalog(catalogRes.data || { categories: [], permissions: [] });
      setPlayers(playerRes.data || []);
      setPolicy(policyRes.data || DEFAULT_PASSWORD_POLICY);
      setForm({
        fullName: next.fullName || '',
        password: '',
        confirmPassword: '',
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

  const groupItems = useMemo(() => {
    return groups
      .filter((group) => group.isActive || form.groupIds.includes(group.id))
      .map((group) => ({
        id: group.id,
        label: group.name,
        subtitle: group.isActive ? '' : 'Deactivated',
        muted: !group.isActive,
      }));
  }, [groups, form.groupIds]);

  const { actions: actionCatalog } = useMemo(
    () => splitPermissionCatalog(catalog),
    [catalog],
  );

  const handleSave = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      if (form.password || form.confirmPassword) {
        const passwordError = validatePassword(form.password, policy, { confirm: form.confirmPassword });
        if (passwordError) throw new Error(passwordError);
      }
      const payload = {};
      if (can('users.edit_name') || isAdmin) payload.fullName = form.fullName;
      if (form.password && (can('users.reset_password') || isAdmin)) payload.password = form.password;
      if (can('users.assign_groups') || isAdmin) payload.groupIds = form.groupIds;
      if (can('users.assign_permissions') || isAdmin) payload.userPermissions = form.userPermissions;
      if (isAdmin) payload.isAdmin = form.isAdmin;
      if (isAdmin || can('users.link_player') || can('users.unlink_player')) {
        payload.playerId = form.playerId === '' ? null : Number(form.playerId);
      }
      await userManagementApi.updateUser(id, payload);
      setSuccess('User saved');
      setForm((prev) => ({ ...prev, password: '', confirmPassword: '' }));
      await load();
      if (currentUser?.id === Number(id)) await refresh();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save user');
    } finally {
      setSaving(false);
      scrollPageTop();
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

  const lastAdmin = Boolean(user.isLastAdmin);
  const canEditPassword = isAdmin || can('users.reset_password');

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
            <label className="block text-sm font-medium text-mc-text mb-2">Username</label>
            <input className="input" value={user.username} disabled readOnly />
            <p className="text-xs text-mc-textMuted mt-2">Usernames are unique and cannot be changed.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-mc-text mb-2">Full name</label>
            <input
              className="input"
              value={form.fullName}
              disabled={!isAdmin && !can('users.edit_name')}
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
              disabled={!canEditPassword}
              onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-mc-text mb-2">Verify new password</label>
            <input
              type="password"
              className="input"
              value={form.confirmPassword}
              placeholder="Leave blank to keep current password"
              disabled={!canEditPassword}
              onChange={(e) => setForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
            />
          </div>
          <div className="md:col-span-2">
            <PasswordPolicyHints policy={policy} />
          </div>
          <div>
            <label className="block text-sm font-medium text-mc-text mb-2">Linked player</label>
            <select
              className="input"
              value={form.playerId}
              disabled={!isAdmin && !can('users.link_player') && !can('users.unlink_player')}
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
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">Administrator</label>
              <label className={`input flex items-center gap-3 cursor-pointer ${lastAdmin && user.isAdmin ? 'opacity-60' : ''}`}>
                <input
                  type="checkbox"
                  checked={form.isAdmin}
                  disabled={lastAdmin && user.isAdmin}
                  onChange={(e) => setForm((prev) => ({ ...prev, isAdmin: e.target.checked }))}
                />
                <span className="flex items-center gap-2 text-white">
                  <Shield className="w-4 h-4 text-amber-300" />
                  Administrator
                </span>
              </label>
              <p className="text-xs text-mc-textMuted mt-2">
                {lastAdmin ? 'This is the last administrator and cannot be demoted.' : 'Only another administrator can set this.'}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-4">Groups</h3>
        <ScrollableCheckList
          items={groupItems}
          selectedIds={form.groupIds}
          searchPlaceholder="Search groups..."
          emptyText="No groups match this search."
          disabled={!isAdmin && !can('users.assign_groups')}
          onToggle={(groupId, checked) => {
            setForm((prev) => ({
              ...prev,
              groupIds: checked
                ? [...prev.groupIds, groupId]
                : prev.groupIds.filter((gid) => gid !== groupId),
            }));
          }}
        />
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-1">User permissions</h3>
        <p className="text-xs text-mc-textMuted mb-4">
          No selection inherits from groups. Allow grants this user the permission. Deny blocks it even if a group allows it. A group deny always wins.
        </p>
        <PermissionEditor
          catalog={actionCatalog}
          values={form.userPermissions}
          inherited={user.inheritedPermissions}
          effectiveKeys={user.permissions}
          assignmentKey="allowUser"
          disabled={user.isAdmin || (!isAdmin && !can('users.assign_permissions'))}
          onChange={(key, next) => {
            setForm((prev) => {
              const userPermissions = { ...prev.userPermissions };
              if (!next) delete userPermissions[key];
              else userPermissions[key] = next;
              return { ...prev, userPermissions };
            });
          }}
        />
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
