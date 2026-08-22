import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Save, Trash2 } from 'lucide-react';
import { userManagementApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import PermissionTriState from '../components/PermissionTriState.jsx';

function GroupDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, isAdmin } = useAuth();
  const [group, setGroup] = useState(null);
  const [users, setUsers] = useState([]);
  const [catalog, setCatalog] = useState({ categories: [], permissions: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm] = useState({
    name: '',
    userIds: [],
    permissions: {},
  });

  const load = async () => {
    try {
      const [groupRes, userRes, catalogRes] = await Promise.all([
        userManagementApi.getGroup(id),
        userManagementApi.users().catch(() => ({ data: [] })),
        userManagementApi.catalog(),
      ]);
      const next = groupRes.data;
      setGroup(next);
      setUsers(userRes.data || []);
      setCatalog(catalogRes.data || { categories: [], permissions: [] });
      setForm({
        name: next.name || '',
        userIds: (next.users || []).map((user) => user.id),
        permissions: next.permissions || {},
      });
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load group');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const handleSave = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const payload = { name: form.name };
      if (isAdmin || can('users.change_group_membership')) payload.userIds = form.userIds;
      if (isAdmin || can('users.change_group_permissions')) payload.permissions = form.permissions;
      await userManagementApi.updateGroup(id, payload);
      setSuccess('Group saved');
      await load();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save group');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete group "${group.name}"? Users are removed from the group, not deleted.`)) return;
    try {
      await userManagementApi.deleteGroup(id);
      navigate('/users/groups');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
      </div>
    );
  }

  if (!group) {
    return (
      <div className="card text-center py-12">
        <p className="text-mc-textMuted mb-4">{error || 'Group not found'}</p>
        <button type="button" className="btn btn-secondary" onClick={() => navigate('/users/groups')}>Back</button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <button type="button" onClick={() => navigate('/users/groups')} className="p-2 hover:bg-mc-surfaceLight rounded-lg">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-2xl font-bold text-white">{group.name}</h2>
            <p className="text-sm text-mc-textMuted">{group.userCount || 0} members</p>
          </div>
        </div>
        {(isAdmin || can('users.delete_groups')) && (
          <button type="button" className="btn btn-secondary text-mc-danger" onClick={handleDelete}>
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
        )}
      </div>

      {error && <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{error}</div>}
      {success && <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-400">{success}</div>}

      <div className="card space-y-4">
        <h3 className="text-lg font-semibold text-white">Group name</h3>
        <input
          className="input"
          value={form.name}
          onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
        />
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-4">Members</h3>
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {users.map((user) => (
            <label key={user.id} className="flex items-center justify-between p-3 rounded-lg bg-mc-darker">
              <span className="text-sm text-white">
                {user.fullName}
                <span className="ml-2 text-xs text-mc-textMuted">@{user.username}</span>
              </span>
              <input
                type="checkbox"
                checked={form.userIds.includes(user.id)}
                disabled={!isAdmin && !can('users.change_group_membership')}
                onChange={(e) => {
                  setForm((prev) => ({
                    ...prev,
                    userIds: e.target.checked
                      ? [...prev.userIds, user.id]
                      : prev.userIds.filter((uid) => uid !== user.id),
                  }));
                }}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-1">Group permissions</h3>
        <p className="text-xs text-mc-textMuted mb-4">
          Members inherit these while the group is active. A deny in any group blocks that permission until the user leaves the group.
        </p>
        <div className="space-y-6">
          {(catalog.categories || []).map((category) => (
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
                      value={form.permissions[perm.key] || ''}
                      allowAssignment={perm.allowGroup !== false}
                      disabled={!isAdmin && !can('users.change_group_permissions')}
                      onChange={(next) => {
                        setForm((prev) => {
                          const permissions = { ...prev.permissions };
                          if (!next) delete permissions[perm.key];
                          else permissions[perm.key] = next;
                          return { ...prev, permissions };
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
        <button type="button" className="btn btn-secondary" onClick={() => navigate('/users/groups')}>Cancel</button>
      </div>
    </form>
  );
}

export default GroupDetail;
