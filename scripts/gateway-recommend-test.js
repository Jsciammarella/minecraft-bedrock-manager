'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const floodgateCatalog = require('../server/bundled-plugins/gateway-geyser/floodgateCatalog');
const floodgateRecommend = require('../server/bundled-plugins/gateway-geyser/floodgateRecommend');
const geyser = require('../server/bundled-plugins/gateway-geyser/backend');
const gatewayRegistry = require('../server/services/gatewayRegistry');
const gatewayRecommendation = require('../server/services/gatewayRecommendation');
const gatewayIntegration = require('../server/services/gatewayIntegration');

function catalogVersion(opts) {
  return {
    id: opts.id,
    version_number: opts.versionNumber,
    version_type: opts.versionType || 'release',
    date_published: opts.date || '2026-01-01T00:00:00Z',
    game_versions: opts.gameVersions,
    loaders: opts.loaders,
    files: [{
      filename: opts.filename,
      primary: true,
      url: opts.url,
      size: opts.size || 1000,
      hashes: opts.hashes || { sha1: 'a'.repeat(40) },
    }],
    dependencies: opts.dependencies || [],
  };
}

function requestJsonFrom(catalogs) {
  return async (url) => {
    const parsed = new URL(url);
    const key = `${parsed.origin}${parsed.pathname}`;
    const body = catalogs[key];
    if (!body) throw new Error(`unexpected catalog url ${url}`);
    return body;
  };
}

function pluginStub() {
  return {
    id: 'gateway-geyser',
    source: 'bundled',
    capabilities: ['provider:gateway'],
  };
}

function requiredProviderMethods(extra = {}) {
  return {
    getMetadata() {
      return {
        id: extra.id || 'geyser',
        name: extra.name || 'Geyser',
        targetKinds: ['java'],
        supportsCreateForTarget: true,
        supportsProspectiveTargetRecommendation: extra.supportsRecommend !== false,
    createWizard: extra.createWizard === undefined ? {
          label: 'Bedrock access',
          description: 'Allow Bedrock clients to connect to this Java server',
          recommendedOptionLabel: 'Configure automatically',
        } : extra.createWizard,
        downloadHosts: extra.downloadHosts || ['api.modrinth.com', 'cdn.modrinth.com'],
        notices: extra.notices || [],
      };
    },
    planInstallation: async () => ({ downloads: [], result: {} }),
    planUpdate: async () => ({ downloads: [], result: {} }),
    getLaunchSpecification: () => ({ runtime: 'java', jar: 'Geyser.jar' }),
    getDefaultConfig: () => '',
    sanitizePublicRecord: (row) => row,
    ...extra,
  };
}

