const express = require('express');
const router = express.Router();
const serverManager = require('../services/serverManager');
const modManager = require('../services/modManager');
const autoUpdateScheduler = require('../services/autoUpdateScheduler');
const {
  requirePermission,
  requireAnyPermission,
  requireServerStart,
  requireServerStop,
  requireServerRestart,
  requireServerRestartWithWarning,
  requireServerCancelRestart,
  requireServerUpdate,
  requireServerVisible,
  requireServerPermission,
  resolveServerResource,
  assertPermission,
} = require('../middleware/auth');
const pluginContributions = require('../services/pluginContributions');
const catalog = require('../services/permissionCatalog');
const javaHostingPolicy = require('../services/javaHostingPolicy');
const bedrockConnectPolicy = require('../services/bedrockConnectPolicy');
const serializer = require('../services/serverSerializer');

function sendServiceError(res, err) {
  const status = Number(err.status) || 400;
  return res.status(status).json({
    error: err.message,
    message: err.message,
    code: err.code,
    plugin: err.plugin,
  });
}

router.param('id', (req, res, next, id) => {
  if (String(id).startsWith('gateway:')) {
    return res.status(400).json({
      error: 'Gateway identifiers cannot be used with server endpoints. Manage this Geyser server from the Geyser plugin.',
    });
  }
  next();
});
// ========== SERVER CRUD ==========

