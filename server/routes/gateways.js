const router = require('express').Router();
const gatewayRegistry = require('../services/gatewayRegistry');
const gatewayManager = require('../services/gatewayManager');
const { requirePermission } = require('../middleware/auth');

router.get('/providers', requirePermission('servers.view_details'), (req, res) => {
  res.json({ providers: gatewayRegistry.list() });
});

router.get('/', requirePermission('servers.view_details'), (req, res) => {
  res.json({ gateways: gatewayManager.list() });
});

router.post('/', requirePermission('servers.create_java'), async (req, res) => {
  try {
    const gateway = await gatewayManager.create(req.body || {});
    res.status(201).json(gateway);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/:id', requirePermission('servers.view_details'), (req, res) => {
  try {
    res.json(gatewayManager.status(req.params.id));
  } catch (err) {
    res.status(err.status || 404).json({ error: err.message });
  }
});

router.patch('/:id', requirePermission('plugins.configure'), async (req, res) => {
  try {
    res.json(await gatewayManager.patch(req.params.id, req.body || {}));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code, preview: err.preview });
  }
});

router.post('/:id/apply-settings', requirePermission('plugins.configure'), async (req, res) => {
  try {
    res.json(await gatewayManager.applySettings(req.params.id, req.body || {}));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code, preview: err.preview });
  }
});

router.delete('/:id', requirePermission('servers.delete'), (req, res) => {
  try {
    res.json(gatewayManager.remove(req.params.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/:id/start', requirePermission('servers.start_java'), async (req, res) => {
  try {
    res.json(await gatewayManager.start(req.params.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.post('/:id/stop', requirePermission('servers.stop_java'), (req, res) => {
  try {
    res.json(gatewayManager.stop(req.params.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/:id/restart', requirePermission('servers.restart'), async (req, res) => {
  try {
    res.json(await gatewayManager.restart(req.params.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.get('/:id/status', requirePermission('servers.view_details'), (req, res) => {
  try {
    res.json(gatewayManager.status(req.params.id));
  } catch (err) {
    res.status(err.status || 404).json({ error: err.message });
  }
});

router.get('/:id/logs', requirePermission('servers.console.view'), (req, res) => {
  try {
    res.json(gatewayManager.logs(req.params.id));
  } catch (err) {
    res.status(err.status || 404).json({ error: err.message });
  }
});

module.exports = router;
