'use strict';

const {
  canonicalMinecraftVersion,
  compareVersions,
  isGeyserNativeJavaVersion,
  isVersionAlias,
  loaderLabel,
  paperLikeLoader,
} = require('./floodgateVersions');
const {
  floodgateRequiresFabricApi,
  resolveFabricApiArtifact,
  resolveFloodgateArtifact,
} = require('./floodgateCatalog');

const DEFAULT_NATIVE = ['1.26.2'];
const LOOKUP_TIMEOUT_MS = 10000;
const LIMITATIONS = [
  'Automatic validation cannot guarantee router or firewall forwarding.',
  'Automatic validation cannot guarantee external Internet reachability.',
  'Console LAN discovery may not work on every network.',
  'Mods installed later can break Bedrock compatibility.',
  'Java mods that require a matching client are not playable from Bedrock.',
  'ViaProxy translates Java protocols. It does not replace backend Floodgate, make client-required mods work, or provide Bedrock equivalents of Java resource packs.',
];

function withTimeout(promise, ms, code, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error(message), { status: 504, code }));
      }, ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function result(fields) {
  return {
    providerId: 'geyser',
    status: fields.status,
    code: fields.code || null,
    message: fields.message || '',
    recommendedMode: fields.recommendedMode || null,
    authentication: fields.authentication || null,
    target: fields.target,
    requiredArtifacts: fields.requiredArtifacts || [],
    portRequirements: fields.portRequirements || { protocol: 'udp', family: 'ipv4' },
    warnings: fields.warnings || [],
    alternatives: fields.alternatives || [],
    summary: fields.summary || [],
    viaProxyReason: fields.viaProxyReason || '',
  };
}

function unsupported(code, message, target, extra = {}) {
  return result({
    status: 'unsupported',
    code,
    message,
    target,
    alternatives: extra.alternatives || [
      'Create the server without Geyser',
      'Select a supported Minecraft version and loader',
      'Use a compatible Fabric server',
      'Configure Geyser later from the server details page',
    ],
    summary: extra.summary || [
      'No supported automatic Geyser configuration',
      message,
      'The Java server can still be created without Geyser.',
    ],
    warnings: extra.warnings || [],
  });
}

function publicArtifact(artifact) {
  if (!artifact) return null;
  return {
    role: String(artifact.role || 'floodgate'),
    projectId: String(artifact.projectId || ''),
    versionId: String(artifact.versionId || artifact.id || ''),
    versionNumber: String(artifact.versionNumber || ''),
  };
}

function chooseMode(minecraftVersion, nativeVersions) {
  if (isGeyserNativeJavaVersion(minecraftVersion, nativeVersions)) {
    return { recommendedMode: 'direct', viaProxyReason: '' };
  }
  const native = canonicalMinecraftVersion(nativeVersions[0] || DEFAULT_NATIVE[0]);
  const target = canonicalMinecraftVersion(minecraftVersion);
  const cmp = compareVersions(target, native);
  if (cmp != null && cmp < 0) {
    return {
      recommendedMode: 'viaproxy',
      viaProxyReason: `The server uses Minecraft ${minecraftVersion} while Geyser currently uses protocol ${nativeVersions[0] || native}.`,
    };
  }
  return {
    recommendedMode: null,
    viaProxyReason: '',
    unsupported: true,
  };
}

function paperArtifact() {
  return {
    role: 'floodgate',
    projectId: 'geysermc-floodgate-spigot',
    versionId: 'latest',
    versionNumber: 'latest',
  };
}

