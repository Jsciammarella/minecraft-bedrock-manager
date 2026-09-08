'use strict';

const crypto = require('crypto');
const gatewayRegistry = require('./gatewayRegistry');
const pluginAudit = require('./pluginAudit');

const TOKEN_TTL_MS = 10 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 10000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;
const CACHE_TTL_MS = 45 * 1000;
const STATUSES = new Set(['supported', 'supported-with-warnings', 'supported-with-limitations', 'unsupported', 'unavailable']);
const SUCCESS_STATUSES = new Set(['supported', 'supported-with-warnings', 'supported-with-limitations']);
const MODES = new Set(['direct', 'viaproxy']);
const AUTH = new Set(['floodgate', 'online']);

const secret = crypto.randomBytes(32);
const rateBuckets = new Map();
const recommendCache = new Map();

function stripText(value, max = 400) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/https?:\/\//gi, '')
    .trim()
    .slice(0, max);
}

function asStringArray(value, maxItems = 12, maxLen = 400) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stripText(item, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeTarget(raw = {}) {
  const kind = String(raw.kind || 'java').trim().toLowerCase();
  const policy = String(raw.policy || '').trim().toLowerCase() === 'latest-compatible'
    ? 'latest-compatible'
    : '';
  const minecraftVersion = String(raw.minecraftVersion || raw.minecraft_version || '').trim()
    || (policy === 'latest-compatible' ? 'latest' : '');
  const loaderProviderId = String(raw.loaderProviderId || raw.loader_provider_id || raw.loader || '').trim().toLowerCase();
  const loaderVersion = String(raw.loaderVersion || raw.loader_version || '').trim()
    || (policy === 'latest-compatible' && loaderProviderId && loaderProviderId !== 'vanilla' ? 'latest-compatible' : '');
  if (kind !== 'java') {
    throw Object.assign(new Error('Gateway recommendations are only available for Java servers.'), {
      status: 400,
      code: 'GATEWAY_CONFIGURATION_UNSUPPORTED',
    });
  }
  if (!loaderProviderId) {
    throw Object.assign(new Error('A Java loader is required for a gateway recommendation.'), {
      status: 400,
      code: 'GATEWAY_CONFIGURATION_UNSUPPORTED',
    });
  }
  if (!minecraftVersion) {
    throw Object.assign(new Error('Minecraft version and loader are required for a gateway recommendation.'), {
      status: 400,
      code: 'GATEWAY_CONFIGURATION_UNSUPPORTED',
    });
  }
  return { kind, minecraftVersion, loaderProviderId, loaderVersion, policy };
}

function sanitizeArtifacts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).map((item) => ({
    role: stripText(item?.role, 40),
    projectId: stripText(item?.projectId, 64),
    versionId: stripText(item?.versionId, 64),
    versionNumber: stripText(item?.versionNumber, 80),
  })).filter((item) => item.role);
}

