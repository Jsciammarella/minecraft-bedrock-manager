import { Play, Square, Loader2 } from 'lucide-react';
import { serverApi } from '../services/api';

export const CONTROL_DISABLED_REASONS = {
  'remote-java': 'This is a remote Java server. Only the attached Geyser gateway can be managed here.',
  'plugin-disabled': 'This plugin is disabled. Re-enable it from Plugins.',
};

const TAG_CLASSES = {
  info: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  success: 'bg-green-500/15 text-green-400 border-green-500/30',
  warning: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  danger: 'bg-red-500/15 text-red-400 border-red-500/30',
  muted: 'bg-mc-surfaceLight/80 text-mc-textMuted border-mc-surfaceLight',
};

const INDICATOR_BADGE = {
  online: 'badge badge-success',
  offline: 'badge badge-danger',
  starting: 'badge badge-warning',
  degraded: 'badge badge-warning',
  failed: 'badge badge-danger',
  plugin_disabled: 'badge badge-warning',
};

const INDICATOR_DOT = {
  online: 'bg-green-400',
  offline: 'bg-red-400',
  starting: 'bg-yellow-400 animate-pulse',
  degraded: 'bg-yellow-400',
  failed: 'bg-red-400',
  plugin_disabled: 'bg-amber-400',
};

const BUTTON_CLASSES = {
  primary: 'btn btn-primary',
  secondary: 'btn btn-secondary',
  danger: 'btn btn-danger',
  warning: 'btn btn-warning',
};

export function pluginContributionsOf(server) {
  return Array.isArray(server?.pluginContributions) ? server.pluginContributions : [];
}

function contributionActions(server, placement) {
  return pluginContributionsOf(server).flatMap((item) => (
    (item.actions || [])
      .filter((action) => action.placement === placement)
      .map((action) => ({
        ...action,
        pluginId: item.pluginId,
        attachmentId: item.attachmentId,
        serverId: item.serverId,
      }))
  ));
}

export function primarySplitActions(server) {
  return contributionActions(server, 'primary-split');
}

export function secondaryPluginActions(server) {
  return contributionActions(server, 'secondary');
}

export function lanToggleActions(server) {
  return contributionActions(server, 'lan-toggle');
}

export function pluginCompatibilityWarnings(server) {
  return pluginContributionsOf(server).flatMap((item) => (
    (item.summary || [])
      .filter((field) => field.id === 'compatibilityWarning' && field.value)
      .map((field) => ({
        attachmentId: item.attachmentId,
        pluginId: item.pluginId,
        label: field.label || 'Compatibility',
        value: field.value,
      }))
  ));
}

export function PluginTags({ server, contributions }) {
  const tags = (contributions || pluginContributionsOf(server)).flatMap((item) => item.tags || []);
  if (!tags.length) return null;
  return tags.map((tag) => (
    <span
      key={tag.id}
      className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${TAG_CLASSES[tag.style] || TAG_CLASSES.info}`}
    >
      {tag.label}
    </span>
  ));
}

export function PluginIndicators({ server, contributions }) {
  const indicators = (contributions || pluginContributionsOf(server)).flatMap((item) => item.indicators || []);
  if (!indicators.length) return null;
  return (
    <>
      {indicators.map((item) => (
        <span key={item.id} className={INDICATOR_BADGE[item.state] || 'badge badge-info'}>
          <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${INDICATOR_DOT[item.state] || 'bg-mc-textMuted'}`} />
          {item.label}
        </span>
      ))}
    </>
  );
}

export async function runPluginAction({ server, action }) {
  const payload = {
    pluginId: action.pluginId,
    actionId: action.id,
    attachmentId: action.attachmentId,
    resourceId: String(action.attachmentId || '').includes(':')
      ? String(action.attachmentId).split(':').slice(1).join(':')
      : action.resourceId,
  };
  if (server?.kind === 'geyser_gateway' || String(server?.id || '').startsWith('gateway:')) {
    return serverApi.runPluginAction({
      ...payload,
      attachmentId: server.id,
    });
  }
  return serverApi.runPluginActionForServer(server.id, payload);
}

