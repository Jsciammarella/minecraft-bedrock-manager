const router = require('express').Router();
const gatewayRegistry = require('../services/gatewayRegistry');
const gatewayManager = require('../services/gatewayManager');

router.get('/providers', (req, res) => {
  res.json({ providers: gatewayRegistry.list() });
});

router.get('/', (req, res) => {
  res.json({ gateways: gatewayManager.list() });
});

router.post('/', async (req, res) => {
  try {
    const gateway = await gatewayManager.create(req.body || {});
    res.status(201).json(gateway);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    res.json(gatewayManager.status(req.params.id));
  } catch (err) {
    res.status(err.status || 404).json({ error: err.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    res.json(gatewayManager.patch(req.params.id, req.body || {}));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    res.json(gatewayManager.remove(req.params.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/:id/start', async (req, res) => {
  try {
    res.json(await gatewayManager.start(req.params.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/:id/stop', (req, res) => {
  try {
    res.json(gatewayManager.stop(req.params.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/:id/restart', async (req, res) => {
  try {
    res.json(await gatewayManager.restart(req.params.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/:id/status', (req, res) => {
  try {
    res.json(gatewayManager.status(req.params.id));
  } catch (err) {
    res.status(err.status || 404).json({ error: err.message });
  }
});

router.get('/:id/logs', (req, res) => {
  try {
    res.json(gatewayManager.logs(req.params.id));
  } catch (err) {
    res.status(err.status || 404).json({ error: err.message });
  }
});

module.exports = router;
