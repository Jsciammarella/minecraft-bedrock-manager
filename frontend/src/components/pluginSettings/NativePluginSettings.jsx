import { useEffect, useState } from 'react';
import {
  AlertCircle, Check, Download, Eye, EyeOff, Folder, GitBranch, Loader2, RefreshCw, Save,
} from 'lucide-react';
import { pluginApi } from '../../services/api';

const ICONS = {
  save: Save,
  refresh: RefreshCw,
  check: Check,
  download: Download,
  folder: Folder,
  eye: Eye,
  alert: AlertCircle,
};

export function SettingsPageHeader({ title, description }) {
  return (
    <div className="mb-8">
      <h1 className="text-2xl font-bold text-white">{title}</h1>
      {description ? <p className="text-mc-textMuted mt-1">{description}</p> : null}
    </div>
  );
}

export function SettingsSection({ title, description, children }) {
  return (
    <div className="card">
      {title ? <h2 className="text-lg font-semibold text-white mb-4">{title}</h2> : null}
      {description ? <p className="text-sm text-mc-textMuted mb-4">{description}</p> : null}
      {children}
    </div>
  );
}

export function HelpText({ children }) {
  if (!children) return null;
  return <p className="text-xs text-mc-textMuted mt-2">{children}</p>;
}

export function DocLink({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-mc-accent hover:underline">
      {children}
    </a>
  );
}

export function StatusBadge({ configured }) {
  return (
    <span className={`badge ${configured ? 'badge-success' : 'badge-warning'}`}>
      {configured ? 'Configured' : 'Not set'}
    </span>
  );
}

export function AlertBanner({ tone = 'error', children }) {
  if (!children) return null;
  const ok = tone === 'success';
  return (
    <div className={`mb-6 p-4 rounded-lg flex items-center gap-3 ${
      ok ? 'bg-green-500/10 border border-green-500/30' : 'bg-red-500/10 border border-red-500/30'
    }`}>
      {ok
        ? <Check className="w-5 h-5 text-green-400 flex-shrink-0" />
        : <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />}
      <p className={`text-sm ${ok ? 'text-green-400' : 'text-red-400'}`}>{children}</p>
    </div>
  );
}

export function StatusNotice({ ok, message, className = '' }) {
  if (!message) return null;
  return (
    <div className={`${className} p-3 rounded-lg flex items-start gap-3 ${
      ok ? 'bg-green-500/10 border border-green-500/30' : 'bg-red-500/10 border border-red-500/30'
    }`.trim()}>
      {ok
        ? <Check className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
        : <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />}
      <p className={`text-sm ${ok ? 'text-green-400' : 'text-red-400'}`}>{message}</p>
    </div>
  );
}