// Get all servers with stats
router.get('/', requirePermission('dashboard.view'), async (req, res) => {
  try {
    const principal = req.principal || req.user;
    const servers = javaHostingPolicy.filterVisibleServers(serverManager.getAllServers())
      .filter((server) => serializer.can(principal, 'servers.view', server));
    await serverManager.refreshRunningOnlinePlayers();
    const result = await Promise.all(servers.map(async (s) => {
      const canMods = serializer.can(principal, 'servers.mods.view', s);
      const stats = await serverManager.getServerStats(s.id);
      const attached = pluginContributions.attachToServer({
        ...s,
        ...serverManager.publicAttachFields(stats),
        stats,
        lan: stats.lan,
        remoteReachable: stats.remoteReachable,
        installedModIds: canMods ? (modManager.getInstalledModIdsByServer()[String(s.id)] || []) : undefined,
      });
      return serializer.serializeServerForPrincipal(attached, principal, {
        context: 'list',
        req,
        stats,
        installedModIds: attached.installedModIds,
        pluginContributions: attached.pluginContributions,
      });
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/check-updates', requirePermission('servers.view'), async (req, res) => {
  try {
    const result = await serverManager.checkForUpdates();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/auto-update/all', requirePermission('servers.view'), async (req, res) => {
  try {
    const principal = req.principal || req.user;
    const configs = autoUpdateScheduler.getAllAutoUpdateConfigs().filter((row) => {
      const server = serverManager.getServer(row.server_id);
      return Boolean(server) && serializer.can(principal, 'servers.view', server);
    });
    res.json(configs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/bedrock-connect/preview', bedrockConnectPolicy.requirePluginCapability(), requirePermission('bedrock_connect.create'), async (req, res) => {
  try {
    const preview = await serverManager.previewBedrockConnect();
    res.json(preview);
  } catch (err) {
    sendServiceError(res, err.status ? err : Object.assign(err, { status: 400 }));
  }
});

router.get('/bedrock-connect/versions', bedrockConnectPolicy.requirePluginCapability(), requirePermission('bedrock_connect.view'), async (req, res) => {
  try {
    res.json(serverManager.listBedrockConnectVersions());
  } catch (err) {
    sendServiceError(res, err.status ? err : Object.assign(err, { status: 500 }));
  }
});

router.post('/bedrock-connect/check-updates', bedrockConnectPolicy.requirePluginCapability(), requirePermission('bedrock_connect.change_settings'), async (req, res) => {
  try {
    const result = await serverManager.checkBedrockConnectUpdates();
    res.json(result);
  } catch (err) {
    sendServiceError(res, err.status ? err : Object.assign(err, { status: 400 }));
  }
});

router.post('/bedrock-connect', bedrockConnectPolicy.requirePluginCapability(), requirePermission('bedrock_connect.create'), async (req, res) => {
  try {
    const { acceptConflict, restartMode } = req.body || {};
    const result = await serverManager.createBedrockConnect({
      acceptConflict: Boolean(acceptConflict),
      restartMode: restartMode === 'warned' ? 'warned' : 'immediate',
    });
    res.status(result.pending ? 202 : 201).json(result);
  } catch (err) {
    if (err.code === 'PORT_CONFLICT') {
      return res.status(409).json({ error: err.message, conflict: err.conflict });
    }
    res.status(400).json({ error: err.message });
  }
});

router.get('/java/versions', requireAnyPermission('servers.create_java', 'servers.view_details'), async (req, res) => {
  try {
    const javaEdition = require('../services/javaEdition');
    res.json(await javaEdition.listReleaseVersions());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use('/:id', resolveServerResource(), requireServerVisible);

// Get single server
router.get('/:id', requireServerPermission('servers.view_details'), async (req, res) => {
  try {
    const principal = req.principal || req.user;
    const server = req.server;
    const stats = await serverManager.getServerStats(req.params.id);
    const onlinePlayers = serializer.can(principal, 'players.view_server_membership', server)
      ? await serverManager.getOnlinePlayers(req.params.id)
      : undefined;
    const installedMods = serializer.can(principal, 'servers.mods.view', server)
      ? await modManager.getInstalledMods(req.params.id)
      : undefined;
    const attached = pluginContributions.attachToServer({
      ...server,
      ...serverManager.publicAttachFields(stats),
      stats,
      lan: stats.lan,
      remoteReachable: stats.remoteReachable,
      onlinePlayers,
      installedMods,
    });
    res.json(serializer.serializeServerForPrincipal(attached, principal, {
      context: 'detail',
      req,
      stats,
      onlinePlayers,
      installedMods,
      pluginContributions: attached.pluginContributions,
    }));
  } catch (err) {
    sendServiceError(res, err.status ? err : Object.assign(err, { status: 500 }));
  }
});

// Create new server
router.post('/', async (req, res) => {
  try {
    const kind = req.body?.kind === 'remote'
      ? 'remote'
      : req.body?.kind === 'java'
        ? 'java'
        : req.body?.kind === 'bedrock_connect'
          ? 'bedrock_connect'
          : 'bedrock';
    assertPermission(req, catalog.createPermissionForKind(kind));
    if (kind === 'bedrock_connect') bedrockConnectPolicy.assertAvailable('create');
    if (kind === 'java') javaHostingPolicy.assertServerEditionAvailable('java', 'create');
    const result = await serverManager.createServer(req.body);
    res.status(201).json(result);
  } catch (err) {
    sendServiceError(res, err);
  }
});

// Update server settings
router.put('/:id', requireServerUpdate, async (req, res) => {
  try {
    await serverManager.updateSettings(req.params.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete server
router.delete('/:id', async (req, res) => {
  try {
    const server = req.server;
    if (server.kind === 'bedrock_connect') {
      bedrockConnectPolicy.assertAvailable('delete');
      assertPermission(req, catalog.deletePermissionForKind(server.kind), server);
    } else {
      javaHostingPolicy.assertServerVisible(server);
      assertPermission(req, catalog.deletePermissionForKind(server.kind), server);
    }
    const truthy = (value) => value === true || value === '1' || value === 'true';
    await serverManager.deleteServer(req.params.id, {
      detachAttachedPlugins: truthy(req.query.detachAttachedPlugins) || truthy(req.body?.detachAttachedPlugins),
      deleteAttachedGateways: truthy(req.query.deleteAttachedGateways) || truthy(req.body?.deleteAttachedGateways),
    });
    res.json({ success: true });
  } catch (err) {
    const status = Number(err.status) || 400;
    res.status(status).json({
      error: err.message,
      code: err.code,
      attachments: err.attachments,
    });
  }
});

// ========== SERVER LIFECYCLE ==========

router.post('/:id/plugin-actions', async (req, res) => {
  try {
    const pluginActions = require('../services/pluginActions');
    const result = await pluginActions.invoke({
      pluginId: req.body?.pluginId,
      actionId: req.body?.actionId,
      attachmentId: req.body?.attachmentId,
      serverId: req.server.id,
      resourceId: req.body?.resourceId,
      url: req.body?.url,
      href: req.body?.href,
      command: req.body?.command,
      actor: req.user?.username || 'local',
      user: req.user,
      principal: req.principal || req.user,
      resource: req.server,
    });
    res.json(result);
  } catch (err) {
    res.status(Number(err.status) || 400).json({ error: err.message, code: err.code });
  }
});

// Start server
router.post('/:id/start', requireServerStart, async (req, res) => {
  try {
    const result = await serverManager.startServer(req.params.id);
    res.json(result);
  } catch (err) {
    sendServiceError(res, err);
  }
});

// Stop server
router.post('/:id/stop', requireServerStop, async (req, res) => {
  try {
    const result = await serverManager.stopServer(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Restart server
router.post('/:id/restart', requireServerRestart, async (req, res) => {
  try {
    await serverManager.restartServer(req.params.id);
    res.json({ success: true });
  } catch (err) {
    sendServiceError(res, err);
  }
});

// Schedule a five-minute restart with player warnings at 5, 2, and 1 minutes.
router.post('/:id/restart-with-warning', requireServerRestartWithWarning, async (req, res) => {
  try {
    const result = serverManager.scheduleWarnedRestart(req.params.id);
    res.json(result);
  } catch (err) {
    sendServiceError(res, err);
  }
});

router.delete('/:id/restart-with-warning', requireServerCancelRestart, async (req, res) => {
  try {
    const result = serverManager.cancelWarnedRestart(req.params.id, { clearPendingBedrockConnect: true });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Send command to server
router.post('/:id/command', requirePermission('servers.console.send_commands'), async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'Command required' });
    const result = serverManager.sendCommand(req.params.id, command);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ========== SERVER UPDATES ==========

// Update server version
router.post('/:id/update', requirePermission('servers.update_software'), async (req, res) => {
  try {
    const { version } = req.body;
    const result = await serverManager.updateServer(req.params.id, version);
    res.json(result);
  } catch (err) {
    sendServiceError(res, err);
  }
});

// ========== AUTO-UPDATE MANAGEMENT ==========

// Get auto-update config for a server
router.get('/:id/auto-update', requirePermission('servers.view_details'), async (req, res) => {
  try {
    const config = autoUpdateScheduler.getAutoUpdateConfig(req.params.id);
    res.json(config || { enabled: false, check_interval_hours: 24 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enable auto-update for a server
router.post('/:id/auto-update', requirePermission('servers.configure_auto_update'), async (req, res) => {
  try {
    const { intervalHours } = req.body;
    await autoUpdateScheduler.enableAutoUpdate(req.params.id, intervalHours || 24);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Disable auto-update for a server
router.delete('/:id/auto-update', requirePermission('servers.configure_auto_update'), async (req, res) => {
  try {
    await autoUpdateScheduler.disableAutoUpdate(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/lan-broadcast', requirePermission('servers.view_details'), async (req, res) => {
  try {
    const preview = await serverManager.previewLanBroadcast(req.params.id);
    res.json(preview);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id/lan-broadcast', requirePermission('servers.manage_lan_broadcast'), async (req, res) => {
  try {
    const { enabled, acceptConflict, restartMode } = req.body || {};
    const result = await serverManager.setLanBroadcast(req.params.id, Boolean(enabled), {
      acceptConflict: Boolean(acceptConflict),
      restartMode: restartMode === 'warned' ? 'warned' : 'immediate',
    });
    res.status(result.pending ? 202 : 200).json(result);
  } catch (err) {
    if (err.code === 'PORT_CONFLICT') {
      return res.status(409).json({ error: err.message, conflict: err.conflict, code: err.code });
    }
    if (err.code === 'BC_CONFLICT' || err.code === 'LAN_BLOCKED') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/java/dependencies/resolve', requirePermission('servers.mods.install'), requirePermission('servers.mods.resolve_dependencies'), async (req, res) => {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.kind !== 'java') return res.status(400).json({ error: 'Not a Java server' });
    if (server.status === 'running' || server.status === 'starting') {
      return res.status(400).json({ error: 'Stop the server before resolving dependencies' });
    }
    const javaModDependencies = require('../services/javaModDependencies');
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const overrides = req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : {};
    const result = await javaModDependencies.resolve(server, ids, overrides);
    serverManager.invalidateServerCache(server.id);
    const updated = serverManager.getServer(server.id);
    res.json({
      ...result,
      missingModDependencies: javaModDependencies.publicState(updated),
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.get('/:id/java/mods', requirePermission('servers.mods.view'), (req, res) => {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.kind !== 'java') return res.status(400).json({ error: 'Not a Java server' });
    const javaModInstall = require('../services/javaModInstall');
    res.json({ mods: javaModInstall.list(server.id) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.get('/:id/java/mods/pending', requirePermission('servers.mods.view_restart_status'), (req, res) => {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const javaModInstall = require('../services/javaModInstall');
    res.json({ pending: javaModInstall.pending(server.id) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.post('/:id/java/mods/validate', requirePermission('servers.mods.install'), (req, res) => {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const db = require('../db/connection');
    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(req.body?.modId);
    const javaModInstall = require('../services/javaModInstall');
    res.json(javaModInstall.validate(server, mod));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.post('/:id/java/mods', requirePermission('servers.mods.install'), (req, res) => {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const javaModInstall = require('../services/javaModInstall');
    const result = javaModInstall.install(server, req.body?.modId, {
      fileSha256: req.body?.fileSha256,
      override: false,
    });
    if (result.restartRequired) {
      serverManager.markRestartRequired(server.id, 'Java mods changed');
    }
    res.status(201).json({ ...result, mods: javaModInstall.list(server.id) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.delete('/:id/java/mods/:installationId', requirePermission('servers.mods.remove'), (req, res) => {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const javaModInstall = require('../services/javaModInstall');
    const result = javaModInstall.remove(server, req.params.installationId);
    if (result.restartRequired) {
      serverManager.markRestartRequired(server.id, 'Java mods changed');
    }
    res.json({ ...result, mods: javaModInstall.list(server.id) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.post('/:id/java/dependencies/reevaluate', requirePermission('servers.mods.install'), requirePermission('servers.mods.resolve_dependencies'), async (req, res) => {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.kind !== 'java') return res.status(400).json({ error: 'Not a Java server' });
    const javaModDependencies = require('../services/javaModDependencies');
    javaModDependencies.pruneResolved(server);
    if (server.status === 'running' || server.status === 'starting') {
      await serverManager.restartServer(server.id);
    } else if (server.status !== 'creating') {
      await serverManager.startServer(server.id);
    }
    serverManager.invalidateServerCache(server.id);
    const updated = serverManager.getServer(server.id);
    res.json({
      success: true,
      missingModDependencies: javaModDependencies.publicState(updated),
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

module.exports = router;
