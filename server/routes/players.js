const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const serverManager = require('../services/serverManager');
const { requirePermission, requireAllPermissions, assertPermission, resolveServerResource, requireServerVisible, requireServerPermission } = require('../middleware/auth');

function bindServerIdFromBody(req, _res, next) {
  req.params.serverId = String(req.body?.serverId || '');
  next();
}

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
router.get('/server/:serverId', resolveServerResource('serverId'), requireServerVisible, requireServerPermission('players.view_server_membership'), async (req, res) => {
  try {
    const principal = req.principal || req.user;
    const server = req.server;
    const security = require('../security');
    const online = await serverManager.getOnlinePlayers(req.params.serverId, { refresh: false });
    const players = serverManager.getPlayerAccess(req.params.serverId);
    const payload = { online };
    if (security.authorize(principal, 'servers.allowlist.view', server)
      || security.authorize(principal, 'servers.banlist.view', server)
      || security.authorize(principal, 'servers.player_permissions.view', server)) {
      payload.players = players.map((player) => {
        const row = { ...player };
        if (!security.authorize(principal, 'servers.allowlist.view', server)) delete row.is_whitelisted;
        if (!security.authorize(principal, 'servers.banlist.view', server)) delete row.is_banned;
        if (!security.authorize(principal, 'servers.player_permissions.view', server)) delete row.permission;
        return row;
      });
    }
    if (security.authorize(principal, 'servers.allowlist.view', server)) {
      payload.whitelisted = players.filter((player) => player.is_whitelisted === 1);
    }
    if (security.authorize(principal, 'servers.banlist.view', server)) {
      payload.banned = players.filter((player) => player.is_banned === 1);
    }
    res.json(payload);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// Update whitelist, permission, or ban state for one player on one server
router.put('/server/:serverId/:playerId', resolveServerResource('serverId'), requireServerVisible, async (req, res) => {
  try {
    const body = req.body || {};
    const server = req.server;
    if (body.is_whitelisted === 1 || body.is_whitelisted === true) {
      assertPermission(req, 'servers.allowlist.add', server);
    }
    if (body.is_whitelisted === 0 || body.is_whitelisted === false) {
      assertPermission(req, 'servers.allowlist.remove', server);
    }
    if (body.is_banned === 1 || body.is_banned === true) {
      assertPermission(req, 'servers.banlist.add', server);
    }
    if (body.is_banned === 0 || body.is_banned === false) {
      assertPermission(req, 'servers.banlist.remove', server);
    }
    if (body.permission != null || body.has_custom_permission != null) {
      const level = String(body.permission || '').toLowerCase();
      if (body.has_custom_permission === 0 || body.has_custom_permission === false || level === 'default') {
        assertPermission(req, 'servers.player_permissions.reset', server);
      } else if (level === 'visitor') {
        assertPermission(req, 'servers.player_permissions.set_visitor', server);
      } else if (level === 'member') {
        assertPermission(req, 'servers.player_permissions.set_member', server);
      } else {
        assertPermission(req, 'servers.player_permissions.set_operator', server);
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
router.post('/scan/:serverId', resolveServerResource('serverId'), requireServerVisible, requireAllPermissions('players.scan', 'servers.view_details'), async (req, res) => {
  try {
    const result = await serverManager.scanPlayers(req.params.serverId);
    const security = require('../security');
    if (!security.authorize(req.principal || req.user, 'players.view_server_membership', req.server)) {
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
router.post('/:id/whitelist', bindServerIdFromBody, resolveServerResource('serverId'), requireServerVisible, requireServerPermission('servers.allowlist.add'), async (req, res) => {
  try {
    await serverManager.addToWhitelist(req.body.serverId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove from whitelist
router.post('/:id/unwhitelist', bindServerIdFromBody, resolveServerResource('serverId'), requireServerVisible, requireServerPermission('servers.allowlist.remove'), async (req, res) => {
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
