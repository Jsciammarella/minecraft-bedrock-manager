const express = require('express');
const router = express.Router();
const dnsSettings = require('../services/dnsSettings');
const dnsProxy = require('../services/dnsProxy');
const serverManager = require('../services/serverManager');
const { assertPermission } = require('../middleware/auth');

function payload() {
  const installed = serverManager.getBedrockConnectServer() || null;
  return {
    installed: Boolean(installed),
    bedrockConnect: installed ? {
      id: installed.id,
      name: installed.name,
      status: installed.status,
      version: installed.version,
    } : null,
    dns: {
      ...dnsSettings.publicConfig(),
      status: dnsProxy.getStatus(),
    },
  };
}

router.get('/', async (req, res) => {
  try {
    res.json(payload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/dns', async (req, res) => {
  try {
    if (!serverManager.getBedrockConnectServer()) {
      return res.status(400).json({ error: 'Create a bedrockConnect server to use these features' });
    }
    const body = req.body || {};
    const current = dnsSettings.publicConfig();
    const sameJson = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
    if (Object.prototype.hasOwnProperty.call(body, 'enabled') && Boolean(body.enabled) !== Boolean(current.enabled)) {
      assertPermission(req, 'bedrock_connect.enable_dns_proxy');
    }
    if (body.upstreams != null && !sameJson(body.upstreams, current.upstreams)) {
      assertPermission(req, 'bedrock_connect.set_upstream_dns');
    }
    if (body.overrides != null && !sameJson(body.overrides, current.overrides)) {
      assertPermission(req, 'bedrock_connect.set_dns_overrides');
    }
    dnsSettings.saveConfig({
      enabled: Boolean(body.enabled),
      upstreams: body.upstreams,
      overrides: body.overrides,
    });
    await dnsProxy.sync();
    res.json(payload());
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
