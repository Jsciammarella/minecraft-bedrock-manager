import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Play, Square, RotateCcw, Terminal, Users, Settings, Clock,
  Package, Trash2, Download, Radio, AlertTriangle, ExternalLink,
} from 'lucide-react';
import { dashboardApi } from '../services/api';

const DISABLED_REASON = 'This Geyser server is managed by the Geyser plugin.';

const DISABLED_ACTIONS = [
  { key: 'start', label: 'Start', Icon: Play },
  { key: 'stop', label: 'Stop', Icon: Square },
  { key: 'restart', label: 'Restart', Icon: RotateCcw },
  { key: 'warn-restart', label: 'Restart with warning', Icon: AlertTriangle },
  { key: 'console', label: 'Console', Icon: Terminal },
  { key: 'properties', label: 'Properties', Icon: Settings },
  { key: 'mods', label: 'Mods', Icon: Package },
  { key: 'files', label: 'Files', Icon: Download },
  { key: 'players', label: 'Players', Icon: Users },
  { key: 'allow', label: 'Allow list', Icon: Users },
  { key: 'ban', label: 'Ban list', Icon: Users },
  { key: 'backups', label: 'Backups', Icon: Clock },
  { key: 'updates', label: 'Server updates', Icon: Download },
  { key: 'delete', label: 'Delete', Icon: Trash2 },
];

function statusLabel(status) {
  if (status === 'plugin_disabled') return 'Plugin disabled';
  if (status === 'protocol_incompatible') return 'Protocol incompatible';
  if (status === 'auth_misconfigured') return 'Authentication misconfigured';
  if (status === 'target_unreachable') return 'Target unreachable';
  if (status === 'port_conflict') return 'Port conflict';
  return status || 'unknown';
}

export default function GatewayDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [entity, setEntity] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    dashboardApi.gateway(id)
      .then((res) => {
        if (!cancelled) {
          setEntity(res.data);
          setError('');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || err.message || 'Geyser server not found');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const timer = setInterval(() => {
      dashboardApi.gateway(id).then((res) => setEntity(res.data)).catch(() => {});
    }, 5000);
    const onRefresh = () => {
      dashboardApi.gateway(id).then((res) => setEntity(res.data)).catch(() => {});
    };
    window.addEventListener('server-status-change', onRefresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('server-status-change', onRefresh);
    };
  }, [id]);

  if (loading && !entity) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-mc-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !entity) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <button className="btn btn-secondary mb-4" onClick={() => navigate('/')}>
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="card text-red-400">{error || 'Geyser server not found'}</div>
      </div>
    );
  }

  const pluginDisabled = Boolean(entity.pluginDisabled || entity.status === 'plugin_disabled');
  const manageHref = pluginDisabled
    ? '/plugins'
    : (entity.managementUrl || `/plugins/gateway-geyser?gatewayId=${String(entity.id || '').replace(/^gateway:/, '')}`);
  const connect = entity.connectAddress && entity.port
    ? `${entity.connectAddress}:${entity.port}`
    : entity.connectAddress || `UDP ${entity.port || ''}`;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <button className="btn btn-secondary mb-4" onClick={() => navigate('/')}>
        <ArrowLeft className="w-4 h-4" /> Dashboard
      </button>

      <div className="card mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-white">{entity.name}</h1>
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                Geyser Server
              </span>
            </div>
            <p className="text-sm text-mc-textMuted mt-2">Read-only dashboard view. Lifecycle and configuration stay in the Geyser plugin.</p>
          </div>
          <span className={`badge ${pluginDisabled || entity.status === 'stopped' || entity.status === 'failed' ? 'badge-danger' : entity.status === 'running' ? 'badge-success' : 'badge-warning'}`}>
            {statusLabel(entity.status)}
          </span>
        </div>

        {pluginDisabled && (
          <div className="mt-4 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-200 text-sm">
            The Geyser plugin is disabled. This tile remains so you can still find the gateway. Re-enable the plugin from Plugins to manage it.
          </div>
        )}
        {entity.lastError && (
          <div className="mt-4 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 text-sm">
            {entity.lastError}
          </div>
        )}

        <dl className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-6 text-sm">
          <div><dt className="text-mc-textMuted">Bedrock address</dt><dd className="text-white font-mono">{connect}</dd></div>
          <div><dt className="text-mc-textMuted">Bedrock UDP port</dt><dd className="text-white font-mono">{entity.port}</dd></div>
          <div><dt className="text-mc-textMuted">Java target</dt><dd className="text-white">{entity.targetSummary || '—'}</dd></div>
          <div><dt className="text-mc-textMuted">Compatibility</dt><dd className="text-white">{entity.compatibilityMode === 'viaproxy' ? 'ViaProxy' : 'Direct Geyser'}</dd></div>
          <div><dt className="text-mc-textMuted">Authentication</dt><dd className="text-white">{entity.authentication || '—'}</dd></div>
          <div><dt className="text-mc-textMuted">Geyser version</dt><dd className="text-white">{entity.geyserVersion || '—'}</dd></div>
          <div><dt className="text-mc-textMuted">ViaProxy version</dt><dd className="text-white">{entity.viaproxyVersion || 'not installed'}</dd></div>
          <div><dt className="text-mc-textMuted">Health</dt><dd className="text-white">{statusLabel(entity.health || entity.status)}</dd></div>
        </dl>
      </div>

      <div className="card mb-6">
        <h2 className="text-lg font-semibold text-white mb-2">Server actions</h2>
        <p className="text-sm text-mc-textMuted mb-4">{DISABLED_REASON}</p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {DISABLED_ACTIONS.map((action) => (
            <button
              key={action.key}
              type="button"
              disabled
              title={DISABLED_REASON}
              className="btn btn-secondary text-sm opacity-50 cursor-not-allowed justify-start"
            >
              <action.Icon className="w-3.5 h-3.5" />
              {action.label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary"
        onClick={() => navigate(manageHref)}
      >
        <ExternalLink className="w-4 h-4" />
        {pluginDisabled ? 'Open Plugins' : 'Manage in Geyser Plugin'}
      </button>
    </div>
  );
}
