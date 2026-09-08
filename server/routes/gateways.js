const router = require('express').Router();
const gatewayRegistry = require('../services/gatewayRegistry');
const gatewayManager = require('../services/gatewayManager');
const { requirePermission } = require('../middleware/auth');

router.get('/providers', requirePermission('servers.view_details'), (req, res) => {
  res.json({ providers: gatewayRegistry.list() });
});

router.post('/providers/:providerId/recommend', requirePermission('servers.create_java'), async (req, res) => {
  try {
    const gatewayRecommendation = require('../services/gatewayRecommendation');
    const rateKey = req.ip || req.principal?.id || 'anon';
    const result = await gatewayRecommendation.recommend(req.params.providerId, req.body?.target || {}, { rateKey });
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({
      error: err.message,
      message: err.message,
      code: err.code || 'GATEWAY_PROVIDER_UNAVAILABLE',
    });
  }
});

router.get('/', requirePermission('servers.view_details'), (req, res) => {
  res.json({ gateways: gatewayManager.list() });
});

router.post('/', requirePermission('gateways.create'), async (req, res) => {
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

function authorizeGatewayLan(req, row, permission = 'servers.manage_lan_broadcast') {
  const { assertPermission } = require('../middleware/auth');
  const gatewayLan = require('../services/gatewayLan');
  gatewayLan.requireEnabledProvider(row);
  const java = row.target_type === 'local-server' && row.target_server_id
    ? require('../services/serverManager').getServer(row.target_server_id)
    : null;
  if (!java || java.kind !== 'java') {
    throw Object.assign(new Error('This gateway is not linked to a Java server.'), {
      status: 400,
      code: 'GATEWAY_NOT_LINKED',
    });
  }
  assertPermission(req, permission, java);
  return java;
}

router.get('/:id/lan-broadcast', (req, res) => {
  try {
    const row = gatewayManager.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Gateway not found', code: 'GATEWAY_TARGET_UNAVAILABLE' });
    authorizeGatewayLan(req, row, 'servers.view_details');
    res.json(require('../services/gatewayLan').status(row.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, message: err.message, code: err.code || 'GATEWAY_LAN_UNSUPPORTED' });
  }
});

router.put('/:id/lan-broadcast', async (req, res) => {
  try {
    const row = gatewayManager.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Gateway not found', code: 'GATEWAY_TARGET_UNAVAILABLE' });
    authorizeGatewayLan(req, row);
    const enabled = req.body?.enabled === true || req.body?.enabled === 1 || req.body?.enabled === 'true';
    const result = await require('../services/gatewayLan').setEnabled(row.id, enabled);
    try { require('../services/serverManager').broadcastServerStatus(row.target_server_id); } catch { /* ignore */ }
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, message: err.message, code: err.code || 'GATEWAY_LAN_UNSUPPORTED' });
  }
});

module.exports = router;
