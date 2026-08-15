const express = require('express');
const router = express.Router();
const serverManager = require('../services/serverManager');
const connectHost = require('../services/connectHost');

// Public API endpoints for external applications

// Get overview of all servers
router.get('/overview', async (req, res) => {
  try {
    const servers = serverManager.getAllServers();
    const result = [];
    
    for (const server of servers) {
      const stats = await serverManager.getServerStats(server.id);
      const players = await serverManager.getOnlinePlayers(server.id);
      
      const connect = connectHost.attach(server, req);
      result.push({
        id: server.id,
        name: server.name,
        status: server.status,
        version: server.version,
        port: server.port,
        connectHost: connect.connectHost,
        connectAddress: connect.connectAddress,
        maxPlayers: server.max_players,
        onlinePlayers: players.length,
        players: players.map(p => ({
          id: p.id,
          username: p.username,
          xuid: p.xuid,
          joinedAt: p.joined_at
        })),
        uptime: stats?.uptime || '0m',
        startedAt: server.started_at,
      });
    }
    
    res.json({
      totalServers: result.length,
      activeServers: result.filter(s => s.status === 'running').length,
      servers: result,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single server status
router.get('/server/:id', async (req, res) => {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    
    const stats = await serverManager.getServerStats(req.params.id);
    const players = await serverManager.getOnlinePlayers(req.params.id);
    
    const connect = connectHost.attach(server, req);
    res.json({
      id: server.id,
      name: server.name,
      status: server.status,
      version: server.version,
      port: server.port,
      connectHost: connect.connectHost,
      connectAddress: connect.connectAddress,
      maxPlayers: server.max_players,
      onlinePlayers: players.length,
      players: players.map(p => ({
        id: p.id,
        username: p.username,
        xuid: p.xuid,
      })),
      uptime: stats?.uptime || '0m',
      startedAt: server.started_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

module.exports = router;
