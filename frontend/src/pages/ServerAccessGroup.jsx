import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Save, Trash2 } from 'lucide-react';
import { serverAccessApi } from '../services/api';
import PermissionEditor from '../components/PermissionEditor.jsx';
import ScrollableCheckList from '../components/ScrollableCheckList.jsx';

function ServerAccessGroup() {
  const { id, groupId } = useParams();
  const navigate = useNavigate();
  const [group, setGroup] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', description: '', isActive: true, userIds: [], permissions: {} });

  const load = async () => {
    try {
      const [groupRes, serverRes] = await Promise.all([
        serverAccessApi.getGroup(id, groupId),
        serverAccessApi.server(id),
      ]);
      const next = groupRes.data;
      setGroup(next);
      setSnapshot(serverRes.data);
      setForm({
        name: next.name || '',
        description: next.description || '',
        isActive: next.isActive !== false,
        userIds: (next.users || []).map((user) => user.id),
        permissions: next.permissions || {},
      });
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id, groupId]);

  const catalog = useMemo(() => ({
    categories: [{ id: 'servers', label: 'Servers' }, { id: 'server-access', label: 'Server Access' }, { id: 'players', label: 'Players' }],
    permissions: snapshot?.assignablePermissions || [],
  }), [snapshot]);

  const memberItems = (snapshot?.directoryUsers || []).map((user) => ({
    id: user.id,
    label: user.fullName,
    subtitle: `@${user.username}`,
  }));

  const save = async () => {
    setSaving(true);
    try {
      await serverAccessApi.updateGroup(id, groupId, form);
      navigate(`/servers/${id}/users`);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete server group "${group?.name}"?`)) return;
    try {
      await serverAccessApi.deleteGroup(id, groupId);
      navigate(`/servers/${id}/users`);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="w-8 h-8 text-mc-accent animate-spin" /></div>;
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <button type="button" onClick={() => navigate(`/servers/${id}/users`)} className="p-2 hover:bg-mc-surfaceLight rounded-lg">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-white">{group?.name || 'Server group'}</h1>
          <p className="text-mc-textMuted mt-1">Server-only group for management-console users</p>
        </div>
        <button type="button" className="btn btn-secondary text-mc-danger" onClick={remove}><Trash2 className="w-4 h-4" /></button>
      </div>
      {error && <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{error}</div>}
      <div className="card mb-6 space-y-4">
        <label className="block">
          <span className="text-sm text-mc-textMuted">Name</span>
          <input className="input mt-1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm text-mc-textMuted">Description</span>
          <input className="input mt-1" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>
        <label className="flex items-center gap-2 text-sm text-white">
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
          Active
        </label>
      </div>
      <div className="card mb-6">
        <h2 className="font-semibold text-white mb-3">Members</h2>
        <ScrollableCheckList
          items={memberItems}
          selectedIds={form.userIds}
          onChange={(userIds) => setForm({ ...form, userIds })}
        />
      </div>
      <div className="card mb-6">
        <h2 className="font-semibold text-white mb-3">Permissions</h2>
        <PermissionEditor
          catalog={catalog}
          values={form.permissions}
          onChange={(permissions) => setForm({ ...form, permissions })}
        />
      </div>
      <div className="flex gap-3">
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => navigate(`/servers/${id}/users`)}>Cancel</button>
      </div>
    </div>
  );
}

export default ServerAccessGroup;
