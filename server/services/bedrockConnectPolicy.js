const db = require('../db/connection');
const logger = require('./logger');
const pluginAudit = require('./pluginAudit');
const serverEditionRegistry = require('./serverEditionRegistry');

const PLUGIN_ID = 'server-edition-bedrock-connect';
const EDITION_ID = 'bedrock-connect';
const SERVER_KIND = 'bedrock_connect';
const DISABLED_CODE = 'PLUGIN_CAPABILITY_DISABLED';
const CONFIRM_CODE = 'BEDROCK_CONNECT_DISABLE_CONFIRM';
const FAILED_CODE = 'BEDROCK_CONNECT_DISABLE_FAILED';
const DISABLED_MESSAGE = 'BedrockConnect is not enabled.';

let disabling = false;
let disableLock = null;
let autostartSuppressed = false;

function disabledError(action) {
  const err = new Error(DISABLED_MESSAGE);
  err.status = 409;
  err.code = DISABLED_CODE;
  err.plugin = PLUGIN_ID;
  err.action = action || null;
  return err;
}

function notFoundError() {
  const err = new Error('Server not found');
  err.status = 404;
  return err;
}

function isDisabling() {
  return disabling === true;
}

function isAutostartSuppressed() {
  return autostartSuppressed === true;
}

function suppressAutostart() {
  autostartSuppressed = true;
}

function clearAutostartSuppression() {
  autostartSuppressed = false;
}

function isBedrockConnectAvailable() {
  return Boolean(serverEditionRegistry.get(EDITION_ID)) && !disabling;
}

function isAvailable(editionId = EDITION_ID) {
  const id = String(editionId || '').trim().toLowerCase();
  if (id === EDITION_ID || id === SERVER_KIND) return isBedrockConnectAvailable();
  return isBedrockConnectAvailable();
}

function assertAvailable(action) {
  if (isBedrockConnectAvailable()) return true;
  throw disabledError(action);
}

function isHiddenServer(server) {
  if (!server) return false;
  if (String(server.kind || '') === SERVER_KIND) return !isBedrockConnectAvailable();
  return false;
}

function filterVisibleServers(servers) {
  return (servers || []).filter((server) => !isHiddenServer(server));
}

function assertServerVisible(server) {
  if (!server || isHiddenServer(server)) throw notFoundError();
  return server;
}

function assertUserFacing(server, action) {
  if (!server || String(server.kind || '') !== SERVER_KIND) return server;
  assertAvailable(action);
  return server;
}

