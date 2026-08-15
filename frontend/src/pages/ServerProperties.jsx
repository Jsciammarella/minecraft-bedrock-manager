import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { serverApi, portApi } from '../services/api';
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

  const [ports, setPorts] = useState({ used: [], available: [] });

  const [formData, setFormData] = useState({
    port: '',
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
    loadPorts();
  }, [id]);

  const loadServer = async () => {
    try {
      const res = await serverApi.getById(id);
      setServer(res.data);
      // Populate form with current values
      setFormData(prev => ({
        ...prev,
        port: String(res.data.port || ''),
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

  const loadPorts = async () => {
    try {
      const res = await portApi.getAll();
      setPorts(res.data);
    } catch (err) {
      console.error('Failed to load ports:', err);
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
      if (server?.kind === 'bedrock_connect') {
        if (autoUpdateEnabled) {
          await serverApi.enableAutoUpdate(id, autoUpdateInterval);
        }
        navigate(`/servers/${id}`, {
          replace: true,
          state: { message: 'Auto-update settings saved successfully.' },
        });
        return;
      }
      await serverApi.update(id, {
        ...formData,
        port: formData.port === '' ? undefined : parseInt(formData.port, 10),
      });
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

  const isBC = server?.kind === 'bedrock_connect';
  const portOptions = [];
  if (server?.port) portOptions.push(Number(server.port));
  if (server?.pending_port && !portOptions.includes(Number(server.pending_port))) {
    portOptions.push(Number(server.pending_port));
  }
  for (const item of ports.available || []) {
    if (!portOptions.includes(item.port)) portOptions.push(item.port);
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

      {isBC && (
        <div className="mb-6 p-4 bg-mc-darker border border-mc-surfaceLight rounded-lg text-sm text-mc-textMuted">
          Bedrock Connect port and gameplay settings cannot be changed. Auto-update works the same as a normal server.
        </div>
      )}

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
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">Server Port</label>
              <select
                name="port"
                value={formData.port}
                onChange={handleChange}
                className="input"
                disabled={isBC}
                required
              >
                {portOptions.map((port) => (
                  <option key={port} value={port}>{port}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-mc-textMuted">
                {isBC
                  ? 'Bedrock Connect must stay on UDP 19132 so consoles can reach it.'
                  : 'Only the current port and other open manager ports are shown. A new port applies after restart if the server is running.'}
              </p>
              {server?.pending_port && Number(server.pending_port) !== Number(server.port) && (
                <p className="mt-1 text-xs text-amber-300">
                  Port {server.pending_port} is queued and will apply on the next restart.
                </p>
              )}
            </div>
            <FormField label="Server Description" name="server_description" value={formData.server_description} onChange={handleChange} type="text" disabled={isBC} />
            <FormField label="Server MOTD" name="server_motd" value={formData.server_motd} onChange={handleChange} type="text" disabled={isBC} />
            <FormField label="Max Players" name="max_players" value={formData.max_players} onChange={handleChange} type="number" min="1" max="1000" disabled={isBC} />
            <FormField label="Level Seed" name="level_seed" value={formData.level_seed} onChange={handleChange} type="text" placeholder="Leave empty for random" disabled={isBC} />
          </div>
        </Section>

        {/* Game Settings */}
        <Section title="Game Settings">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SelectField label="Game Mode" name="gamemode" value={formData.gamemode} onChange={handleChange} disabled={isBC} options={[
              { value: 'survival', label: 'Survival' },
              { value: 'creative', label: 'Creative' },
              { value: 'adventure', label: 'Adventure' },
              { value: 'default', label: 'Default' },
            ]} />
            <SelectField label="Difficulty" name="difficulty" value={formData.difficulty} onChange={handleChange} disabled={isBC} options={[
              { value: 'peaceful', label: 'Peaceful' },
              { value: 'easy', label: 'Easy' },
              { value: 'normal', label: 'Normal' },
              { value: 'hard', label: 'Hard' },
            ]} />
            <FormField label="View Distance" name="view_distance" value={formData.view_distance} onChange={handleChange} type="number" min="2" max="32" disabled={isBC} />
            <FormField label="Tick Distance" name="tick_distance" value={formData.tick_distance} onChange={handleChange} type="number" min="1" max="10" disabled={isBC} />
            <FormField label="Player Idle Timeout (min)" name="player_idle_timeout" value={formData.player_idle_timeout} onChange={handleChange} type="number" min="0" max="1440" disabled={isBC} />
            <FormField label="TX Rate (FPS)" name="tx_rate" value={formData.tx_rate} onChange={handleChange} type="number" min="1" max="60" disabled={isBC} />
          </div>
        </Section>

        {/* Toggles */}
        <Section title="Server Options">
          <div className="space-y-4">
            <ToggleRow label="Enable Cheats" name="enable_cheats" value={formData.enable_cheats} onToggle={handleToggle} description="Allow cheats and commands" disabled={isBC} />
            <ToggleRow label="Server Authoritative" name="server_authoritative" value={formData.server_authoritative} onToggle={handleToggle} description="Server controls game logic" disabled={isBC} />
            <ToggleRow label="Whitelist Mode" name="whitelist_mode" value={formData.whitelist_mode} onToggle={handleToggle} description="Only whitelisted players can join" disabled={isBC} />
            <ToggleRow label="Texture Pack Required" name="texture_pack_required" value={formData.texture_pack_required} onToggle={handleToggle} description="Players must accept texture packs" disabled={isBC} />
            <ToggleRow label="Auto Ice" name="auto_ice" value={formData.auto_ice} onToggle={handleToggle} description="Water freezes into ice" disabled={isBC} />
            <ToggleRow label="Natural Regeneration" name="natural_regeneration" value={formData.natural_regeneration} onToggle={handleToggle} description="Health regenerates over time" disabled={isBC} />
            <ToggleRow label="Online Mode" name="online_mode" value={formData.online_mode} onToggle={handleToggle} description="Require Xbox Live authentication" disabled={isBC} />
            <ToggleRow label="Remote Discovery" name="remote_discovery" value={formData.remote_discovery} onToggle={handleToggle} description="Show server in external listings" disabled={isBC} />
            <ToggleRow label="Allow Third-Party Requests" name="allow_third_party_requests" value={formData.allow_third_party_requests} onToggle={handleToggle} description="Allow realms invites" disabled={isBC} />
            <ToggleRow label="Allow Third-Party Pictures" name="allow_third_party_pictures" value={formData.allow_third_party_pictures} onToggle={handleToggle} description="Allow skin data from third parties" disabled={isBC} />
            <ToggleRow label="Require Secure Chat" name="require_secure_chat" value={formData.require_secure_chat} onToggle={handleToggle} description="Enforce chat signing" disabled={isBC} />
            <ToggleRow label="Server Authoritative Inventory" name="server_authoritative_inventory" value={formData.server_authoritative_inventory} onToggle={handleToggle} description="Server manages inventory" disabled={isBC} />
            <ToggleRow label="Enable Player Data Init" name="enable_player_data_initialization" value={formData.enable_player_data_initialization} onToggle={handleToggle} description="Create player data on first join" disabled={isBC} />
          </div>
        </Section>

        {/* Permission */}
        <Section title="Permissions">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SelectField label="Default Player Permission" name="default_player_permission" value={formData.default_player_permission} onChange={handleChange} disabled={isBC} options={[
              { value: 'visitor', label: 'Visitor' },
              { value: 'member', label: 'Member' },
              { value: 'operator', label: 'Operator' },
            ]} />
            <SelectField label="Default 1st Person" name="default_1st_person" value={formData.default_1st_person} onChange={handleChange} disabled={isBC} options={[
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
                {isBC
                  ? 'Automatically check for and install Bedrock Connect JAR updates. Updates apply when Bedrock Connect is stopped.'
                  : 'Automatically check for and install server updates. Updates will only be applied when the server is stopped, and addons/worlds will be preserved.'}
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
          <button type="button" onClick={loadServer} disabled={isBC} className="btn btn-secondary">
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

function SelectField({ label, name, value, onChange, options, disabled = false }) {
  return (
    <div>
      <label className="block text-sm font-medium text-mc-text mb-2">{label}</label>
      <select name={name} value={value} onChange={onChange} className="input" disabled={disabled}>
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

function ToggleRow({ label, name, value, onToggle, description, disabled = false }) {
  return (
    <div className={`flex items-center justify-between p-3 bg-mc-darker rounded-lg ${disabled ? 'opacity-50' : ''}`}>
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="text-xs text-mc-textMuted">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => { if (!disabled) onToggle(name); }}
        disabled={disabled}
        className={`toggle ${value === 1 ? 'toggle-active' : 'toggle-inactive'} ${disabled ? 'cursor-not-allowed' : ''}`}
      >
        <span className={`toggle-thumb ${value === 1 ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}

export default ServerProperties;
