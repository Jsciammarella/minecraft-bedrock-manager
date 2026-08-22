import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { authApi, userManagementApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import PasswordPolicyHints from '../components/PasswordPolicyHints.jsx';
import { DEFAULT_PASSWORD_POLICY, validatePassword } from '../utils/passwordPolicy';
import { scrollPageTop } from '../utils/scrollPageTop';

function AccountSettings() {
  const { isAdmin, refresh } = useAuth();
  const [settings, setSettings] = useState({
    sessionHours: 168,
    defaultGroupId: null,
    minLength: 6,
    history: 0,
    requireUpper: false,
    requireLower: false,
    requireNumber: false,
    requireSpecial: false,
  });
  const [groups, setGroups] = useState([]);
  const [policy, setPolicy] = useState(DEFAULT_PASSWORD_POLICY);
  const [password, setPassword] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = async () => {
    try {
      const policyRes = await authApi.passwordPolicy().catch(() => ({ data: DEFAULT_PASSWORD_POLICY }));
      setPolicy(policyRes.data || DEFAULT_PASSWORD_POLICY);
      if (isAdmin) {
        const [settingsRes, groupRes] = await Promise.all([
          userManagementApi.settings(),
          userManagementApi.groups(),
        ]);
        setSettings({
          sessionHours: settingsRes.data?.sessionHours ?? 168,
          defaultGroupId: settingsRes.data?.defaultGroupId ?? null,
          minLength: settingsRes.data?.minLength ?? 6,
          history: settingsRes.data?.history ?? 0,
          requireUpper: Boolean(settingsRes.data?.requireUpper),
          requireLower: Boolean(settingsRes.data?.requireLower),
          requireNumber: Boolean(settingsRes.data?.requireNumber),
          requireSpecial: Boolean(settingsRes.data?.requireSpecial),
        });
        setGroups(groupRes.data || []);
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
        passwordMinLength: Number(settings.minLength),
        passwordHistory: Number(settings.history),
        passwordRequireUpper: Boolean(settings.requireUpper),
        passwordRequireLower: Boolean(settings.requireLower),
        passwordRequireNumber: Boolean(settings.requireNumber),
        passwordRequireSpecial: Boolean(settings.requireSpecial),
      });
      setSettings((prev) => ({
        ...prev,
        ...res.data,
      }));
      setPolicy(res.data);
      setSuccess('Settings saved');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
      scrollPageTop();
    }
  };

  const savePassword = async (event) => {
    event.preventDefault();
    const passwordError = validatePassword(password.newPassword, policy, { confirm: password.confirm });
    if (passwordError) {
      setError(passwordError);
      scrollPageTop();
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
          <input type="password" className="input" minLength={policy.minLength} maxLength={policy.maxLength} value={password.newPassword} onChange={(e) => setPassword((prev) => ({ ...prev, newPassword: e.target.value }))} required />
        </div>
        <div>
          <label className="block text-sm font-medium text-mc-text mb-2">Verify new password</label>
          <input type="password" className="input" minLength={policy.minLength} maxLength={policy.maxLength} value={password.confirm} onChange={(e) => setPassword((prev) => ({ ...prev, confirm: e.target.value }))} required />
        </div>
        <PasswordPolicyHints policy={policy} />
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
          <div>
            <h4 className="text-sm font-semibold text-white mb-3">Password complexity</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Minimum characters</label>
                <input
                  type="number"
                  min="1"
                  max="200"
                  className="input"
                  value={settings.minLength}
                  onChange={(e) => setSettings((prev) => ({ ...prev, minLength: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Password history</label>
                <input
                  type="number"
                  min="0"
                  max="24"
                  className="input"
                  value={settings.history}
                  onChange={(e) => setSettings((prev) => ({ ...prev, history: e.target.value }))}
                />
                <p className="text-xs text-mc-textMuted mt-2">Number of previous passwords that cannot be reused. Use 0 to disable history.</p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
              {[
                { key: 'requireUpper', label: 'Require uppercase letter' },
                { key: 'requireLower', label: 'Require lowercase letter' },
                { key: 'requireNumber', label: 'Require number' },
                { key: 'requireSpecial', label: 'Require special character' },
              ].map((item) => (
                <label key={item.key} className="input flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(settings[item.key])}
                    onChange={(e) => setSettings((prev) => ({ ...prev, [item.key]: e.target.checked }))}
                  />
                  <span className="text-sm text-white">{item.label}</span>
                </label>
              ))}
            </div>
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
