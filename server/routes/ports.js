const express = require('express');
const router = express.Router();
const serverManager = require('../services/serverManager');

// Get all ports (used and available)
router.get('/', async (req, res) => {
  try {
    const ports = await serverManager.getAllPorts();
    res.json(ports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search available ports
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    const ports = await serverManager.getAllPorts();
    
    let filtered = ports.available;
    if (q) {
      const num = parseInt(q);
      if (!isNaN(num)) {
        filtered = ports.available.filter(p => p.port === num || String(p.port).startsWith(q));
      }
    }
    
    res.json({ available: filtered, used: ports.used });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if a specific port is available
router.get('/check/:port', async (req, res) => {
  try {
    const port = parseInt(req.params.port);
    const ports = await serverManager.getAllPorts();
    const inUse = ports.used.some(p => p.port === port);
    res.json({ port, available: !inUse, server: inUse ? ports.used.find(p => p.port === port)?.server_name : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