function sanitizeRecommendation(raw, providerId) {
  const status = STATUSES.has(raw?.status) ? raw.status : 'unavailable';
  if (String(raw?.authentication || '').toLowerCase() === 'offline') {
    return {
      providerId,
      status: 'unsupported',
      code: 'GATEWAY_CONFIGURATION_UNSUPPORTED',
      message: 'Automatic configuration will not use insecure offline authentication.',
      recommendedMode: null,
      authentication: null,
      target: raw?.target || null,
      requiredArtifacts: [],
      portRequirements: { protocol: 'udp', family: 'ipv4' },
      warnings: [],
      alternatives: ['Create the server without this integration', 'Configure it later from the plugin page'],
      summary: ['No supported automatic configuration', 'Offline authentication is never selected automatically.'],
      viaProxyReason: '',
      suggestedPort: null,
    };
  }
  const recommendedMode = MODES.has(raw?.recommendedMode) ? raw.recommendedMode : null;
  const authentication = AUTH.has(raw?.authentication) ? raw.authentication : null;
  const target = raw?.target && typeof raw.target === 'object' ? {
    kind: stripText(raw.target.kind, 16) || 'java',
    minecraftVersion: stripText(raw.target.minecraftVersion, 40),
    loaderProviderId: stripText(raw.target.loaderProviderId, 40),
    loaderVersion: stripText(raw.target.loaderVersion, 80),
  } : null;
  const recommendedTarget = raw?.recommendedTarget && typeof raw.recommendedTarget === 'object' ? {
    edition: stripText(raw.recommendedTarget.edition || 'java', 16) || 'java',
    minecraftVersion: stripText(raw.recommendedTarget.minecraftVersion, 40),
    loaderProviderId: stripText(raw.recommendedTarget.loaderProviderId, 40),
    loaderVersion: stripText(raw.recommendedTarget.loaderVersion, 80),
  } : (target ? {
    edition: 'java',
    minecraftVersion: target.minecraftVersion,
    loaderProviderId: target.loaderProviderId,
    loaderVersion: target.loaderVersion,
  } : null);
  return {
    providerId: stripText(raw?.providerId || providerId, 64),
    supported: SUCCESS_STATUSES.has(status),
    status,
    code: stripText(raw?.code, 80) || null,
    message: stripText(raw?.message, 500),
    recommendedMode,
    authentication,
    target,
    recommendedTarget,
    selectionAdjusted: Boolean(raw?.selectionAdjusted),
    requiredArtifacts: sanitizeArtifacts(raw?.requiredArtifacts),
    portRequirements: {
      protocol: stripText(raw?.portRequirements?.protocol || 'udp', 8) || 'udp',
      family: stripText(raw?.portRequirements?.family || 'ipv4', 8) || 'ipv4',
    },
    warnings: asStringArray(raw?.warnings, 12, 400),
    limitations: asStringArray(raw?.limitations || raw?.warnings, 12, 400),
    alternatives: asStringArray(raw?.alternatives, 8, 240),
    summary: asStringArray(raw?.summary, 16, 240),
    viaProxyReason: stripText(raw?.viaProxyReason, 300),
    suggestedPort: null,
  };
}

function tokenPayload(providerId, target, recommendation) {
  const signedTarget = recommendation?.target || target;
  return {
    v: 1,
    providerId,
    target: {
      kind: signedTarget.kind || 'java',
      minecraftVersion: signedTarget.minecraftVersion,
      loaderProviderId: signedTarget.loaderProviderId,
      loaderVersion: signedTarget.loaderVersion,
    },
    status: recommendation.status,
    recommendedMode: recommendation.recommendedMode,
    authentication: recommendation.authentication,
    artifacts: (recommendation.requiredArtifacts || []).map((item) => ({
      role: item.role,
      projectId: item.projectId,
      versionId: item.versionId,
      versionNumber: item.versionNumber,
    })),
  };
}

