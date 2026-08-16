const express = require('express');
const router = express.Router();
const dnsSettings = require('../services/dnsSettings');
const dnsProxy = require('../services/dnsProxy');
const serverManager = require('../services/serverManager');

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
    dnsSettings.saveConfig({
      enabled: Boolean(body.enabled),
      upstreams: body.upstreams,
      overrides: body.overrides,
    });
    await dnsProxy.sync();
    res.json(payload());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