export function ToggleRow({ label, help, value, onChange, disabled }) {
  return (
    <div className="flex items-center justify-between gap-3 p-3 bg-mc-darker rounded-lg mb-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white">{label}</p>
        {help ? <p className="text-xs text-mc-textMuted">{help}</p> : null}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={`toggle flex-shrink-0 ${value ? 'toggle-active' : 'toggle-inactive'}`}
      >
        <span className={`toggle-thumb ${value ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}

export function TextField({ label, value, onChange, placeholder, disabled, type = 'text' }) {
  return (
    <div>
      {label ? <label className="block text-sm font-medium text-mc-text mb-2">{label}</label> : null}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input"
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
      />
    </div>
  );
}

export function SecretField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  configured,
  onClear,
  onReplace,
  reveal,
  onToggleReveal,
  clearLabel = 'Remove stored key',
  replaceLabel = 'Replace key',
}) {
  return (
    <div>
      {label ? <label className="block text-sm font-medium text-mc-text mb-2">{label}</label> : null}
      <div className="relative">
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input pr-12"
          placeholder={placeholder || (configured ? 'Leave blank to keep current key' : 'Unconfigured')}
          disabled={disabled}
          autoComplete="off"
        />
        <button
          type="button"
          onClick={onToggleReveal}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-mc-textMuted hover:text-mc-text disabled:opacity-50"
          title={reveal ? 'Hide secret' : 'Show secret'}
          disabled={disabled}
        >
          {reveal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      {configured ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {onReplace ? (
            <button
              type="button"
              onClick={onReplace}
              className="text-xs text-mc-accent hover:underline"
              disabled={disabled}
            >
              {replaceLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-mc-danger hover:underline"
            disabled={disabled}
          >
            {clearLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ActionButton({ action, busy, disabled, onClick, stretch = false }) {
  const Icon = ICONS[action.icon] || (action.variant === 'primary' ? Save : Check);
  const variantClass = action.variant === 'primary'
    ? `btn-primary${stretch ? ' flex-1' : ''}`
    : action.variant === 'danger' ? 'btn-danger' : 'btn-secondary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`btn ${variantClass} text-sm`}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />}
      {action.label}
    </button>
  );
}

export function SyncStatus({ status, actions }) {
  const sync = status || {};
  return (
    <div className="flex flex-wrap items-center gap-3 mt-4 p-3 bg-mc-darker rounded-lg">
      <GitBranch className="w-4 h-4 text-mc-textMuted" />
      <p className="text-xs text-mc-textMuted flex-1">
        {sync.running
          ? 'Syncing in the background. You can leave this page; the catalog refresh icon will keep spinning until it finishes.'
          : sync.lastSync
            ? `${sync.modCount || 0} mods • last sync ${new Date(sync.lastSync).toLocaleString()}`
            : 'Not synced yet'}
      </p>
      {actions}
    </div>
  );
}

function dependsMet(field, values) {
  if (!field?.dependsOn) return true;
  const expected = field.dependsOn.value;
  const actual = values[field.dependsOn.field];
  return actual === expected;
}

function splitSectionFields(fields) {
  const out = [];
  let i = 0;
  const list = fields || [];
  while (i < list.length) {
    const field = list[i];
    if (field.type === 'sync-status') {
      const buttons = [];
      let j = i + 1;
      while (j < list.length && list[j].type === 'button') {
        buttons.push(list[j]);
        j += 1;
      }
      out.push({ kind: 'sync', field, buttons });
      i = j;
      continue;
    }
    out.push({ kind: 'field', field });
    i += 1;
  }
  return out;
}

function NativePluginSettings({ pluginId }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [schema, setSchema] = useState(null);
  const [values, setValues] = useState({});
  const [secrets, setSecrets] = useState({});
  const [secretDrafts, setSecretDrafts] = useState({});
  const [cleared, setCleared] = useState({});
  const [reveal, setReveal] = useState({});
  const [status, setStatus] = useState({});
  const [notices, setNotices] = useState({});

  const applyPayload = (data) => {
    setSchema(data.schema);
    setValues(data.values || {});
    setSecrets(data.secrets || {});
    setStatus(data.status || {});
    setSecretDrafts({});
    setCleared({});
  };

  const load = async () => {
    setError('');
    try {
      const res = await pluginApi.settings(pluginId);
      applyPayload(res.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load settings');
      setSchema(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    load();
  }, [pluginId]);

  useEffect(() => {
    if (!status.sync?.running) return undefined;
    const timer = setInterval(() => {
      pluginApi.settings(pluginId)
        .then((res) => setStatus(res.data?.status || {}))
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [pluginId, status.sync?.running]);

  const runAction = async (actionId, { download = false } = {}) => {
    if (download) {
      window.location.assign(`/api/plugins/${encodeURIComponent(pluginId)}/settings/download/${encodeURIComponent(actionId)}`);
      return;
    }
    setSaving(actionId);
    setError('');
    setSuccess('');
    try {
      const body = {
        values,
        secrets: {},
      };
      for (const [id, draft] of Object.entries(secretDrafts)) {
        body.secrets[id] = { value: draft };
      }
      for (const [id, wasCleared] of Object.entries(cleared)) {
        if (wasCleared) body.secrets[id] = { ...(body.secrets[id] || {}), clear: true };
      }
      const res = await pluginApi.settingsAction(pluginId, actionId, body);
      if (res.data?.schema) applyPayload(res.data);
      const message = res.data?.message || res.data?.result?.message;
      if (message) {
        setSuccess(message);
        setTimeout(() => setSuccess(''), 4000);
      }
      if (res.data?.result && (res.data.result.ok === true || res.data.result.ok === false)) {
        setNotices((prev) => ({ ...prev, [actionId]: { ok: res.data.result.ok, message: message || (res.data.result.ok ? 'Success' : 'Failed') } }));
      }
    } catch (err) {
      const message = err.response?.data?.error || err.message || 'Action failed';
      setError(message);
      setNotices((prev) => ({ ...prev, [actionId]: { ok: false, message } }));
    } finally {
      setSaving('');
    }
  };

  const setValue = (id, value) => setValues((prev) => ({ ...prev, [id]: value }));

  const renderField = (field, extraDisabled = false) => {
    const enabled = dependsMet(field, values) && !extraDisabled;
    const disabled = !enabled;
    const wrapClass = field.span === 2 ? 'md:col-span-2' : '';
    if (field.type === 'help') {
      return <HelpText key={field.id}>{field.help || field.label}</HelpText>;
    }
    if (field.type === 'link') {
      return (
        <p key={field.id} className={`text-sm text-mc-textMuted mb-4 ${wrapClass}`}>
          <DocLink href={field.href}>{field.label}</DocLink>
        </p>
      );
    }
    if (field.type === 'toggle') {
      return (
        <div key={field.id} className={wrapClass}>
          <ToggleRow
            label={field.label}
            help={field.help}
            value={Boolean(values[field.id])}
            onChange={(next) => setValue(field.id, next)}
            disabled={disabled}
          />
        </div>
      );
    }
    if (field.type === 'text') {
      const placeholder = field.id === 'localPath' && status.defaultLocalPath
        ? status.defaultLocalPath
        : field.placeholder;
      return (
        <div key={field.id} className={`${wrapClass} ${disabled ? 'opacity-50' : ''}`}>
          <TextField
            label={field.label}
            value={values[field.id] || ''}
            onChange={(next) => setValue(field.id, next)}
            placeholder={placeholder}
            disabled={disabled}
          />
          <HelpText>{field.help}</HelpText>
        </div>
      );
    }
    if (field.type === 'secret-status') {
      const configured = Boolean(secrets[field.secretId]?.configured) && !cleared[field.secretId] && !cleared[field.id];
      return (
        <div key={field.id} className={`flex items-center justify-between p-3 bg-mc-darker rounded-lg mb-4 ${wrapClass}`}>
          <div>
            <p className="text-sm font-medium text-white">{field.label}</p>
            <p className="text-xs text-mc-textMuted">
              {configured ? (field.help || 'A key is configured') : (field.placeholder || 'No key configured')}
            </p>
          </div>
          <StatusBadge configured={configured} />
        </div>
      );
    }
    if (field.type === 'secret') {
      const configured = Boolean(secrets[field.secretId]?.configured) && !cleared[field.id];
      return (
        <div key={field.id} className={`${wrapClass} ${disabled ? 'opacity-50' : ''}`}>
          <SecretField
            label={field.label}
            value={secretDrafts[field.id] || ''}
            onChange={(next) => {
              setSecretDrafts((prev) => ({ ...prev, [field.id]: next }));
              setCleared((prev) => ({ ...prev, [field.id]: false }));
            }}
            placeholder={configured ? 'Leave blank to keep current key' : (field.placeholder || 'Unconfigured')}
            disabled={disabled}
            configured={configured}
            reveal={Boolean(reveal[field.id])}
            onToggleReveal={() => setReveal((prev) => ({ ...prev, [field.id]: !prev[field.id] }))}
            clearLabel={field.clearLabel || 'Remove stored key'}
            replaceLabel={field.replaceLabel || 'Replace key'}
            onReplace={() => {
              setCleared((prev) => ({ ...prev, [field.id]: false }));
              setSecretDrafts((prev) => ({ ...prev, [field.id]: '' }));
              setReveal((prev) => ({ ...prev, [field.id]: true }));
            }}
            onClear={() => {
              setCleared((prev) => ({ ...prev, [field.id]: true }));
              setSecretDrafts((prev) => ({ ...prev, [field.id]: '' }));
              setSecrets((prev) => ({
                ...prev,
                [field.secretId]: { configured: false },
              }));
            }}
          />
        </div>
      );
    }
    if (field.type === 'button') {
      const action = {
        id: field.actionId,
        label: field.label,
        variant: field.variant,
        icon: field.icon,
        download: field.actionId === 'download-template',
      };
      return (
        <div key={field.id} className={wrapClass}>
          <ActionButton
            action={action}
            busy={saving === field.actionId}
            disabled={disabled}
            onClick={() => runAction(field.actionId, { download: action.download })}
          />
          <HelpText>{field.help}</HelpText>
          <StatusNotice
            ok={notices[field.actionId]?.ok}
            message={notices[field.actionId]?.message}
            className="mt-3"
          />
        </div>
      );
    }
    if (field.type === 'sync-status') {
      return (
        <div key={field.id} className={wrapClass}>
          <SyncStatus status={status[field.statusKey] || status.sync} />
        </div>
      );
    }
    if (field.type === 'status') {
      const value = status[field.statusKey];
      return (
        <p key={field.id} className={`text-xs text-mc-textMuted mb-4 ${wrapClass}`}>
          {field.label}: {value == null || value === '' ? 'None' : String(value)}
        </p>
      );
    }
    if (field.type === 'group') {
      const headerToggle = (field.fields || []).find((child) => child.type === 'toggle');
      const rest = (field.fields || []).filter((child) => child !== headerToggle);
      const toggleOn = headerToggle ? Boolean(values[headerToggle.id]) : true;
      return (
        <div key={field.id} className={`p-3 bg-mc-darker rounded-lg space-y-3 ${wrapClass} ${disabled ? 'opacity-50' : ''}`}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-white min-w-0 flex-1 truncate">{field.title || field.label}</p>
            {headerToggle ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => setValue(headerToggle.id, !toggleOn)}
                className={`toggle flex-shrink-0 ${toggleOn ? 'toggle-active' : 'toggle-inactive'}`}
                aria-pressed={toggleOn}
                title={headerToggle.label}
              >
                <span className={`toggle-thumb ${toggleOn ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            ) : null}
          </div>
          {field.description ? <p className="text-xs text-mc-textMuted">{field.description}</p> : null}
          {rest.map((child) => renderField(child, disabled))}
        </div>
      );
    }
    return null;
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

  if (!schema) {
    return (
      <div className="p-6 max-w-xl mx-auto">
        <h1 className="text-xl font-bold text-white mb-2">Plugin unavailable</h1>
        <p className="text-mc-textMuted">{error || 'That plugin page does not exist.'}</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <SettingsPageHeader title={schema.title} description={schema.description} />
      <AlertBanner tone="error">{error}</AlertBanner>
      <AlertBanner tone="success">{success}</AlertBanner>
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          runAction('save');
        }}
      >
        {schema.sections.map((section) => (
          <SettingsSection key={section.id} title={section.title} description={section.description}>
            <div className={section.layout === 'grid-2' ? 'grid grid-cols-1 md:grid-cols-2 gap-4' : 'space-y-4'}>
              {splitSectionFields(section.fields).map((item) => {
                if (item.kind !== 'sync') return renderField(item.field);
                const enabled = dependsMet(item.field, values);
                return (
                  <div key={item.field.id} className="md:col-span-2">
                    <SyncStatus
                      status={status[item.field.statusKey] || status.sync}
                      actions={item.buttons.map((button) => (
                        <ActionButton
                          key={button.id}
                          action={{
                            id: button.actionId,
                            label: button.label,
                            variant: button.variant,
                            icon: button.icon,
                          }}
                          busy={saving === button.actionId}
                          disabled={
                            !enabled
                            || !dependsMet(button, values)
                            || (button.actionId === 'sync-now' && (!status.sync?.canSync || status.sync?.running))
                            || (button.actionId === 'test-connection' && !String(values.url || '').trim())
                          }
                          onClick={() => runAction(button.actionId)}
                        />
                      ))}
                    />
                    {item.buttons.map((button) => (
                      <StatusNotice
                        key={`${button.id}-notice`}
                        ok={notices[button.actionId]?.ok}
                        message={notices[button.actionId]?.message}
                        className="mt-3"
                      />
                    ))}
                  </div>
                );
              })}
            </div>
            {section.actions?.length ? (
              <div className="flex flex-wrap items-center gap-3 mt-4">
                {section.actions.map((action) => (
                  <ActionButton
                    key={action.id}
                    action={action}
                    busy={saving === action.id}
                    onClick={() => runAction(action.id, { download: action.download })}
                  />
                ))}
              </div>
            ) : null}
          </SettingsSection>
        ))}
        {schema.footerActions?.length ? (
          <div className="flex items-center gap-3 pt-4 border-t border-mc-surfaceLight">
            {schema.footerActions.map((action) => (
              <ActionButton
                key={action.id}
                action={{ ...action, variant: action.variant || 'primary' }}
                stretch={action.variant === 'primary' || !action.variant}
                busy={saving === action.id}
                onClick={() => runAction(action.id, { download: action.download })}
              />
            ))}
          </div>
        ) : null}
      </form>
    </div>
  );
}

export default NativePluginSettings;