function PluginActionButtons({ server, actions, pending = {}, onAction, flex }) {
  if (!actions.length) return null;
  return (
    <>
      {actions.map((action) => {
        const key = `${server.id}-${action.pluginId}-${action.id}`;
        const busy = Boolean(pending[key]);
        const disabled = action.state !== 'enabled' || busy;
        const Icon = action.icon === 'stop' ? Square : action.icon === 'play' ? Play : null;
        return (
          <button
            key={`${action.pluginId}-${action.id}`}
            type="button"
            className={`${BUTTON_CLASSES[action.variant] || BUTTON_CLASSES.secondary} ${flex ? 'flex-1' : ''} text-sm`}
            disabled={disabled}
            title={action.state !== 'enabled' ? (action.disabledReason || CONTROL_DISABLED_REASONS['plugin-disabled']) : action.label}
            aria-label={action.label}
            onClick={(event) => {
              event.stopPropagation();
              if (action.confirmation && !window.confirm(action.label)) return;
              onAction(action);
            }}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (Icon ? <Icon className="w-3.5 h-3.5" /> : null)}
            {busy ? 'Working...' : action.label}
          </button>
        );
      })}
    </>
  );
}

export function PluginPrimaryActions({ server, pending = {}, onAction }) {
  return (
    <PluginActionButtons
      server={server}
      actions={primarySplitActions(server)}
      pending={pending}
      onAction={onAction}
      flex
    />
  );
}

export function PluginSecondaryActions({ server, pending = {}, onAction }) {
  return (
    <PluginActionButtons
      server={server}
      actions={secondaryPluginActions(server)}
      pending={pending}
      onAction={onAction}
    />
  );
}

export function PluginLanActions({ server, pending = {}, onAction }) {
  const actions = lanToggleActions(server);
  if (!actions.length) return null;
  return (
    <>
      {actions.map((action) => {
        const key = `${server.id}-${action.pluginId}-${action.id}`;
        const busy = Boolean(pending[key]);
        const on = Boolean(action.active || action.waiting);
        const disabled = action.state !== 'enabled' || busy;
        const title = action.disabledReason
          || (action.waiting ? 'LAN advertising will resume when Geyser starts.' : action.label);
        return (
          <button
            key={`${action.pluginId}-${action.id}`}
            type="button"
            className={`btn text-sm ${
              disabled && !on
                ? 'bg-mc-surfaceLight text-mc-textMuted'
                : on
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 hover:bg-sky-500/30'
                  : 'btn-secondary'
            }`}
            disabled={disabled}
            title={title}
            aria-label="LAN"
            aria-pressed={on}
            onClick={(event) => {
              event.stopPropagation();
              if (disabled) return;
              onAction(action);
            }}
          >
            {busy ? '...' : action.label}
          </button>
        );
      })}
    </>
  );
}

export function PluginDetailSummary({ server, pending, onAction, onManage }) {
  const contributions = pluginContributionsOf(server);
  if (!contributions.length) return null;
  return (
    <div className="space-y-4 mb-4">
      {contributions.map((item) => (
        <div key={item.attachmentId} className="card p-4">
          <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
            <h2 className="text-sm font-semibold text-white">{item.management?.label || 'Attached plugin'}</h2>
            <div className="flex items-center gap-1 flex-wrap">
              <PluginIndicators contributions={[item]} />
            </div>
          </div>
          <div className="flex items-center gap-1 flex-wrap mb-3">
            <PluginTags contributions={[item]} />
          </div>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm mb-3">
            {(item.summary || []).map((field) => (
              <div key={field.id} className={field.id === 'compatibilityWarning' ? 'md:col-span-2 p-2 rounded-lg border border-amber-500/30 bg-amber-500/10' : ''}>
                <dt className="text-xs text-mc-textMuted">{field.label}</dt>
                <dd className={`${field.id === 'compatibilityWarning' ? 'text-amber-200' : 'text-white'} break-all`}>{field.value || '—'}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-2">
            <PluginPrimaryActions
              server={{ ...server, pluginContributions: [item] }}
              pending={pending}
              onAction={onAction}
            />
            <PluginSecondaryActions
              server={{ ...server, pluginContributions: [item] }}
              pending={pending}
              onAction={onAction}
            />
            {item.management?.href && (
              <button
                type="button"
                className="btn btn-secondary text-sm"
                onClick={() => onManage(item.controlPolicy === 'plugin-disabled' ? '/plugins' : item.management.href)}
              >
                {item.controlPolicy === 'plugin-disabled' ? 'Open Plugins' : item.management.label}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
