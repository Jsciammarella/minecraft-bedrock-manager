const pluginAudit = require('./pluginAudit');

const registry = new Map();
const inflight = new Map();
const recent = new Map();
const DEDUPE_MS = 1500;
const LOCK_MS = 60 * 1000;

let permissionResolver = defaultPermissionResolver;

function defaultPermissionResolver(_permission, _ctx) {
  return true;
}

function setPermissionResolver(fn) {
  permissionResolver = typeof fn === 'function' ? fn : defaultPermissionResolver;
}

function resetPermissionResolver() {
  permissionResolver = defaultPermissionResolver;
}

function keyOf(pluginId, actionId) {
  return `${pluginId}::${actionId}`;
}

function lockKey(pluginId, actionId, resourceType, resourceId) {
  return `${pluginId}::${actionId}::${resourceType}::${resourceId}`;
}

function register(pluginId, spec = {}) {
  const id = String(pluginId || '').trim();
  const actionId = String(spec.id || '').trim();
  if (!/^[a-z0-9-]+$/i.test(id) || !/^[a-z0-9-]+$/i.test(actionId)) {
    throw Object.assign(new Error('Plugin action ids must be alphanumeric'), { status: 400 });
  }
  const resourceType = String(spec.resourceType || '').trim();
  if (!/^[a-z0-9-]+$/i.test(resourceType)) {
    throw Object.assign(new Error('Plugin action resource type is invalid'), { status: 400 });
  }
  if (typeof spec.handler !== 'function') {
    throw Object.assign(new Error('Plugin actions require a trusted backend handler'), { status: 400 });
  }
  registry.set(keyOf(id, actionId), {
    pluginId: id,
    actionId,
    resourceType,
    permission: String(spec.permission || 'gateway:lifecycle').slice(0, 80),
    confirmation: Boolean(spec.confirmation),
    handler: spec.handler,
  });
}

function unregisterPlugin(pluginId) {
  const prefix = `${pluginId}::`;
  for (const key of [...registry.keys()]) {
    if (key.startsWith(prefix)) registry.delete(key);
  }
}

function clear() {
  registry.clear();
  inflight.clear();
  recent.clear();
}

function get(pluginId, actionId) {
  return registry.get(keyOf(pluginId, actionId)) || null;
}

function fail(status, message, extra = {}) {
  const err = Object.assign(new Error(message), { status, ...extra });
  return err;
}

function reject(action, ctx, status, message) {
  pluginAudit.record('plugin.action.rejected', {
    actor: ctx.actor || 'system',
    targetType: 'plugin-action',
    targetId: `${ctx.pluginId || ''}:${ctx.actionId || ''}`,
    detail: {
      reason: message,
      serverId: ctx.serverId || null,
      attachmentId: ctx.attachmentId || null,
      resourceId: ctx.resourceId || null,
    },
  });
  throw fail(status, message);
}

async function invoke(input = {}) {
  const pluginId = String(input.pluginId || input.pluginId || '').trim();
  const actionId = String(input.actionId || input.actionId || '').trim();
  const actor = String(input.actor || 'local').slice(0, 80);
  if (input.url || input.href || input.command || input.endpoint || input.shell) {
    reject({ actionId }, { pluginId, actionId, actor }, 400, 'Plugin actions cannot supply URLs or commands');
  }
  const pluginHost = require('./pluginHost');
  const plugin = pluginHost.getPlugin(pluginId);
  if (!plugin || !plugin.enabled) {
    reject({ actionId }, { pluginId, actionId, actor }, 403, 'That plugin is not installed or is disabled');
  }
  const spec = get(pluginId, actionId);
  if (!spec) {
    reject({ actionId }, { pluginId, actionId, actor }, 400, 'Unknown plugin action');
  }

  const attachments = require('./serverPluginAttachments');
  const resolved = attachments.resolveActionTarget({
    pluginId,
    resourceType: spec.resourceType,
    serverId: input.serverId,
    attachmentId: input.attachmentId,
    resourceId: input.resourceId,
  });
  if (!resolved.ok) {
    reject(spec, {
      pluginId, actionId, actor,
      serverId: input.serverId,
      attachmentId: input.attachmentId,
      resourceId: input.resourceId,
    }, resolved.status || 403, resolved.error);
  }

  if (!permissionResolver(spec.permission, {
    pluginId,
    actionId,
    actor,
    serverId: resolved.serverId,
    resourceId: resolved.resourceId,
    user: input.user || null,
  })) {
    reject(spec, {
      pluginId, actionId, actor, serverId: resolved.serverId, resourceId: resolved.resourceId,
    }, 403, 'You do not have permission to run this plugin action');
  }

  const lock = lockKey(pluginId, actionId, spec.resourceType, resolved.resourceId);
  if (inflight.has(lock)) {
    reject(spec, {
      pluginId, actionId, actor, serverId: resolved.serverId, resourceId: resolved.resourceId,
    }, 409, 'That plugin action is already in progress');
  }
  const last = recent.get(lock) || 0;
  if (Date.now() - last < DEDUPE_MS) {
    reject(spec, {
      pluginId, actionId, actor, serverId: resolved.serverId, resourceId: resolved.resourceId,
    }, 409, 'Duplicate plugin action ignored');
  }

  const work = (async () => {
    try {
      const result = await spec.handler({
        pluginId,
        actionId,
        actor,
        attachment: resolved.attachment,
        serverId: resolved.serverId,
        resourceType: spec.resourceType,
        resourceId: resolved.resourceId,
        javaServer: resolved.javaServer,
      });
      recent.set(lock, Date.now());
      pluginAudit.record('plugin.action', {
        actor,
        targetType: spec.resourceType,
        targetId: String(resolved.resourceId),
        detail: { pluginId, actionId, serverId: resolved.serverId || null },
      });
      try { require('./pluginEvents').emit('plugin.action', { pluginId, actionId, resourceId: resolved.resourceId }); } catch { /* ignore */ }
      return result || { success: true };
    } catch (err) {
      pluginAudit.record('plugin.action.failed', {
        actor,
        targetType: spec.resourceType,
        targetId: String(resolved.resourceId),
        detail: { pluginId, actionId, error: String(err.message || err).slice(0, 240) },
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

module.exports = {
  clear,
  get,
  invoke,
  register,
  resetPermissionResolver,
  setPermissionResolver,
  unregisterPlugin,
};