function countNoun(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function listOwnedServers() {
  return db.prepare(`
    SELECT id, name, status FROM servers WHERE kind = ?
    ORDER BY name COLLATE NOCASE
  `).all(SERVER_KIND);
}

function disableImpact() {
  const servers = listOwnedServers();
  const running = servers.filter((row) => row.status === 'running' || row.status === 'starting' || row.status === 'stopping');
  let dnsRunning = false;
  try {
    dnsRunning = Boolean(require('./dnsProxy').getStatus()?.running);
  } catch {
    dnsRunning = false;
  }
  let message;
  if (running.length === 0 && !dnsRunning) {
    message = 'Disabling BedrockConnect will hide BedrockConnect from the dashboard and menu. No server data, DNS settings, or advertised-server configuration will be deleted.';
  } else {
    const parts = [];
    if (running.length) parts.push(countNoun(running.length, 'BedrockConnect process', 'BedrockConnect processes'));
    if (dnsRunning) parts.push('the DNS proxy');
    message = `Disabling BedrockConnect will stop ${parts.join(' and ')} and hide BedrockConnect from the dashboard. No server data or DNS configuration will be deleted.`;
  }
  return {
    pluginId: PLUGIN_ID,
    editionId: EDITION_ID,
    bedrockConnectServers: servers.length,
    runningBedrockConnectServers: running.length,
    dnsRunning,
    names: running.map((row) => row.name),
    message,
  };
}

function confirmError(impact) {
  const err = new Error(impact.message);
  err.status = 409;
  err.code = CONFIRM_CODE;
  err.impact = impact;
  return err;
}

function failureError(failures) {
  const labels = failures.map((item) => item.name || `${item.type} ${item.id}`);
  const err = new Error(
    `BedrockConnect could not be disabled because these components are still active: ${labels.join(', ')}.`
  );
  err.status = 409;
  err.code = FAILED_CODE;
  err.failures = failures;
  err.plugin = PLUGIN_ID;
  return err;
}

function markDisabling() {
  disabling = true;
}

function clearDisabling() {
  disabling = false;
  disableLock = null;
}

function stillActiveBedrockConnect(serverManager, row) {
  if (!row) return false;
  try {
    const lifecycle = require('./bedrockConnectLifecycle');
    if (lifecycle.currentSession(row.id)) return true;
  } catch {
    /* optional during isolated tests */
  }
  const current = serverManager.getServer(row.id);
  return Boolean(current && (current.status === 'running' || current.status === 'starting' || current.status === 'stopping'));
}

async function performDisable() {
  if (disableLock) return disableLock;
  const work = (async () => {
    markDisabling();
    suppressAutostart();
    pluginAudit.record('plugin.disable.requested', {
      targetType: 'plugin',
      targetId: PLUGIN_ID,
      detail: { impact: disableImpact() },
    });
    const serverManager = require('./serverManager');
    const dnsProxy = require('./dnsProxy');
    const dnsHostRedirect = require('./dnsHostRedirect');
    const pluginEvents = require('./pluginEvents');
    const stopOrder = [];
    try {
      const failures = [];
      const rows = listOwnedServers();
      for (const row of rows) {
        const current = serverManager.getServer(row.id);
        if (!current) continue;
        if (current.status === 'stopped' && current.status !== 'starting') {
          try {
            if (!require('./bedrockConnectLifecycle').currentSession(row.id)) continue;
          } catch {
            if (current.status === 'stopped') continue;
          }
        }
        try {
          stopOrder.push(`bedrock_connect:${row.id}`);
          await serverManager.stopServer(row.id);
        } catch (err) {
          if (!/already stopped/i.test(err.message || '')) {
            failures.push({ type: 'bedrock_connect', id: row.id, name: row.name, error: err.message });
          }
        }
      }

      try {
        stopOrder.push('dns-proxy');
        await dnsProxy.stop();
      } catch (err) {
        failures.push({ type: 'dns-proxy', id: 'dns', name: 'DNS proxy', error: err.message });
      }

      try {
        const reverted = await dnsHostRedirect.revert();
        stopOrder.push('dns-host-redirect');
        if (reverted && reverted.ok === false) {
          failures.push({
            type: 'dns-host-redirect',
            id: 'host-dns',
            name: 'Host-level DNS redirection',
            error: reverted.detail || 'Failed to revert host-level DNS redirection',
          });
        }
      } catch (err) {
        failures.push({ type: 'dns-host-redirect', id: 'host-dns', name: 'Host-level DNS redirection', error: err.message });
      }

      for (const row of listOwnedServers()) {
        if (stillActiveBedrockConnect(serverManager, row)) {
          failures.push({ type: 'bedrock_connect', id: row.id, name: row.name, error: 'BedrockConnect process is still running' });
        }
      }
      try {
        if (dnsProxy.getStatus()?.running) {
          failures.push({ type: 'dns-proxy', id: 'dns', name: 'DNS proxy', error: 'DNS proxy is still running' });
        }
      } catch {
        /* ignore */
      }

      if (failures.length) {
        pluginAudit.record('plugin.disable.failed', {
          targetType: 'plugin',
          targetId: PLUGIN_ID,
          detail: { failures, stopOrder },
        });
        clearDisabling();
        throw failureError(failures);
      }

      pluginEvents.emit('bedrock-connect.disabled', { stopOrder });
      pluginAudit.record('plugin.disable.succeeded', {
        targetType: 'plugin',
        targetId: PLUGIN_ID,
        detail: { stopOrder },
      });
      return { ok: true, stopOrder };
    } catch (err) {
      if (err.code !== FAILED_CODE) {
        pluginAudit.record('plugin.disable.failed', {
          targetType: 'plugin',
          targetId: PLUGIN_ID,
          detail: { error: err.message, code: err.code || null },
        });
        clearDisabling();
      }
      throw err;
    }
  })();
  disableLock = work;
  try {
    return await work;
  } finally {
    if (disableLock === work && !disabling) disableLock = null;
  }
}

function completeDisable() {
  disabling = false;
  disableLock = null;
}

async function onPluginEnabled() {
  pluginAudit.record('plugin.enabled', {
    targetType: 'plugin',
    targetId: PLUGIN_ID,
    detail: { autostart: false },
  });
}

async function onPluginDisabled() {
  return undefined;
}

async function reconcileOnStartup() {
  if (isBedrockConnectAvailable()) return { available: true };
  suppressAutostart();
  const serverManager = require('./serverManager');
  const dnsProxy = require('./dnsProxy');
  const dnsHostRedirect = require('./dnsHostRedirect');
  const rows = listOwnedServers();
  for (const row of rows) {
    if (row.status === 'running' || row.status === 'starting' || row.status === 'stopping') {
      try {
        await serverManager.stopServer(row.id);
      } catch (err) {
        logger.warn(`Could not stop leftover BedrockConnect ${row.id} while the plugin is disabled: ${err.message}`);
      }
    }
  }
  try { await dnsProxy.stop(); } catch (err) {
    logger.warn(`Could not stop leftover DNS proxy while BedrockConnect is disabled: ${err.message}`);
  }
  try { await dnsHostRedirect.revert(); } catch (err) {
    logger.warn(`Could not revert host DNS while BedrockConnect is disabled: ${err.message}`);
  }
  logger.info('BedrockConnect plugin is unavailable; leftover BedrockConnect and DNS processes will not autostart');
  return { available: false };
}

function resetForTests() {
  disabling = false;
  disableLock = null;
  autostartSuppressed = false;
}

function requirePluginCapability(pluginId = PLUGIN_ID) {
  return (req, res, next) => {
    try {
      if (String(pluginId || '') !== PLUGIN_ID) {
        throw disabledError('capability');
      }
      assertAvailable();
      next();
    } catch (err) {
      res.status(err.status || 409).json({
        error: err.message,
        code: err.code || DISABLED_CODE,
        plugin: err.plugin || pluginId,
      });
    }
  };
}

module.exports = {
  CONFIRM_CODE,
  DISABLED_CODE,
  DISABLED_MESSAGE,
  EDITION_ID,
  FAILED_CODE,
  PLUGIN_ID,
  SERVER_KIND,
  assertAvailable,
  assertServerVisible,
  assertUserFacing,
  clearAutostartSuppression,
  clearDisabling,
  completeDisable,
  confirmError,
  disableImpact,
  disabledError,
  filterVisibleServers,
  isAutostartSuppressed,
  isAvailable,
  isBedrockConnectAvailable,
  isDisabling,
  isHiddenServer,
  markDisabling,
  onPluginDisabled,
  onPluginEnabled,
  performDisable,
  reconcileOnStartup,
  requirePluginCapability,
  resetForTests,
  suppressAutostart,
};
