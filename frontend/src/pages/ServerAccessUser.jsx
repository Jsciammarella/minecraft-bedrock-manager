import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Save, Trash2 } from 'lucide-react';
import { serverAccessApi } from '../services/api';
import PermissionEditor from '../components/PermissionEditor.jsx';

function ServerAccessUser() {
  const { id, userId } = useParams();
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [effective, setEffective] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [permissions, setPermissions] = useState({});

  const load = async () => {
    try {
      const [userRes, serverRes, effectiveRes] = await Promise.all([
        serverAccessApi.getUser(id, userId),
        serverAccessApi.server(id),
        serverAccessApi.effective(id, userId).catch(() => ({ data: null })),
      ]);
      setUser(userRes.data);
      setSnapshot(serverRes.data);
      setEffective(effectiveRes.data);
      setPermissions(userRes.data.permissions || {});
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id, userId]);

  const catalog = useMemo(() => ({
    categories: [{ id: 'servers', label: 'Servers' }, { id: 'server-access', label: 'Server Access' }, { id: 'players', label: 'Players' }],
    permissions: snapshot?.assignablePermissions || [],
  }), [snapshot]);

  const save = async () => {
    setSaving(true);
    try {
      await serverAccessApi.updateUser(id, userId, { explicit: true, permissions });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Remove ${user?.fullName} from this server?`)) return;
    try {
      await serverAccessApi.removeUser(id, userId);
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
          <h1 className="text-2xl font-bold text-white">{user?.fullName}</h1>
          <p className="text-mc-textMuted mt-1">@{user?.username} — direct server permissions</p>
        </div>
        <button type="button" className="btn btn-secondary text-mc-danger" onClick={remove}><Trash2 className="w-4 h-4" /></button>
      </div>
      {error && <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{error}</div>}
      <div className="card mb-6 text-sm text-mc-textMuted space-y-1">
        <p>Groups: {(user?.groups || []).map((g) => g.name).join(', ') || 'None'}</p>
        <p>Assignment: {user?.explicit ? 'explicit' : 'group membership only'}</p>
      </div>
      <div className="card mb-6">
        <h2 className="font-semibold text-white mb-3">Direct server permissions</h2>
        <PermissionEditor catalog={catalog} values={permissions} onChange={setPermissions} />
      </div>
      {effective?.permissions && (
        <div className="card mb-6">
          <h2 className="font-semibold text-white mb-3">Effective access</h2>
          <div className="space-y-2 max-h-80 overflow-auto">
            {Object.values(effective.permissions).slice(0, 40).map((item) => (
              <div key={item.permission} className="text-xs flex justify-between gap-3">
                <span className="font-mono text-mc-text">{item.permission}</span>
                <span className={item.decision === 'allow' ? 'text-green-400' : 'text-red-400'}>
                  {item.decision} {item.winningSource?.origin ? `(${item.winningSource.origin})` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
        <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}

export default ServerAccessUser;
