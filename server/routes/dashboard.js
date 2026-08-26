const express = require('express');
const router = express.Router();
const pluginDashboard = require('../services/pluginDashboard');
const { requirePermission } = require('../middleware/auth');

router.get('/', requirePermission('dashboard.view'), (req, res) => {
  try {
    const javaHostingPolicy = require('../services/javaHostingPolicy');
    const gateways = pluginDashboard.list();
    res.json({
      gateways,
      geyserCount: gateways.length,
      editions: javaHostingPolicy.listEditions(),
      javaHostingAvailable: javaHostingPolicy.isJavaHostingAvailable(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/gateways', requirePermission('dashboard.view'), (req, res) => {
  try {
    res.json({ gateways: pluginDashboard.list() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/gateways/:id', requirePermission('dashboard.view'), (req, res) => {
  try {
    const entity = pluginDashboard.get(req.params.id);
    if (!entity) return res.status(404).json({ error: 'Geyser server not found' });
    res.json(entity);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
