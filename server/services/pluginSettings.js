const pluginAudit = require('./pluginAudit');
const pluginSettingsSchema = require('./pluginSettingsSchema');
const pluginSecrets = require('./pluginSecrets');

const pages = new Map();
const recent = new Map();
const inflight = new Map();
const DEDUPE_MS = 1500;
const LOCK_MS = 60 * 1000;
const RATE_LIMITED_ACTIONS = new Set([
  'test-connection',
  'sync-now',
  'test-local-path',
  'test-smb-path',
  'test-nfs-path',
]);

let permissionResolver = () => true;

function setPermissionResolver(fn) {
  permissionResolver = typeof fn === 'function' ? fn : () => true;
}

function resetPermissionResolver() {
  permissionResolver = () => true;
}

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

function register(plugin, spec = {}) {
  if (!plugin || plugin.source !== 'bundled') {
    fail(403, 'Only bundled first-party plugins may register native settings pages', 'NATIVE_SETTINGS_FORBIDDEN');
  }
  const schema = pluginSettingsSchema.validateDescriptor(spec.schema, plugin.id);
  if (typeof spec.getState !== 'function') fail(400, 'Native settings require getState()');
  const actions = spec.actions && typeof spec.actions === 'object' ? spec.actions : {};
  for (const [actionId, handler] of Object.entries(actions)) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(actionId)) fail(400, 'Settings action ids must be lowercase slugs');
    if (typeof handler !== 'function') fail(400, `Settings action "${actionId}" requires a handler`);
  }
  pages.set(plugin.id, {
    pluginId: plugin.id,
    schema,
    getState: spec.getState,
    actions,
    permissions: spec.permissions || {},
  });
}

function unregister(pluginId) {
  pages.delete(pluginId);
}

function clear() {
  pages.clear();
  recent.clear();
  inflight.clear();
}

function get(pluginId) {
  return pages.get(String(pluginId || '')) || null;
}

function publicPage(pluginId, { actor = 'local' } = {}) {
  const page = get(pluginId);
  if (!page) fail(404, 'That plugin does not expose native settings', 'SETTINGS_NOT_FOUND');
  if (!permissionResolver('catalog:settings:view', { pluginId, actor })) {
    fail(403, 'You do not have permission to view catalog settings');
  }
  const state = page.getState() || {};
  const values = state.values && typeof state.values === 'object' ? state.values : {};
  const status = state.status && typeof state.status === 'object' ? state.status : {};
  const secrets = {};
  for (const field of pluginSettingsSchema.collectFields(page.schema)) {
    if (field.type !== 'secret' && field.type !== 'secret-status') continue;
    secrets[field.secretId] = pluginSecrets.status(pluginId, field.storageKey);
  }
  return {
    renderer: 'native-settings',
    pluginId,
    schema: page.schema,
    values,
    secrets,
    status,
  };
}

function permissionFor(actionId, spec) {
  if (spec.permissions && spec.permissions[actionId]) return spec.permissions[actionId];
  if (actionId === 'save') return 'catalog:settings:write';
  if (actionId === 'sync-now') return 'catalog:settings:sync';
  if (actionId.startsWith('test-')) return 'catalog:settings:test';
  if (actionId === 'download-template') return 'catalog:settings:template';
  if (actionId.includes('secret') || actionId === 'clear' || actionId === 'replace') return 'catalog:settings:secrets';
  return 'catalog:settings:write';
}

function sanitizeValues(schema, raw) {
  const allowed = new Set(
    pluginSettingsSchema.collectFields(schema)
      .filter((field) => field.type === 'toggle' || field.type === 'text')
      .map((field) => field.id)
  );
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'boolean' || typeof value === 'number') out[key] = value;
    else if (typeof value === 'string') out[key] = pluginSettingsSchema.plainText(value, 2000, key);
  }
  return out;
}