function signToken(payload, ttlMs = TOKEN_TTL_MS) {
  const body = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${mac}`;
}

function readToken(token) {
  const raw = String(token || '');
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const encoded = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function assertToken(token, providerId, target, recommendation) {
  const payload = readToken(token);
  if (!payload || payload.exp < Date.now() || payload.providerId !== providerId) {
    throw Object.assign(new Error('This gateway recommendation expired. Review the Java versions and try again.'), {
      status: 409,
      code: 'GATEWAY_RECOMMENDATION_STALE',
    });
  }
  const expected = tokenPayload(providerId, target, recommendation);
  const sameTarget = payload.target?.minecraftVersion === expected.target.minecraftVersion
    && payload.target?.loaderProviderId === expected.target.loaderProviderId
    && payload.target?.loaderVersion === expected.target.loaderVersion;
  const samePlan = payload.recommendedMode === expected.recommendedMode
    && payload.authentication === expected.authentication
    && JSON.stringify(payload.artifacts) === JSON.stringify(expected.artifacts)
    && payload.status === expected.status;
  if (!sameTarget || !samePlan) {
    throw Object.assign(new Error('This gateway recommendation no longer matches the selected Java versions.'), {
      status: 409,
      code: 'GATEWAY_RECOMMENDATION_STALE',
    });
  }
  return payload;
}

function enforceRateLimit(key) {
  const now = Date.now();
  const bucket = (rateBuckets.get(key) || []).filter((at) => now - at < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX) {
    throw Object.assign(new Error('Too many gateway recommendation requests. Wait a moment and try again.'), {
      status: 429,
      code: 'GATEWAY_RECOMMENDATION_RATE_LIMITED',
    });
  }
  bucket.push(now);
  rateBuckets.set(key, bucket);
}

function cacheKey(providerId, target) {
  return `${providerId}:${target.kind}:${target.policy || 'current'}:${target.minecraftVersion}:${target.loaderProviderId}:${target.loaderVersion}`;
}

function loaderCatalogFor(loaderProviderId) {
  try {
    const javaLoaderRegistry = require('./javaLoaderRegistry');
    const entry = javaLoaderRegistry.get(loaderProviderId);
    if (!entry?.provider) return null;
    return {
      id: entry.id,
      listMinecraftVersions: () => entry.provider.listMinecraftVersions(),
      listLoaderVersions: (minecraftVersion) => entry.provider.listLoaderVersions(minecraftVersion),
    };
  } catch {
    return null;
  }
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error('Timed out while checking gateway compatibility. Try again, or create the Java server without this integration.'), {
            status: 504,
            code: 'GATEWAY_PROVIDER_UNAVAILABLE',
          }));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireEnabledProvider(providerId) {
  const entry = gatewayRegistry.get(providerId);
  if (!entry?.provider) {
    throw Object.assign(new Error('That gateway provider is not installed or is disabled.'), {
      status: 404,
      code: 'GATEWAY_PROVIDER_UNAVAILABLE',
    });
  }
  const meta = entry.provider.getMetadata ? entry.provider.getMetadata() : {};
  if (typeof entry.provider.recommendProspectiveTarget !== 'function'
    || !meta.supportsProspectiveTargetRecommendation) {
    throw Object.assign(new Error('That gateway provider cannot recommend a configuration for a new server.'), {
      status: 404,
      code: 'GATEWAY_PROVIDER_UNAVAILABLE',
    });
  }
  return entry;
}

async function recommend(providerId, rawTarget, { rateKey = 'anon', peekPort = true } = {}) {
  enforceRateLimit(String(rateKey || 'anon'));
  const id = String(providerId || '').trim();
  const target = normalizeTarget(rawTarget);
  const entry = requireEnabledProvider(id);
  const key = cacheKey(id, target);
  const cached = recommendCache.get(key);
  let inner;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    inner = cached.value;
  } else {
    inner = await withTimeout(entry.provider.recommendProspectiveTarget(target, {
      allowHosts: entry.downloadHosts,
      policy: target.policy,
      loaderCatalog: loaderCatalogFor(target.loaderProviderId),
    }), LOOKUP_TIMEOUT_MS);
    recommendCache.set(key, { at: Date.now(), value: inner });
  }
  const sanitized = sanitizeRecommendation(inner, id);
  if (SUCCESS_STATUSES.has(sanitized.status)) {
    if (peekPort) {
      try {
        sanitized.suggestedPort = require('./gatewayManager').suggestUdpPort();
      } catch (err) {
        sanitized.status = 'unsupported';
        sanitized.supported = false;
        sanitized.code = 'GATEWAY_PORT_UNAVAILABLE';
        sanitized.message = stripText(err.message, 400) || 'No free Bedrock UDP port is available.';
        sanitized.recommendedMode = null;
        sanitized.authentication = null;
      }
    }
  }
  if (SUCCESS_STATUSES.has(sanitized.status)) {
    sanitized.recommendationToken = signToken(tokenPayload(id, sanitized.target || target, sanitized));
  }
  pluginAudit.record('gateway.recommend', {
    targetType: 'gateway-provider',
    targetId: id,
    detail: {
      status: sanitized.status,
      code: sanitized.code || null,
      minecraftVersion: target.minecraftVersion,
      loader: target.loaderProviderId,
    },
  });
  return sanitized;
}

function clearCaches() {
  recommendCache.clear();
  rateBuckets.clear();
}

module.exports = {
  TOKEN_TTL_MS,
  SUCCESS_STATUSES,
  assertToken,
  clearCaches,
  normalizeTarget,
  recommend,
  requireEnabledProvider,
  sanitizeRecommendation,
  signToken,
  tokenPayload,
};