async function recommendProspectiveTarget(target = {}, context = {}) {
  const kind = String(target.kind || '').toLowerCase();
  const minecraftVersion = String(target.minecraftVersion || '').trim();
  const loaderProviderId = String(target.loaderProviderId || target.loader || '').toLowerCase();
  const loaderVersion = String(target.loaderVersion || '').trim();
  const nativeVersions = Array.isArray(context.nativeVersions) && context.nativeVersions.length
    ? context.nativeVersions
    : DEFAULT_NATIVE;
  const normalized = {
    kind: kind || 'java',
    minecraftVersion,
    loaderProviderId,
    loaderVersion,
  };

  if (kind && kind !== 'java') {
    return unsupported(
      'GATEWAY_CONFIGURATION_UNSUPPORTED',
      'Automatic Bedrock access is only available when creating a Java server.',
      normalized
    );
  }
  if (!minecraftVersion || isVersionAlias(minecraftVersion)) {
    return unsupported(
      'GATEWAY_CONFIGURATION_UNSUPPORTED',
      'Geyser recommendations require a concrete Minecraft version. Resolve Latest before continuing.',
      normalized
    );
  }
  if (!loaderProviderId) {
    return unsupported(
      'GATEWAY_CONFIGURATION_UNSUPPORTED',
      'Geyser recommendations require a concrete Java loader.',
      normalized
    );
  }
  if (loaderProviderId !== 'vanilla' && (!loaderVersion || isVersionAlias(loaderVersion))) {
    return unsupported(
      'GATEWAY_CONFIGURATION_UNSUPPORTED',
      'Geyser recommendations require a concrete loader version. Resolve latest-compatible before continuing.',
      normalized
    );
  }

  const mode = chooseMode(minecraftVersion, nativeVersions);
  if (mode.unsupported) {
    return unsupported(
      'VIAPROXY_UNSUPPORTED_TARGET',
      `Minecraft ${minecraftVersion} is newer than Geyser's native Java protocol (${nativeVersions[0]}). Automatic configuration cannot translate forward.`,
      normalized,
      {
        alternatives: [
          'Create the server without Geyser',
          'Select a Minecraft version that Geyser currently supports',
          'Configure Geyser later after a compatible Geyser build is available',
        ],
      }
    );
  }

  const loader = loaderProviderId;
  const catalogTarget = { loader, minecraftVersion, loaderVersion };
  const timeoutMs = Number(context.timeoutMs) > 0 ? Number(context.timeoutMs) : LOOKUP_TIMEOUT_MS;
  const requiredArtifacts = [];
  let floodgate = null;
  let fabricApi = null;

  if (paperLikeLoader(loader)) {
    requiredArtifacts.push(paperArtifact());
  } else if (loader === 'fabric' || loader === 'neoforge') {
    try {
      floodgate = await withTimeout(
        resolveFloodgateArtifact(catalogTarget, context),
        timeoutMs,
        'FLOODGATE_CATALOG_TIMEOUT',
        'Timed out while checking Floodgate compatibility. Try again, or create the Java server without Geyser.'
      );
    } catch (err) {
      if (err.code === 'FLOODGATE_UNSUPPORTED_TARGET' || err.code === 'FLOODGATE_CATALOG_TIMEOUT') {
        return unsupported(
          err.code,
          err.message,
          normalized,
          {
            alternatives: [
              'Create the server without Geyser',
              `Select a supported ${loaderLabel(loader)} and Minecraft version`,
              loader === 'neoforge' ? 'Use a compatible Fabric server' : 'Select another loader that Floodgate supports',
              'Configure another authentication method later from the Geyser plugin page',
            ],
          }
        );
      }
      throw err;
    }
    requiredArtifacts.push(publicArtifact(floodgate));
    const needsApi = loader === 'fabric' && (
      floodgateRequiresFabricApi(floodgate) || !(floodgate.dependencies || []).length
    );
    if (needsApi) {
      try {
        fabricApi = await withTimeout(
          resolveFabricApiArtifact(catalogTarget, context),
          timeoutMs,
          'FABRIC_API_CATALOG_TIMEOUT',
          'Timed out while checking Fabric API compatibility. Try again, or create the Java server without Geyser.'
        );
      } catch (err) {
        if (err.code === 'FABRIC_API_UNSUPPORTED_TARGET' || err.code === 'FABRIC_API_CATALOG_TIMEOUT') {
          return unsupported(err.code, err.message, normalized);
        }
        throw err;
      }
      requiredArtifacts.push(publicArtifact(fabricApi));
    }
  } else {
    return unsupported(
      'FLOODGATE_UNSUPPORTED_TARGET',
      `Floodgate is not available for ${loaderLabel(loader) || 'this loader'}. Automatic configuration will not fall back to insecure offline authentication.`,
      normalized,
      {
        alternatives: [
          'Create the server without Geyser',
          'Select Fabric, NeoForge, or Paper',
          'Configure Geyser later if a supported authentication method becomes available',
        ],
      }
    );
  }

  const warnings = [...LIMITATIONS];
  if (loader === 'fabric' || loader === 'neoforge') {
    warnings.unshift(
      'This new server has no extra mods yet. Server-software compatibility looks good, but installing client-required Java mods later can make the server unsuitable for Bedrock clients.'
    );
  }
  const status = warnings.length ? 'supported-with-warnings' : 'supported';
  const summary = [
    `Minecraft: ${minecraftVersion}`,
    `Server software: ${loaderLabel(loader)}${loaderVersion ? ` ${loaderVersion}` : ''}`,
    `Connection mode: ${mode.recommendedMode === 'viaproxy' ? 'ViaProxy' : 'Direct'}`,
    'Authentication: Floodgate',
  ];
  if (floodgate?.versionNumber) summary.push(`Floodgate: ${floodgate.versionNumber}`);
  if (fabricApi?.versionNumber) summary.push(`Fabric API: ${fabricApi.versionNumber}`);
  if (mode.recommendedMode === 'viaproxy') {
    summary.push(`Reason: ${mode.viaProxyReason}`);
    summary.push('ViaProxy translates protocols. It does not replace backend Floodgate.');
  }
  summary.push(status === 'supported-with-warnings' ? 'Supported configuration with limitations' : 'Supported configuration');

  return result({
    status,
    recommendedMode: mode.recommendedMode,
    authentication: 'floodgate',
    target: normalized,
    requiredArtifacts: requiredArtifacts.filter(Boolean),
    warnings,
    summary,
    viaProxyReason: mode.viaProxyReason,
    message: status === 'supported-with-warnings'
      ? 'Automatic Geyser configuration is available for this Java target.'
      : 'Automatic Geyser configuration is available for this Java target.',
  });
}

module.exports = {
  LIMITATIONS,
  LOOKUP_TIMEOUT_MS,
  recommendProspectiveTarget,
};