function postedSecrets(schema, raw) {
  const fields = pluginSettingsSchema.collectFields(schema)
    .filter((field) => field.type === 'secret');
  const byId = new Map(fields.map((field) => [field.id, field]));
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, row] of Object.entries(raw)) {
    const field = byId.get(id);
    if (!field) continue;
    out[id] = {
      storageKey: field.storageKey,
      value: typeof row?.value === 'string' ? row.value : '',
      clear: Boolean(row?.clear),
    };
  }
  return out;
}

async function invokeAction(pluginId, actionId, body = {}, { actor = 'local', persistSecrets } = {}) {
  const page = get(pluginId);
  if (!page) fail(404, 'That plugin does not expose native settings', 'SETTINGS_NOT_FOUND');
  const id = String(actionId || '').trim();
  const handler = page.actions[id];
  if (!handler) fail(400, 'Unknown settings action', 'UNKNOWN_SETTINGS_ACTION');
  if (body.url || body.href || body.command || body.endpoint || body.shell) {
    pluginAudit.record('settings.action.rejected', {
      actor,
      targetType: 'plugin-settings',
      targetId: `${pluginId}:${id}`,
      detail: { reason: 'command-or-url' },
    });
    fail(400, 'Settings actions cannot supply URLs or commands');
  }
  const permission = permissionFor(id, page);
  if (!permissionResolver(permission, { pluginId, actionId: id, actor })) {
    fail(403, 'You do not have permission to change catalog settings');
  }
  const lock = `${pluginId}::${id}`;
  if (inflight.has(lock)) fail(409, 'That settings action is already in progress');
  if (RATE_LIMITED_ACTIONS.has(id)) {
    const last = recent.get(lock) || 0;
    if (Date.now() - last < DEDUPE_MS) fail(409, 'Duplicate settings action ignored');
  }

  const values = sanitizeValues(page.schema, body.values);
  const secrets = postedSecrets(page.schema, body.secrets);
  const persist = persistSecrets != null ? persistSecrets : id === 'save';
  const applied = pluginSecrets.applyPostedSecrets(pluginId, secrets, { persist, actor });
  const work = (async () => {
    try {
      const result = await pluginSecrets.runWithOverlay(applied.overlay, () => handler({
        pluginId,
        actionId: id,
        actor,
        values,
        secretStatus: applied.statuses,
      }));
      recent.set(lock, Date.now());
      pluginAudit.record('settings.action', {
        actor,
        targetType: 'plugin-settings',
        targetId: `${pluginId}:${id}`,
        detail: { pluginId, actionId: id },
      });
      if (result && result.download) return result;
      const next = publicPage(pluginId, { actor });
      return {
        ok: true,
        message: result && result.message ? String(result.message).slice(0, 400) : '',
        result: result && typeof result === 'object' ? redactResult(result) : { success: true },
        ...next,
      };
    } catch (err) {
      pluginAudit.record('settings.action.failed', {
        actor,
        targetType: 'plugin-settings',
        targetId: `${pluginId}:${id}`,
        detail: { error: String(err.message || err).slice(0, 240) },
      });
      throw err;
    } finally {
      inflight.delete(lock);
    }
  })();
  inflight.set(lock, work);
  const timeout = setTimeout(() => inflight.delete(lock), LOCK_MS);
  try {
    return await work;
  } finally {
    clearTimeout(timeout);
  }
}

function assertSameOrigin(req) {
  if (!req || typeof req.get !== 'function') return;
  const origin = req.get('origin');
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    fail(403, 'Invalid request origin');
  }
  const host = String(req.get('host') || '');
  if (!host || parsed.host !== host) {
    fail(403, 'Cross-origin settings requests are not allowed');
  }
}

function redactResult(result) {
  const { download, buffer, stream, ...rest } = result;
  const out = {};
  for (const [key, value] of Object.entries(rest)) {
    if (/token|password|secret|api[_-]?key/i.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 400);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactResult(value);
    }
  }
  return out;
}

module.exports = {
  assertSameOrigin,
  clear,
  get,
  invokeAction,
  publicPage,
  register,
  resetPermissionResolver,
  setPermissionResolver,
  unregister,
};
