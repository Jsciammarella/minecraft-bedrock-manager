'use strict';

const gatewayRegistry = require('./gatewayRegistry');
const gatewayRecommendation = require('./gatewayRecommendation');
const pluginAudit = require('./pluginAudit');

const AUTOMATIC_MODES = new Set(['automatic', 'auto']);

function asIntegrations(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error('Server integrations must be an array.'), {
      status: 400,
      code: 'GATEWAY_CONFIGURATION_UNSUPPORTED',
    });
  }
  return raw.slice(0, 4).map((item) => {
    if (!item || typeof item !== 'object') {
      throw Object.assign(new Error('Each integration must be an object.'), {
        status: 400,
        code: 'GATEWAY_CONFIGURATION_UNSUPPORTED',
      });
    }
    return {
      providerId: String(item.providerId || '').trim(),
      mode: String(item.mode || '').trim().toLowerCase(),
      authentication: String(item.authentication || '').trim().toLowerCase() || undefined,
      recommendationToken: String(item.recommendationToken || '').trim(),
    };
  }).filter((item) => item.providerId && item.mode && item.mode !== 'skip' && item.mode !== 'later');
}

function hasAutomatic(raw) {
  return asIntegrations(raw).some((item) => AUTOMATIC_MODES.has(item.mode));
}

function rollbackProviderGateways(serverId, providerId) {
  let gatewayManager;
  try {
    gatewayManager = require('./gatewayManager');
  } catch {
    return [];
  }
  let rows = [];
  try {
    rows = gatewayManager.forServer(serverId) || [];
  } catch {
    return [];
  }
  const removed = [];
  for (const row of rows) {
    if (String(row.provider_id || row.providerId) !== String(providerId)) continue;
    try {
      gatewayManager.remove(row.id);
      removed.push(row.id);
    } catch { /* ignore */ }
  }
  return removed;
}

async function applyAutomatic({ server, integration }) {
  const providerId = integration.providerId;
  const entry = gatewayRecommendation.requireEnabledProvider(providerId);
  if (typeof entry.provider.applyCreateForTarget !== 'function') {
    throw Object.assign(new Error('That gateway provider cannot configure itself during Java server creation.'), {
      status: 404,
      code: 'GATEWAY_PROVIDER_UNAVAILABLE',
    });
  }
  const target = gatewayRecommendation.normalizeTarget({
    kind: 'java',
    minecraftVersion: server.minecraft_version || server.minecraftVersion || server.version,
    loaderProviderId: server.loader_provider_id || server.loaderProviderId,
    loaderVersion: server.loader_version || server.loaderVersion,
  });
  const recommendation = await gatewayRecommendation.recommend(providerId, target, {
    rateKey: `apply:${providerId}:${server.id}`,
    peekPort: false,
  });
  if (recommendation.status !== 'supported' && recommendation.status !== 'supported-with-warnings'
    && recommendation.status !== 'supported-with-limitations') {
    throw Object.assign(new Error(recommendation.message || 'Automatic gateway configuration is not supported for this Java server.'), {
      status: 400,
      code: recommendation.code || 'GATEWAY_CONFIGURATION_UNSUPPORTED',
    });
  }
  gatewayRecommendation.assertToken(integration.recommendationToken, providerId, target, recommendation);
  if (integration.authentication && integration.authentication !== recommendation.authentication) {
    throw Object.assign(new Error('This gateway recommendation no longer matches the selected authentication.'), {
      status: 409,
      code: 'GATEWAY_RECOMMENDATION_STALE',
    });
  }
  let suggestedPort = null;
  try {
    suggestedPort = require('./gatewayManager').suggestUdpPort();
  } catch (err) {
    if (err.code === 'GATEWAY_PORT_UNAVAILABLE' || /no free UDP port/i.test(String(err.message || ''))) {
      throw Object.assign(new Error(err.message || 'No free Bedrock UDP port is available.'), {
        status: 400,
        code: 'GATEWAY_PORT_UNAVAILABLE',
      });
    }
    suggestedPort = null;
  }
  try {
    const gateway = await entry.provider.applyCreateForTarget({
      server,
      recommendation,
      suggestedPort,
    });
    pluginAudit.record('gateway.integration.apply', {
      targetType: 'server',
      targetId: String(server.id),
      detail: { providerId, gatewayId: gateway?.id || null, mode: recommendation.recommendedMode },
    });
    return { gatewayCreated: true, gateway, providerId };
  } catch (err) {
    rollbackProviderGateways(server.id, providerId);
    try {
      pluginAudit.record('gateway.integration.rollback', {
        targetType: 'server',
        targetId: String(server.id),
        detail: { providerId, code: err.code || 'GATEWAY_INTEGRATION_ROLLED_BACK' },
      });
    } catch { /* ignore */ }
    throw Object.assign(
      new Error(err.message || 'The Java server was created, but gateway configuration was rolled back.'),
      {
        status: 200,
        code: 'GATEWAY_INTEGRATION_ROLLED_BACK',
        providerId,
        causeCode: err.code || err.causeCode || null,
      }
    );
  }
}

async function applyAll({ server, integrations }) {
  const requested = asIntegrations(integrations);
  const results = [];
  for (const integration of requested) {
    if (!AUTOMATIC_MODES.has(integration.mode)) continue;
    try {
      results.push(await applyAutomatic({ server, integration }));
    } catch (err) {
      return {
        gatewayCreated: false,
        integrationError: {
          providerId: integration.providerId,
          code: err.code || 'GATEWAY_INTEGRATION_ROLLED_BACK',
          causeCode: err.causeCode || null,
          message: 'The Java server was created, but gateway configuration was rolled back.',
          detail: String(err.message || '').slice(0, 400),
        },
        results,
      };
    }
  }
  const created = results.some((item) => item.gatewayCreated);
  return {
    gatewayCreated: created,
    gateway: created ? results.find((item) => item.gateway)?.gateway : null,
    results,
  };
}

module.exports = {
  applyAll,
  asIntegrations,
  hasAutomatic,
  rollbackProviderGateways,
};
