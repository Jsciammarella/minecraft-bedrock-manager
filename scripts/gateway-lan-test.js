'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const lanBroadcast = require('../server/services/lanBroadcast');
const gatewayLan = require('../server/services/gatewayLan');
const geyser = require('../server/bundled-plugins/gateway-geyser/backend');
const gatewayRegistry = require('../server/services/gatewayRegistry');
const pluginContributions = require('../server/services/pluginContributions');

function sampleGateway(extra = {}) {
  return {
    id: extra.id || 4,
    name: extra.name || 'Java — Geyser',
    provider_id: 'geyser',
    bedrock_udp_port: extra.port || 19146,
    bedrock_listen_address: extra.listen || '0.0.0.0',
    viaproxy_bind_port: extra.viaPort || 25566,
    target_type: 'local-server',
    target_server_id: extra.serverId || 12,
    lan_broadcast: extra.lanBroadcast || 0,
    status: extra.status || 'stopped',
    health_status: extra.health || extra.status || 'stopped',
    unresolved_target: extra.unresolved || 0,
  };
}

function sampleJava(extra = {}) {
  return {
    id: extra.id || 12,
    kind: 'java',
    name: 'Java',
    port: extra.port || 25565,
    status: extra.status || 'running',
  };
}

async function runGatewayLanTests() {
  const dash = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/Dashboard.jsx'), 'utf8');
  assert.match(dash, /Stop Java/);
  assert.doesNotMatch(dash, /Stop Java Server/);
  assert.match(fs.readFileSync(path.join(__dirname, '../server/bundled-plugins/gateway-geyser/backend.js'), 'utf8'), /Stop Geyser/);
  assert.match(dash, /aria-label="LAN"/);
  assert.match(dash, /'LAN'/);
  assert.doesNotMatch(dash, /<Radio/);
  assert.match(dash, /PluginLanActions/);
  assert.doesNotMatch(dash, /providerId === 'geyser'|provider_id === 'geyser'/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../server/services/gatewayLan.js'), 'utf8'), /providerId === 'geyser'/);
  assert.match(fs.readFileSync(path.join(__dirname, '../server/security/actionMatrix.js'), 'utf8'), /\/api\/gateways\/:id\/lan-broadcast/);

  if (!gatewayRegistry.get('geyser')) {
    gatewayRegistry.register({
      id: 'gateway-geyser',
      source: 'bundled',
      capabilities: ['provider:gateway'],
    }, geyser.createProvider());
  }

  assert.equal(lanBroadcast.ownerKey('server', 12), 'server:12');
  assert.equal(lanBroadcast.ownerKey('gateway', 4), 'gateway:4');
  assert.notEqual(lanBroadcast.ownerKey('server', 4), lanBroadcast.ownerKey('gateway', 4));
  assert.throws(() => lanBroadcast.ownerKey('gateway', 'abc'), /Invalid LAN broadcast owner key/);
  assert.equal(lanBroadcast.isActive(4), false);
  assert.equal(lanBroadcast.isActiveForOwner('gateway:4'), false);

  const provider = geyser.createProvider();
  const meta = provider.getMetadata();
  assert.equal(meta.supportsLanBroadcast, true);
  const target = provider.getLanBroadcastTarget(sampleGateway(), sampleJava());
  assert.equal(target.protocol, 'udp');
  assert.equal(target.port, 19146);
  assert.equal(target.port, sampleGateway().bedrock_udp_port);
  assert.notEqual(target.port, sampleJava().port);
  assert.notEqual(target.port, sampleGateway({ viaPort: 25566 }).viaproxy_bind_port);
  assert.equal(target.localOnly, true);

  const ok = gatewayLan.validateProviderTarget(target, sampleGateway(), sampleJava());
  assert.equal(ok.port, 19146);
  assert.equal(ok.ownerKey, 'gateway:4');

  assert.throws(
    () => gatewayLan.validateProviderTarget({ ...target, protocol: 'tcp' }, sampleGateway(), sampleJava()),
    (err) => err.code === 'GATEWAY_LAN_UNSUPPORTED'
  );
  assert.throws(
    () => gatewayLan.validateProviderTarget({ ...target, port: 0 }, sampleGateway(), sampleJava()),
    (err) => err.code === 'GATEWAY_TARGET_UNAVAILABLE'
  );
  assert.throws(
    () => gatewayLan.validateProviderTarget({ ...target, port: 25565 }, sampleGateway(), sampleJava()),
    (err) => err.code === 'GATEWAY_TARGET_UNAVAILABLE' && /Java server TCP/.test(err.message)
  );
  assert.throws(
    () => gatewayLan.validateProviderTarget({ ...target, port: 25566 }, sampleGateway({ viaPort: 25566 }), sampleJava()),
    (err) => /ViaProxy/.test(err.message)
  );
  assert.throws(
    () => gatewayLan.validateProviderTarget({ ...target, localOnly: false }, sampleGateway(), sampleJava()),
    (err) => err.code === 'GATEWAY_TARGET_UNAVAILABLE'
  );
  assert.throws(
    () => gatewayLan.validateProviderTarget({ ...target, ownerKey: 'server:4' }, sampleGateway(), sampleJava()),
    (err) => err.code === 'GATEWAY_TARGET_UNAVAILABLE'
  );
  assert.throws(
    () => gatewayLan.validateProviderTarget(target, sampleGateway({ listen: '127.0.0.1' }), sampleJava()),
    (err) => /loopback/.test(err.message)
  );

  const stopped = gatewayLan.buttonState(sampleGateway({ status: 'stopped', health: 'stopped' }), sampleJava());
  assert.equal(stopped.show, true);
  assert.equal(stopped.disabled, true);
  assert.match(stopped.disabledReason, /Start Geyser before enabling LAN advertising/);

  const waiting = gatewayLan.buttonState(sampleGateway({
    status: 'stopped',
    health: 'stopped',
    lanBroadcast: 1,
  }), sampleJava());
  assert.equal(waiting.disabled, false);
  assert.equal(waiting.waiting, true);
  assert.match(waiting.disabledReason, /resume when Geyser starts/);

  const failed = gatewayLan.buttonState(sampleGateway({
    status: 'stopped',
    health: 'failed',
    lanBroadcast: 1,
  }), sampleJava());
  assert.equal(failed.waiting, true);

  const contrib = pluginContributions.sanitizeContribution({
    pluginId: 'gateway-geyser',
    attachmentId: 'gateway:4',
    tags: [{ id: 'geyser-mode', label: 'Geyser', style: 'info' }],
    indicators: [{ id: 'geyser-status', label: 'Geyser Online', state: 'online' }],
    actions: [{
      id: 'geyser-lan',
      label: 'LAN',
      placement: 'lan-toggle',
      kind: 'toggle',
      state: 'enabled',
      active: true,
      waiting: false,
      icon: 'none',
      permission: 'servers.manage_lan_broadcast',
    }],
  }, { pluginId: 'gateway-geyser', serverId: 12, resourceId: '4' });
  assert.ok(contrib.actions.some((item) => (
    item.id === 'geyser-lan'
    && item.placement === 'lan-toggle'
    && item.active
    && item.permission === 'servers.manage_lan_broadcast'
  )));

  const ambiguous = gatewayLan.attachmentLanRole(
    { id: 1, resource_type: 'gateway', primary_attachment: 0 },
    sampleJava()
  );
  // Without sqlite attachments this returns include:true for a single missing list; skip if db unavailable.
  let sqliteOk = true;
  try {
    require('../server/db/connection');
  } catch {
    sqliteOk = false;
  }
  if (sqliteOk) {
    assert.equal(typeof ambiguous.include, 'boolean');
    await assert.rejects(
      () => gatewayLan.setEnabled(999999, true),
      (err) => err.status === 404 || err.code === 'GATEWAY_TARGET_UNAVAILABLE'
    );
  }

  const nativeTarget = gatewayLan.validateProviderTarget({
    ...target,
    port: 19132,
  }, sampleGateway({ port: 19132 }), sampleJava());
  assert.equal(nativeTarget.port, 19132);
  assert.equal(
    gatewayLan.nativeEligible(sampleGateway({ port: 19132 }), nativeTarget),
    true,
    'UDP 19132 is eligible for native discovery instead of a second Phantom process'
  );
  assert.equal(gatewayLan.nativeEligible(sampleGateway({ port: 19146 }), target), false);

  const hidden = gatewayLan.buttonState(sampleGateway({ status: 'running', health: 'running' }), sampleJava());
  // Process is not actually running in this unit test.
  assert.equal(hidden.show, true);
  assert.equal(hidden.disabled, true);

  const missingProvider = gatewayLan.buttonState({
    ...sampleGateway({ status: 'running', health: 'running' }),
    provider_id: 'not-registered',
  }, sampleJava());
  assert.equal(missingProvider.show, false);

  const lanSrc = fs.readFileSync(path.join(__dirname, '../frontend/src/components/PluginAugmentations.jsx'), 'utf8');
  assert.match(lanSrc, /export function PluginLanActions/);
  assert.match(lanSrc, /aria-label="LAN"/);
  assert.doesNotMatch(lanSrc, /from 'lucide-react'[\s\S]*Radio|Radio,/);
  const lanFn = lanSrc.slice(lanSrc.indexOf('export function PluginLanActions'), lanSrc.indexOf('export function PluginDetailSummary'));
  assert.doesNotMatch(lanFn, /Radio/);
  assert.match(lanFn, /\{busy \? '\.\.\.' : action\.label\}/);

  const sm = require('../server/services/serverManager');
  const originalBc = sm.isBedrockConnectActive;
  sm.isBedrockConnectActive = () => true;
  try {
    const blocked = gatewayLan.buttonState(sampleGateway({
      status: 'running',
      health: 'running',
    }), sampleJava());
    assert.equal(blocked.disabled, true);
    assert.equal(blocked.code, 'BEDROCK_CONNECT_LAN_CONFLICT');
    assert.match(blocked.disabledReason, /Bedrock Connect is using UDP 19132/);
  } finally {
    sm.isBedrockConnectActive = originalBc;
  }

  assert.throws(
    () => lanBroadcast.startForTarget({
      ownerKey: 'gateway:4',
      name: 'Java — Geyser',
      targetAddress: '127.0.0.1',
      targetPort: 19146,
      protocol: 'udp',
      allowLoopbackTarget: false,
    }),
    /loopback/i
  );

  if (sqliteOk) {
    const gatewayManager = require('../server/services/gatewayManager');
    await gatewayManager.withLifecycle(424242, async () => {
      await assert.rejects(
        () => gatewayLan.setEnabled(424242, true),
        (err) => err.code === 'GATEWAY_BUSY' || err.status === 409
      );
    });
  }

  const action = gatewayLan.lanActionFor(
    sampleGateway({ id: 888001, status: 'stopped', health: 'stopped', lanBroadcast: 1 }),
    sampleJava({ id: 888002 }),
    { id: 888003, resource_type: 'gateway', primary_attachment: 1 },
    'geyser-lan'
  );
  assert.equal(action.id, 'geyser-lan');
  assert.equal(action.label, 'LAN');
  assert.equal(action.waiting, true);
  assert.equal(action.state, 'enabled');
  assert.equal(action.permission, 'servers.manage_lan_broadcast');
  assert.match(action.disabledReason, /resume when Geyser starts/);
}

module.exports = { runGatewayLanTests };

if (require.main === module) {
  runGatewayLanTests()
    .then(() => {
      console.log('gateway-lan tests passed');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
