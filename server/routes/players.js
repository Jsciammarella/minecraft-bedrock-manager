const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const serverManager = require('../services/serverManager');
const { requirePermission, assertPermission } = require('../middleware/auth');

// Get all known players
router.get('/', async (req, res) => {
  try {
    res.json(serverManager.listPlayerSummaries());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all whitelisted players
router.get('/whitelisted', async (req, res) => {
  try {
    const players = db.prepare(`
      SELECT * FROM players WHERE is_whitelisted = 1 ORDER BY username
    `).all();
    res.json(players);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get players for a specific server
router.get('/server/:serverId', async (req, res) => {
  try {
    const online = await serverManager.getOnlinePlayers(req.params.serverId, { refresh: false });
    const players = serverManager.getPlayerAccess(req.params.serverId);
    res.json({
      online,
      players,
      whitelisted: players.filter(player => player.is_whitelisted === 1),
      banned: players.filter(player => player.is_banned === 1),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update whitelist, permission, or ban state for one player on one server
router.put('/server/:serverId/:playerId', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.is_whitelisted === 1 || body.is_whitelisted === true) {
      assertPermission(req, 'servers.add_allowed_players');
    }
    if (body.is_whitelisted === 0 || body.is_whitelisted === false) {
      assertPermission(req, 'servers.remove_allowed_players');
    }
    if (body.is_banned === 1 || body.is_banned === true) {
      assertPermission(req, 'servers.add_banned_players');
    }
    if (body.is_banned === 0 || body.is_banned === false) {
      assertPermission(req, 'servers.remove_banned_players');
    }
    if (body.permission != null || body.has_custom_permission != null) {
      assertPermission(req, 'servers.change_player_permissions');
    }
    const player = serverManager.updatePlayerAccess(
      req.params.serverId,
      req.params.playerId,
      req.body
    );
    res.json(player);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Scan server for players
router.post('/scan/:serverId', async (req, res) => {
  try {
    const result = await serverManager.scanPlayers(req.params.serverId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Add player manually
router.post('/', requirePermission('players.add'), async (req, res) => {
  try {
    const { username, xuid } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    const player = serverManager.ensurePlayer(username, xuid || null);
    res.status(player.created ? 201 : 200).json({ ...player, added: player.created });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Whitelist a player
router.post('/:id/whitelist', requirePermission('servers.add_allowed_players'), async (req, res) => {
  try {
    await serverManager.addToWhitelist(req.body.serverId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove from whitelist
router.post('/:id/unwhitelist', requirePermission('servers.remove_allowed_players'), async (req, res) => {
  try {
    if (!req.body.serverId) return res.status(400).json({ error: 'serverId required' });
    await serverManager.removeFromWhitelist(req.body.serverId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/unwhitelist-all', requirePermission('players.remove_whitelisted'), async (req, res) => {
  try {
    const player = serverManager.removeFromAllWhitelists(req.params.id);
    res.json(player);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/ban-all', requirePermission('players.ban_all'), async (req, res) => {
  try {
    const player = serverManager.setPlayerBannedEverywhere(
      req.params.id,
      true,
      req.body?.reason || 'Banned by administrator'
    );
    res.json(player);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/unban-all', requirePermission('players.ban_all'), async (req, res) => {
  try {
    const player = serverManager.setPlayerBannedEverywhere(req.params.id, false);
    res.json(player);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Search players
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    const players = db.prepare(`
      SELECT * FROM players 
      WHERE username LIKE ? 
      ORDER BY username
      LIMIT 50
    `).all(`%${q}%`);
    res.json(players);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
