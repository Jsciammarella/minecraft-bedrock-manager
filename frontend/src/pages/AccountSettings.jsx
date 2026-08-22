import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { authApi, userManagementApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

function AccountSettings() {
  const { isAdmin, refresh } = useAuth();
  const [settings, setSettings] = useState({ sessionHours: 168, defaultGroupId: null });
  const [groups, setGroups] = useState([]);
  const [password, setPassword] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = async () => {
    try {
      const requests = [userManagementApi.groups()];
      if (isAdmin) requests.unshift(userManagementApi.settings());
      const results = await Promise.all(requests);
      if (isAdmin) {
        setSettings(results[0].data || settings);
        setGroups(results[1].data || []);
      } else {
        setGroups(results[0].data || []);
      }
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [isAdmin]);

  const saveSettings = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const res = await userManagementApi.saveSettings({
        sessionHours: Number(settings.sessionHours),
        defaultGroupId: settings.defaultGroupId || null,
      });
      setSettings(res.data);
      setSuccess('Settings saved');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const savePassword = async (event) => {
    event.preventDefault();
    if (password.newPassword !== password.confirm) {
      setError('New passwords do not match');
      return;
    }
    setSavingPassword(true);
    setError('');
    setSuccess('');
    try {
      await authApi.changePassword(password);
      setPassword({ currentPassword: '', newPassword: '', confirm: '' });
      setSuccess('Password updated');
      await refresh();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSavingPassword(false);
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
    <div className="space-y-6">
      {error && <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{error}</div>}
      {success && <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-400">{success}</div>}

      <form onSubmit={savePassword} className="card space-y-4">
        <h3 className="text-lg font-semibold text-white">Your password</h3>
        <div>
          <label className="block text-sm font-medium text-mc-text mb-2">Current password</label>
          <input type="password" className="input" value={password.currentPassword} onChange={(e) => setPassword((prev) => ({ ...prev, currentPassword: e.target.value }))} required />
        </div>
        <div>
          <label className="block text-sm font-medium text-mc-text mb-2">New password</label>
          <input type="password" className="input" minLength={6} value={password.newPassword} onChange={(e) => setPassword((prev) => ({ ...prev, newPassword: e.target.value }))} required />
        </div>
        <div>
          <label className="block text-sm font-medium text-mc-text mb-2">Confirm new password</label>
          <input type="password" className="input" minLength={6} value={password.confirm} onChange={(e) => setPassword((prev) => ({ ...prev, confirm: e.target.value }))} required />
        </div>
        <button type="submit" disabled={savingPassword} className="btn btn-primary">
          {savingPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Update password
        </button>
      </form>

      {isAdmin && (
        <form onSubmit={saveSettings} className="card space-y-4">
          <h3 className="text-lg font-semibold text-white">Platform settings</h3>
          <div>
            <label className="block text-sm font-medium text-mc-text mb-2">Session timeout (hours)</label>
            <input
              type="number"
              min="1"
              max="720"
              className="input"
              value={settings.sessionHours}
              onChange={(e) => setSettings((prev) => ({ ...prev, sessionHours: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-mc-text mb-2">Default group for new users</label>
            <select
              className="input"
              value={settings.defaultGroupId || ''}
              onChange={(e) => setSettings((prev) => ({ ...prev, defaultGroupId: e.target.value ? Number(e.target.value) : null }))}
            >
              <option value="">Standard group (if present)</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>{group.name}</option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={saving} className="btn btn-primary">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save settings
          </button>
        </form>
      )}
    </div>
  );
}

export default AccountSettings;
