const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const serverManager = require('../services/serverManager');

// Get all known players
router.get('/', async (req, res) => {
  try {
    const players = db.prepare(`
      SELECT * FROM players ORDER BY username
    `).all();
    res.json(players);
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
    const player = serverManager.updatePlayerAccess(
      req.params.serverId,
      req.params.playerId,
      req.body
    );
    res.json(player);
  } catch (err) {
    res.status(400).json({ error: err.message });
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
router.post('/', async (req, res) => {
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
router.post('/:id/whitelist', async (req, res) => {
  try {
    await serverManager.addToWhitelist(req.body.serverId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove from whitelist
router.post('/:id/unwhitelist', async (req, res) => {
  try {
    if (!req.body.serverId) return res.status(400).json({ error: 'serverId required' });
    await serverManager.removeFromWhitelist(req.body.serverId, req.params.id);
    res.json({ success: true });
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
