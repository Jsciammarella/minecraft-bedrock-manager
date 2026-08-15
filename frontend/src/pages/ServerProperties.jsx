import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { serverApi } from '../services/api';
import { ArrowLeft, Save, Loader2, Check, AlertCircle, RefreshCw } from 'lucide-react';

function ServerProperties() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [server, setServer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  // Auto-update state
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(false);
  const [autoUpdateInterval, setAutoUpdateInterval] = useState(24);
  const [autoUpdating, setAutoUpdating] = useState(false);

  const [formData, setFormData] = useState({
    max_players: '10',
    difficulty: 'peaceful',
    gamemode: 'survival',
    whitelist_mode: 0,
    server_description: '',
    server_motd: '',
    texture_pack_required: 0,
    enable_cheats: 1,
    server_authoritative: 1,
    default_1st_person: 1,
    view_distance: '32',
    tick_distance: '4',
    player_idle_timeout: '30',
    allow_third_party_requests: 0,
    allow_third_party_pictures: 0,
    online_mode: 1,
    require_secure_chat: 0,
    server_authoritative_inventory: 1,
    enable_player_data_initialization: 1,
    level_seed: '',
    default_player_permission: 'member',
    auto_ice: 1,
    natural_regeneration: 1,
    remote_discovery: 0,
    tx_rate: '30',
  });

  useEffect(() => {
    loadServer();
    loadAutoUpdateConfig();
  }, [id]);

  const loadServer = async () => {
    try {
      const res = await serverApi.getById(id);
      setServer(res.data);
      // Populate form with current values
      setFormData(prev => ({
        ...prev,
        max_players: String(res.data.max_players || 10),
        difficulty: res.data.difficulty || 'peaceful',
        gamemode: res.data.gamemode || 'survival',
        whitelist_mode: res.data.whitelist_mode || 0,
        server_description: res.data.server_description || '',
        server_motd: res.data.server_motd || '',
        texture_pack_required: res.data.texture_pack_required || 0,
        enable_cheats: res.data.enable_cheats ?? 1,
        server_authoritative: res.data.server_authoritative ?? 1,
        default_1st_person: res.data.default_1st_person ?? 1,
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadAutoUpdateConfig = async () => {
    try {
      const res = await serverApi.getAutoUpdate(id);
      if (res.data) {
        setAutoUpdateEnabled(!!res.data.enabled);
        setAutoUpdateInterval(res.data.check_interval_hours || 24);
      }
    } catch (err) {
      console.error('Failed to load auto-update config:', err);
    }
  };

  const handleAutoUpdateToggle = async () => {
    setAutoUpdating(true);
    setError('');
    setSuccess('');
    try {
      if (autoUpdateEnabled) {
        await serverApi.disableAutoUpdate(id);
        setAutoUpdateEnabled(false);
        setSuccess('Auto-update disabled');
      } else {
        await serverApi.enableAutoUpdate(id, autoUpdateInterval);
        setAutoUpdateEnabled(true);
        setSuccess('Auto-update enabled');
      }
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to update auto-update settings');
    } finally {
      setAutoUpdating(false);
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (checked ? 1 : 0) : value
    }));
  };

  const handleToggle = (name) => {
    setFormData(prev => ({
      ...prev,
      [name]: prev[name] === 1 ? 0 : 1
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      await serverApi.update(id, formData);
      navigate(`/servers/${id}`, {
        replace: true,
        state: { message: 'Server properties saved successfully.' },
      });
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-mc-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-mc-textMuted">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">Server Properties</h1>
          <p className="text-mc-textMuted mt-1">{server?.name} — Configure all server settings</p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {success && (
        <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-3">
          <Check className="w-5 h-5 text-green-400 flex-shrink-0" />
          <p className="text-sm text-green-400">{success}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* General Settings */}
        <Section title="General Settings">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField label="Server Description" name="server_description" value={formData.server_description} onChange={handleChange} type="text" />
            <FormField label="Server MOTD" name="server_motd" value={formData.server_motd} onChange={handleChange} type="text" />
            <FormField label="Max Players" name="max_players" value={formData.max_players} onChange={handleChange} type="number" min="1" max="1000" />
            <FormField label="Level Seed" name="level_seed" value={formData.level_seed} onChange={handleChange} type="text" placeholder="Leave empty for random" />
          </div>
        </Section>

        {/* Game Settings */}
        <Section title="Game Settings">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SelectField label="Game Mode" name="gamemode" value={formData.gamemode} onChange={handleChange} options={[
              { value: 'survival', label: 'Survival' },
              { value: 'creative', label: 'Creative' },
              { value: 'adventure', label: 'Adventure' },
              { value: 'default', label: 'Default' },
            ]} />
            <SelectField label="Difficulty" name="difficulty" value={formData.difficulty} onChange={handleChange} options={[
              { value: 'peaceful', label: 'Peaceful' },
              { value: 'easy', label: 'Easy' },
              { value: 'normal', label: 'Normal' },
              { value: 'hard', label: 'Hard' },
            ]} />
            <FormField label="View Distance" name="view_distance" value={formData.view_distance} onChange={handleChange} type="number" min="2" max="32" />
            <FormField label="Tick Distance" name="tick_distance" value={formData.tick_distance} onChange={handleChange} type="number" min="1" max="10" />
            <FormField label="Player Idle Timeout (min)" name="player_idle_timeout" value={formData.player_idle_timeout} onChange={handleChange} type="number" min="0" max="1440" />
            <FormField label="TX Rate (FPS)" name="tx_rate" value={formData.tx_rate} onChange={handleChange} type="number" min="1" max="60" />
          </div>
        </Section>

        {/* Toggles */}
        <Section title="Server Options">
          <div className="space-y-4">
            <ToggleRow label="Enable Cheats" name="enable_cheats" value={formData.enable_cheats} onToggle={handleToggle} description="Allow cheats and commands" />
            <ToggleRow label="Server Authoritative" name="server_authoritative" value={formData.server_authoritative} onToggle={handleToggle} description="Server controls game logic" />
            <ToggleRow label="Whitelist Mode" name="whitelist_mode" value={formData.whitelist_mode} onToggle={handleToggle} description="Only whitelisted players can join" />
            <ToggleRow label="Texture Pack Required" name="texture_pack_required" value={formData.texture_pack_required} onToggle={handleToggle} description="Players must accept texture packs" />
            <ToggleRow label="Auto Ice" name="auto_ice" value={formData.auto_ice} onToggle={handleToggle} description="Water freezes into ice" />
            <ToggleRow label="Natural Regeneration" name="natural_regeneration" value={formData.natural_regeneration} onToggle={handleToggle} description="Health regenerates over time" />
            <ToggleRow label="Online Mode" name="online_mode" value={formData.online_mode} onToggle={handleToggle} description="Require Xbox Live authentication" />
            <ToggleRow label="Remote Discovery" name="remote_discovery" value={formData.remote_discovery} onToggle={handleToggle} description="Show server in external listings" />
            <ToggleRow label="Allow Third-Party Requests" name="allow_third_party_requests" value={formData.allow_third_party_requests} onToggle={handleToggle} description="Allow realms invites" />
            <ToggleRow label="Allow Third-Party Pictures" name="allow_third_party_pictures" value={formData.allow_third_party_pictures} onToggle={handleToggle} description="Allow skin data from third parties" />
            <ToggleRow label="Require Secure Chat" name="require_secure_chat" value={formData.require_secure_chat} onToggle={handleToggle} description="Enforce chat signing" />
            <ToggleRow label="Server Authoritative Inventory" name="server_authoritative_inventory" value={formData.server_authoritative_inventory} onToggle={handleToggle} description="Server manages inventory" />
            <ToggleRow label="Enable Player Data Init" name="enable_player_data_initialization" value={formData.enable_player_data_initialization} onToggle={handleToggle} description="Create player data on first join" />
          </div>
        </Section>

        {/* Permission */}
        <Section title="Permissions">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SelectField label="Default Player Permission" name="default_player_permission" value={formData.default_player_permission} onChange={handleChange} options={[
              { value: 'visitor', label: 'Visitor' },
              { value: 'member', label: 'Member' },
              { value: 'operator', label: 'Operator' },
            ]} />
            <SelectField label="Default 1st Person" name="default_1st_person" value={formData.default_1st_person} onChange={handleChange} options={[
              { value: '0', label: 'Off' },
              { value: '1', label: 'On' },
            ]} />
          </div>
        </Section>

        {/* Auto-Update Settings */}
        <Section title="Auto-Update">
          <div className="space-y-4">
            <div className="p-4 bg-mc-darker rounded-lg">
              <p className="text-sm text-mc-textMuted mb-3">
                Automatically check for and install server updates. Updates will only be applied when the server is stopped, and addons/worlds will be preserved.
              </p>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">Enable Auto-Update</p>
                  <p className="text-xs text-mc-textMuted">Automatically update to the latest version</p>
                </div>
                <button
                  type="button"
                  onClick={handleAutoUpdateToggle}
                  disabled={autoUpdating}
                  className={`toggle ${autoUpdateEnabled ? 'toggle-active' : 'toggle-inactive'}`}
                >
                  <span className={`toggle-thumb ${autoUpdateEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>
            {autoUpdateEnabled && (
              <div className="animate-slide-up">
                <label className="block text-sm font-medium text-mc-text mb-2">Check Interval (hours)</label>
                <select
                  value={autoUpdateInterval}
                  onChange={(e) => setAutoUpdateInterval(parseInt(e.target.value))}
                  className="input"
                >
                  <option value={1}>Every hour</option>
                  <option value={4}>Every 4 hours</option>
                  <option value={12}>Every 12 hours</option>
                  <option value={24}>Every 24 hours</option>
                  <option value={48}>Every 48 hours</option>
                  <option value={72}>Every 72 hours</option>
                  <option value={168}>Once a week</option>
                </select>
              </div>
            )}
          </div>
        </Section>

        {/* Submit */}
        <div className="flex items-center gap-3 pt-4 border-t border-mc-surfaceLight">
          <button type="submit" disabled={saving} className="btn btn-primary flex-1">
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Settings
              </>
            )}
          </button>
          <button type="button" onClick={loadServer} className="btn btn-secondary">
            <RefreshCw className="w-4 h-4" />
            Reset
          </button>
          <button type="button" onClick={() => navigate(-1)} className="btn btn-secondary">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-white mb-4">{title}</h2>
      {children}
    </div>
  );
}

function FormField({ label, name, value, onChange, type = 'text', ...props }) {
  return (
    <div>
      <label className="block text-sm font-medium text-mc-text mb-2">{label}</label>
      <input type={type} name={name} value={value} onChange={onChange} className="input" {...props} />
    </div>
  );
}

function SelectField({ label, name, value, onChange, options }) {
  return (
    <div>
      <label className="block text-sm font-medium text-mc-text mb-2">{label}</label>
      <select name={name} value={value} onChange={onChange} className="input">
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

function ToggleRow({ label, name, value, onToggle, description }) {
  return (
    <div className="flex items-center justify-between p-3 bg-mc-darker rounded-lg">
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="text-xs text-mc-textMuted">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onToggle(name)}
        className={`toggle ${value === 1 ? 'toggle-active' : 'toggle-inactive'}`}
      >
        <span className={`toggle-thumb ${value === 1 ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}

export default ServerProperties;
