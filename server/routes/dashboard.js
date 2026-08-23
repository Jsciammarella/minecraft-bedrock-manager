const express = require('express');
const router = express.Router();
const pluginDashboard = require('../services/pluginDashboard');

router.get('/', (req, res) => {
  try {
    const gateways = pluginDashboard.list();
    res.json({
      gateways,
      geyserCount: gateways.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/gateways', (req, res) => {
  try {
    res.json({ gateways: pluginDashboard.list() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/gateways/:id', (req, res) => {
  try {
    const entity = pluginDashboard.get(req.params.id);
    if (!entity) return res.status(404).json({ error: 'Geyser server not found' });
    res.json(entity);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