async function runGatewayRecommendTests() {
  floodgateCatalog.clearCatalogCache();
  gatewayRecommendation.clearCaches();
  const previous = gatewayRegistry.entries().map((entry) => ({
    plugin: { id: entry.pluginId, source: 'bundled', capabilities: ['provider:gateway'] },
    provider: entry.provider,
  }));
  gatewayRegistry.clear();
  try {

  const createSource = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/CreateServer.jsx'), 'utf8');
  assert.match(createSource, /Optional integrations/);
  assert.match(createSource, /Do not configure/);
  assert.match(createSource, /Configure automatically/);
  assert.match(createSource, /javaValidate/);
  assert.match(createSource, /recommendSeq/);
  assert.doesNotMatch(createSource, /gateway-geyser/);
  const softwareIdx = createSource.indexOf('Server software');
  const integrationsIdx = createSource.indexOf('Optional integrations');
  const ipv6Idx = createSource.indexOf('IPv6 Port');
  assert.ok(ipv6Idx > 0 && softwareIdx > ipv6Idx && integrationsIdx > softwareIdx);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../server/services/gatewayRecommendation.js'), 'utf8'), /gateway-geyser/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../server/services/gatewayIntegration.js'), 'utf8'), /gateway-geyser/);
  const dashUi = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/Dashboard.jsx'), 'utf8');
  assert.match(dashUi, /pluginCompatibilityWarnings/);
  const detailUi = fs.readFileSync(path.join(__dirname, '../frontend/src/components/PluginAugmentations.jsx'), 'utf8');
  assert.match(detailUi, /PluginSecondaryActions/);
  const actionMatrix = fs.readFileSync(path.join(__dirname, '../server/security/actionMatrix.js'), 'utf8');
  assert.match(actionMatrix, /gateways\.create/);
  assert.match(actionMatrix, /\/api\/gateways\/providers\/:providerId\/recommend/);

  const fabricCatalogs = {
    'https://api.modrinth.com/v2/project/bWrNNfkb/version': [
      catalogVersion({
        id: 'fg226',
        versionNumber: '2.2.6-b67',
        gameVersions: ['26.2'],
        loaders: ['fabric'],
        filename: 'Floodgate-Fabric-2.2.6-b67.jar',
        url: 'https://cdn.modrinth.com/data/bWrNNfkb/fg226.jar',
        dependencies: [{ project_id: 'P7dR8mSH', dependency_type: 'required' }],
      }),
    ],
    'https://api.modrinth.com/v2/project/P7dR8mSH/version': [
      catalogVersion({
        id: 'api160',
        versionNumber: '0.160.0+26.2',
        gameVersions: ['26.2'],
        loaders: ['fabric'],
        filename: 'fabric-api-0.160.0+26.2.jar',
        url: 'https://cdn.modrinth.com/data/P7dR8mSH/api160.jar',
      }),
    ],
  };
  const fabricTarget = {
    kind: 'java',
    minecraftVersion: '26.2',
    loaderProviderId: 'fabric',
    loaderVersion: '0.19.5',
  };
  const direct = await floodgateRecommend.recommendProspectiveTarget(fabricTarget, {
    requestJson: requestJsonFrom(fabricCatalogs),
    cache: false,
    nativeVersions: ['1.26.2'],
  });
  assert.ok(['supported', 'supported-with-warnings'].includes(direct.status));
  assert.equal(direct.recommendedMode, 'direct');
  assert.equal(direct.authentication, 'floodgate');
  assert.ok(direct.requiredArtifacts.some((item) => item.role === 'floodgate' && item.versionNumber === '2.2.6-b67'));
  assert.ok(direct.requiredArtifacts.some((item) => item.role === 'fabric-api' && item.versionNumber === '0.160.0+26.2'));
  assert.doesNotMatch(JSON.stringify(direct), /https:\/\//);
  assert.ok(direct.warnings.some((line) => /router or firewall/i.test(line)));

  const olderCatalogs = {
    'https://api.modrinth.com/v2/project/bWrNNfkb/version': [
      catalogVersion({
        id: 'fg1202',
        versionNumber: '2.2.0-legacy',
        gameVersions: ['1.20.2'],
        loaders: ['fabric'],
        filename: 'Floodgate-Fabric-1.20.2.jar',
        url: 'https://cdn.modrinth.com/data/bWrNNfkb/fg1202.jar',
        dependencies: [{ project_id: 'P7dR8mSH', dependency_type: 'required' }],
      }),
    ],
    'https://api.modrinth.com/v2/project/P7dR8mSH/version': [
      catalogVersion({
        id: 'api1202',
        versionNumber: '0.91.0+1.20.2',
        gameVersions: ['1.20.2'],
        loaders: ['fabric'],
        filename: 'fabric-api-0.91.0+1.20.2.jar',
        url: 'https://cdn.modrinth.com/data/P7dR8mSH/api1202.jar',
      }),
    ],
  };
  const via = await floodgateRecommend.recommendProspectiveTarget({
    kind: 'java',
    minecraftVersion: '1.20.2',
    loaderProviderId: 'fabric',
    loaderVersion: '0.15.0',
  }, {
    requestJson: requestJsonFrom(olderCatalogs),
    cache: false,
    nativeVersions: ['1.26.2'],
  });
  assert.equal(via.recommendedMode, 'viaproxy');
  assert.equal(via.authentication, 'floodgate');
  assert.match(via.viaProxyReason, /1\.20\.2/);
  assert.ok(via.requiredArtifacts.some((item) => item.role === 'floodgate'));
  assert.ok(via.summary.some((line) => /does not replace backend Floodgate/i.test(line)));

  const neo = await floodgateRecommend.recommendProspectiveTarget({
    kind: 'java',
    minecraftVersion: '1.20.2',
    loaderProviderId: 'neoforge',
    loaderVersion: '20.2.12-beta',
  }, {
    requestJson: async () => ([
      catalogVersion({
        id: 'neo-b38',
        versionNumber: '2.2.4-b38',
        gameVersions: ['1.21', '1.21.1'],
        loaders: ['neoforge'],
        filename: 'Floodgate-Neoforge-2.2.4-b38.jar',
        url: 'https://cdn.modrinth.com/data/bWrNNfkb/neo-b38.jar',
      }),
    ]),
    cache: false,
    nativeVersions: ['1.26.2'],
  });
  assert.equal(neo.status, 'unsupported');
  assert.equal(neo.code, 'FLOODGATE_UNSUPPORTED_TARGET');
  assert.equal(neo.authentication, null);
  assert.equal(neo.requiredArtifacts.length, 0);
  assert.ok(neo.alternatives.length > 0);

  const alias = await floodgateRecommend.recommendProspectiveTarget({
    kind: 'java',
    minecraftVersion: 'latest',
    loaderProviderId: 'fabric',
    loaderVersion: 'latest-compatible',
  }, { requestJson: async () => { throw new Error('should not look up catalogs for aliases'); } });
  assert.equal(alias.status, 'unsupported');
  assert.match(alias.message, /concrete Minecraft version/i);

  const invalidLoader = await floodgateRecommend.recommendProspectiveTarget({
    kind: 'java',
    minecraftVersion: '26.2',
    loaderProviderId: '',
    loaderVersion: '0.19.5',
  });
  assert.equal(invalidLoader.status, 'unsupported');
  assert.equal(invalidLoader.code, 'GATEWAY_CONFIGURATION_UNSUPPORTED');

  const quilt = await floodgateRecommend.recommendProspectiveTarget({
    kind: 'java',
    minecraftVersion: '26.2',
    loaderProviderId: 'quilt',
    loaderVersion: '0.1.0',
  });
  assert.equal(quilt.status, 'unsupported');
  assert.equal(quilt.code, 'FLOODGATE_UNSUPPORTED_TARGET');
  assert.match(quilt.message, /will not fall back to insecure offline authentication/i);

  const vanilla = await floodgateRecommend.recommendProspectiveTarget({
    kind: 'java',
    minecraftVersion: '26.2',
    loaderProviderId: 'vanilla',
    loaderVersion: 'vanilla',
  });
  assert.equal(vanilla.status, 'unsupported');
  assert.equal(vanilla.code, 'FLOODGATE_UNSUPPORTED_TARGET');
  assert.equal(vanilla.authentication, null);
  assert.match(vanilla.message, /will not fall back to insecure offline authentication/i);

  floodgateCatalog.clearCatalogCache();
  const timedOut = await floodgateRecommend.recommendProspectiveTarget(fabricTarget, {
    requestJson: () => new Promise(() => {}),
    timeoutMs: 20,
    cache: false,
  });
  assert.equal(timedOut.status, 'unsupported');
  assert.equal(timedOut.code, 'FLOODGATE_CATALOG_TIMEOUT');

  const sanitized = gatewayRecommendation.sanitizeRecommendation({
    providerId: 'geyser',
    status: 'supported',
    authentication: 'offline',
    recommendedMode: 'direct',
    message: '<b>offline</b>',
    summary: ['<script>x</script>ok'],
    requiredArtifacts: [{ role: 'floodgate', url: 'https://evil.example/x.jar', versionNumber: '1' }],
  }, 'geyser');
  assert.equal(sanitized.status, 'unsupported');
  assert.equal(sanitized.authentication, null);
  assert.match(JSON.stringify(sanitized.summary).toLowerCase(), /offline authentication is never selected automatically/);

  const html = gatewayRecommendation.sanitizeRecommendation({
    providerId: 'geyser',
    status: 'supported',
    authentication: 'floodgate',
    recommendedMode: 'direct',
    summary: ['Direct <img src=x>'],
    warnings: ['https://evil.example/leak'],
    requiredArtifacts: [{ role: 'floodgate', projectId: 'bWrNNfkb', versionId: 'fg', versionNumber: '2.2.6-b67' }],
    target: fabricTarget,
  }, 'geyser');
  assert.equal(html.authentication, 'floodgate');
  assert.ok(html.summary.every((line) => !/</.test(line)));
  assert.ok(html.warnings.every((line) => !/https:/.test(line)));
  assert.ok(!html.requiredArtifacts[0].url);

  assert.equal(gatewayIntegration.hasAutomatic([{ providerId: 'geyser', mode: 'automatic' }]), true);
  assert.equal(gatewayIntegration.hasAutomatic([{ providerId: 'geyser', mode: 'later' }]), false);
  assert.equal(gatewayIntegration.hasAutomatic(undefined), false);

  await assert.rejects(
    () => gatewayRecommendation.recommend('geyser', fabricTarget, { peekPort: false }),
    (err) => err.code === 'GATEWAY_PROVIDER_UNAVAILABLE'
  );

  await assert.rejects(
    () => gatewayRecommendation.recommend('geyser', { kind: 'java', minecraftVersion: '26.2' }, { peekPort: false }),
    (err) => err.code === 'GATEWAY_CONFIGURATION_UNSUPPORTED'
  );

  gatewayRegistry.register(pluginStub(), requiredProviderMethods({
    id: 'disabled-like',
    supportsRecommend: false,
    createWizard: {},
  }));
  const disabledListed = gatewayRegistry.list().find((item) => item.id === 'disabled-like');
  assert.equal(disabledListed.supportsProspectiveTargetRecommendation, false);
  assert.equal(disabledListed.createWizard, null);
  await assert.rejects(
    () => gatewayRecommendation.recommend('disabled-like', fabricTarget, { peekPort: false, rateKey: 'disabled' }),
    (err) => err.code === 'GATEWAY_PROVIDER_UNAVAILABLE'
  );
  gatewayRegistry.clear();

  const provider = geyser.createProvider({
    http: { getJson: requestJsonFrom(fabricCatalogs) },
  });
  gatewayRegistry.register(pluginStub(), requiredProviderMethods({
    recommendProspectiveTarget: (target, extra) => provider.recommendProspectiveTarget(target, {
      ...extra,
      requestJson: requestJsonFrom(fabricCatalogs),
      allowHosts: ['api.modrinth.com', 'cdn.modrinth.com'],
      cache: false,
    }),
    applyCreateForTarget: async () => {
      throw Object.assign(new Error('forced failure after java create'), {
        code: 'FLOODGATE_VALIDATION_FAILED',
      });
    },
  }));
  const listed = gatewayRegistry.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].supportsProspectiveTargetRecommendation, true);
  assert.equal(listed[0].createWizard.label, 'Bedrock access');
  assert.doesNotMatch(JSON.stringify(listed[0].createWizard), /<|>/);

  const rec = await gatewayRecommendation.recommend('geyser', fabricTarget, { peekPort: false, rateKey: 'test-rec' });
  assert.ok(['supported', 'supported-with-warnings'].includes(rec.status));
  assert.ok(rec.recommendationToken);
  assert.equal(rec.authentication, 'floodgate');

  const stale = gatewayRecommendation.signToken(gatewayRecommendation.tokenPayload('geyser', fabricTarget, {
    ...rec,
    requiredArtifacts: [{ role: 'floodgate', projectId: 'old', versionId: 'old', versionNumber: '0' }],
  }));
  assert.throws(
    () => gatewayRecommendation.assertToken(stale, 'geyser', fabricTarget, rec),
    (err) => err.code === 'GATEWAY_RECOMMENDATION_STALE'
  );

  const pluginContributions = require('../server/services/pluginContributions');
  const contrib = pluginContributions.sanitizeContribution({
    pluginId: 'gateway-geyser',
    attachmentId: 'gateway:9',
    tags: [{ id: 'geyser-compat', label: 'Compatibility changed', style: 'warning' }],
    indicators: [{ id: 'geyser-status', label: 'Geyser Offline', state: 'offline' }],
    actions: [{
      id: 'repair-gateway',
      label: 'Repair Geyser',
      placement: 'secondary',
      variant: 'warning',
      state: 'enabled',
      icon: 'none',
    }],
    summary: {
      mode: 'Direct',
      lastError: '',
      compatibilityWarning: 'Floodgate is missing for this Java version.',
    },
  }, { pluginId: 'gateway-geyser', serverId: 1, resourceId: '9' });
  assert.ok(contrib.summary.some((field) => field.id === 'compatibilityWarning'));
  assert.ok(!contrib.summary.some((field) => field.id === 'lastError'));
  assert.ok(contrib.actions.some((item) => item.id === 'repair-gateway' && item.placement === 'secondary'));

  let sqliteOk = true;
  try {
    require('../server/db/connection');
  } catch {
    sqliteOk = false;
  }
  if (sqliteOk) {
    const applied = await gatewayIntegration.applyAll({
      server: {
        id: 24,
        name: 'Java',
        minecraft_version: '26.2',
        loader_provider_id: 'fabric',
        loader_version: '0.19.5',
      },
      integrations: [{
        providerId: 'geyser',
        mode: 'automatic',
        authentication: 'floodgate',
        recommendationToken: rec.recommendationToken,
      }],
    });
    assert.equal(applied.gatewayCreated, false);
    assert.equal(applied.integrationError.code, 'GATEWAY_INTEGRATION_ROLLED_BACK');
    assert.match(applied.integrationError.detail || applied.integrationError.message, /forced failure|rolled back/i);
    const gatewayManager = require('../server/services/gatewayManager');
    assert.throws(
      () => gatewayManager.suggestUdpPort(19132),
      (err) => err.code === 'GATEWAY_PORT_UNAVAILABLE' || /reserved/i.test(String(err.message || ''))
    );
    assert.throws(
      () => gatewayManager.suggestUdpPort(19133),
      (err) => err.code === 'GATEWAY_PORT_UNAVAILABLE' || /reserved/i.test(String(err.message || ''))
    );
  }

  gatewayRegistry.clear();
  const meta = geyser.createProvider().getMetadata();
  assert.equal(meta.supportsProspectiveTargetRecommendation, true);
  assert.equal(meta.createWizard.label, 'Bedrock access');
  } finally {
    gatewayRegistry.clear();
    for (const entry of previous) {
      try { gatewayRegistry.register(entry.plugin, entry.provider); } catch { /* ignore */ }
    }
  }
}

module.exports = { runGatewayRecommendTests };

if (require.main === module) {
  runGatewayRecommendTests()
    .then(() => {
      console.log('gateway-recommend tests passed');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
