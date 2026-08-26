const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const serverManager = require('../services/serverManager');
const { requirePermission, assertPermission, securedRoute } = require('../middleware/auth');

// Get all known players
router.get('/', requirePermission('players.view'), async (req, res) => {
  try {
    res.json(serverManager.listPlayerSummaries());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all whitelisted players
router.get('/whitelisted', requirePermission('players.view_server_membership'), async (req, res) => {
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
router.get('/server/:serverId', requirePermission('players.view_server_membership'), async (req, res) => {
  try {
    require('../services/javaHostingPolicy').assertServerVisible(serverManager.getServer(req.params.serverId));
    const principal = req.principal || req.user;
    const auth = require('../services/authService');
    const online = await serverManager.getOnlinePlayers(req.params.serverId, { refresh: false });
    const players = serverManager.getPlayerAccess(req.params.serverId);
    const payload = { online };
    if (auth.hasPermission(principal, 'servers.allowlist.view')
      || auth.hasPermission(principal, 'servers.banlist.view')
      || auth.hasPermission(principal, 'servers.player_permissions.view')) {
      payload.players = players.map((player) => {
        const row = { ...player };
        if (!auth.hasPermission(principal, 'servers.allowlist.view')) delete row.is_whitelisted;
        if (!auth.hasPermission(principal, 'servers.banlist.view')) delete row.is_banned;
        if (!auth.hasPermission(principal, 'servers.player_permissions.view')) delete row.permission;
        return row;
      });
    }
    if (auth.hasPermission(principal, 'servers.allowlist.view')) {
      payload.whitelisted = players.filter((player) => player.is_whitelisted === 1);
    }
    if (auth.hasPermission(principal, 'servers.banlist.view')) {
      payload.banned = players.filter((player) => player.is_banned === 1);
    }
    res.json(payload);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// Update whitelist, permission, or ban state for one player on one server
router.put('/server/:serverId/:playerId', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.is_whitelisted === 1 || body.is_whitelisted === true) {
      assertPermission(req, 'servers.allowlist.add');
    }
    if (body.is_whitelisted === 0 || body.is_whitelisted === false) {
      assertPermission(req, 'servers.allowlist.remove');
    }
    if (body.is_banned === 1 || body.is_banned === true) {
      assertPermission(req, 'servers.banlist.add');
    }
    if (body.is_banned === 0 || body.is_banned === false) {
      assertPermission(req, 'servers.banlist.remove');
    }
    if (body.permission != null || body.has_custom_permission != null) {
      const level = String(body.permission || '').toLowerCase();
      if (body.has_custom_permission === 0 || body.has_custom_permission === false || level === 'default') {
        assertPermission(req, 'servers.player_permissions.reset');
      } else if (level === 'visitor') {
        assertPermission(req, 'servers.player_permissions.set_visitor');
      } else if (level === 'member') {
        assertPermission(req, 'servers.player_permissions.set_member');
      } else {
        assertPermission(req, 'servers.player_permissions.set_operator');
      }
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
securedRoute(router, {
  method: 'post',
  path: '/scan/:serverId',
  permissions: ['players.scan', 'servers.view_details'],
  action: 'scan players',
  risk: 'normal',
}, async (req, res) => {
  try {
    const result = await serverManager.scanPlayers(req.params.serverId);
    const auth = require('../services/authService');
    if (!auth.hasPermission(req.principal || req.user, 'players.view_server_membership')) {
      return res.json({ scanned: result.scanned, added: result.added, message: result.message });
    }
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
router.post('/:id/whitelist', requirePermission('servers.allowlist.add'), async (req, res) => {
  try {
    await serverManager.addToWhitelist(req.body.serverId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove from whitelist
router.post('/:id/unwhitelist', requirePermission('servers.allowlist.remove'), async (req, res) => {
  try {
    if (!req.body.serverId) return res.status(400).json({ error: 'serverId required' });
    await serverManager.removeFromWhitelist(req.body.serverId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/unwhitelist-all', requirePermission('players.remove_allowlist_all'), async (req, res) => {
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

router.post('/:id/unban-all', requirePermission('players.unban_all'), async (req, res) => {
  try {
    const player = serverManager.setPlayerBannedEverywhere(req.params.id, false);
    res.json(player);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Search players
router.get('/search', requirePermission('players.view'), async (req, res) => {
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
