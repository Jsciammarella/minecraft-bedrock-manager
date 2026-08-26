const express = require('express');
const router = express.Router();
const dnsSettings = require('../services/dnsSettings');
const dnsProxy = require('../services/dnsProxy');
const serverManager = require('../services/serverManager');
const { assertPermission, requirePermission } = require('../middleware/auth');
const bedrockConnectPolicy = require('../services/bedrockConnectPolicy');
const pluginAudit = require('../services/pluginAudit');

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

function sendDisabled(res, err) {
  return res.status(err.status || 409).json({
    error: err.message,
    code: err.code || bedrockConnectPolicy.DISABLED_CODE,
    plugin: err.plugin || bedrockConnectPolicy.PLUGIN_ID,
  });
}

function overridePermissionKeys(current, next) {
  const normalize = (row) => `${String(row?.hostname || '').trim().toLowerCase()}|${String(row?.ipv4 || '').trim()}`;
  const currentByHost = new Map((current || []).map((row) => [String(row?.hostname || '').trim().toLowerCase(), row]));
  const nextByHost = new Map((next || []).map((row) => [String(row?.hostname || '').trim().toLowerCase(), row]));
  const keys = new Set();
  for (const [host, row] of nextByHost) {
    if (!currentByHost.has(host)) keys.add('bedrock_connect.dns.add_override');
    else if (normalize(currentByHost.get(host)) !== normalize(row)) keys.add('bedrock_connect.dns.edit_override');
  }
  for (const host of currentByHost.keys()) {
    if (!nextByHost.has(host)) keys.add('bedrock_connect.dns.remove_override');
  }
  return [...keys];
}

router.use(bedrockConnectPolicy.requirePluginCapability());

router.get('/', requirePermission('bedrock_connect.view'), async (req, res) => {
  try {
    if (req.principal || req.user) {
      try { assertPermission(req, 'bedrock_connect.view_status'); } catch { /* optional extra status */ }
    }
    res.json(payload());
  } catch (err) {
    if (err.code === bedrockConnectPolicy.DISABLED_CODE) return sendDisabled(res, err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/dns', async (req, res) => {
  try {
    bedrockConnectPolicy.assertAvailable('dns');
    if (!serverManager.getBedrockConnectServer()) {
      return res.status(400).json({ error: 'Create a bedrockConnect server to use these features' });
    }
    const body = req.body || {};
    const current = dnsSettings.publicConfig();
    const sameJson = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
    if (Object.prototype.hasOwnProperty.call(body, 'enabled') && Boolean(body.enabled) !== Boolean(current.enabled)) {
      assertPermission(req, 'bedrock_connect.dns.enable_proxy');
    }
    if (body.upstreams != null && !sameJson(body.upstreams, current.upstreams)) {
      assertPermission(req, 'bedrock_connect.dns.set_upstream');
    }
    if (body.overrides != null && !sameJson(body.overrides, current.overrides)) {
      for (const key of overridePermissionKeys(current.overrides, body.overrides)) {
        assertPermission(req, key);
      }
    }
    dnsSettings.saveConfig({
      enabled: Boolean(body.enabled),
      upstreams: body.upstreams,
      overrides: body.overrides,
    });
    bedrockConnectPolicy.clearAutostartSuppression();
    await dnsProxy.sync({ force: true });
    pluginAudit.record('bedrock-connect.dns.save', {
      actor: req.user?.username || 'local',
      targetType: 'bedrock-connect',
      targetId: String(serverManager.getBedrockConnectServer()?.id || ''),
      detail: {
        enabled: Boolean(body.enabled),
        upstreamChanged: body.upstreams != null && !sameJson(body.upstreams, current.upstreams),
        overrideChanged: body.overrides != null && !sameJson(body.overrides, current.overrides),
      },
    });
    res.json(payload());
  } catch (err) {
    if (err.code === bedrockConnectPolicy.DISABLED_CODE) return sendDisabled(res, err);
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

module.exports = router;
