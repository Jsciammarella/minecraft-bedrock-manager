const express = require('express');
const router = express.Router();
const serverManager = require('../services/serverManager');
const modManager = require('../services/modManager');
const autoUpdateScheduler = require('../services/autoUpdateScheduler');
const connectHost = require('../services/connectHost');

// ========== SERVER CRUD ==========

// Get all servers with stats
router.get('/', async (req, res) => {
  try {
    const servers = serverManager.getAllServers();
    const result = await Promise.all(servers.map(async (s) => {
      const stats = await serverManager.getServerStats(s.id);
      return connectHost.attach({ ...s, stats, lan: stats.lan }, req);
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/check-updates', async (req, res) => {
  try {
    const result = await serverManager.checkForUpdates();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/auto-update/all', async (req, res) => {
  try {
    const configs = autoUpdateScheduler.getAllAutoUpdateConfigs();
    res.json(configs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/bedrock-connect/preview', async (req, res) => {
  try {
    const preview = await serverManager.previewBedrockConnect();
    res.json(preview);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/bedrock-connect/versions', async (req, res) => {
  try {
    res.json(serverManager.listBedrockConnectVersions());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bedrock-connect/check-updates', async (req, res) => {
  try {
    const result = await serverManager.checkBedrockConnectUpdates();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/bedrock-connect', async (req, res) => {
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

// Get single server
router.get('/:id', async (req, res) => {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    
    const stats = await serverManager.getServerStats(req.params.id);
    const onlinePlayers = await serverManager.getOnlinePlayers(req.params.id);
    const installedMods = await modManager.getInstalledMods(req.params.id);
    
    res.json(connectHost.attach({ ...server, stats, lan: stats.lan, onlinePlayers, installedMods }, req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new server
router.post('/', async (req, res) => {
  try {
    const result = await serverManager.createServer(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update server settings
router.put('/:id', async (req, res) => {
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
    await serverManager.deleteServer(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ========== SERVER LIFECYCLE ==========

// Start server
router.post('/:id/start', async (req, res) => {
  try {
    const result = await serverManager.startServer(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Stop server
router.post('/:id/stop', async (req, res) => {
  try {
    const result = await serverManager.stopServer(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Restart server
router.post('/:id/restart', async (req, res) => {
  try {
    await serverManager.restartServer(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Schedule a five-minute restart with player warnings at 5, 2, and 1 minutes.
router.post('/:id/restart-with-warning', async (req, res) => {
  try {
    const result = serverManager.scheduleWarnedRestart(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/restart-with-warning', async (req, res) => {
  try {
    const result = serverManager.cancelWarnedRestart(req.params.id, { clearPendingBedrockConnect: true });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Send command to server
router.post('/:id/command', async (req, res) => {
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
router.post('/:id/update', async (req, res) => {
  try {
    const { version } = req.body;
    const result = await serverManager.updateServer(req.params.id, version);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ========== AUTO-UPDATE MANAGEMENT ==========

// Get auto-update config for a server
router.get('/:id/auto-update', async (req, res) => {
  try {
    const config = autoUpdateScheduler.getAutoUpdateConfig(req.params.id);
    res.json(config || { enabled: false, check_interval_hours: 24 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enable auto-update for a server
router.post('/:id/auto-update', async (req, res) => {
  try {
    const { intervalHours } = req.body;
    await autoUpdateScheduler.enableAutoUpdate(req.params.id, intervalHours || 24);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Disable auto-update for a server
router.delete('/:id/auto-update', async (req, res) => {
  try {
    await autoUpdateScheduler.disableAutoUpdate(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/lan-broadcast', async (req, res) => {
  try {
    const preview = await serverManager.previewLanBroadcast(req.params.id);
    res.json(preview);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id/lan-broadcast', async (req, res) => {
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

module.exports = router;
