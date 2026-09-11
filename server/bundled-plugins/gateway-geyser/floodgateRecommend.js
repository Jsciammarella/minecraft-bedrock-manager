'use strict';

const {
  canonicalMinecraftVersion,
  compareVersions,
  isGeyserNativeJavaVersion,
  isUnstableRelease,
  isVersionAlias,
  loaderLabel,
  paperLikeLoader,
  sortVersionsNewest,
} = require('./floodgateVersions');
const {
  floodgateRequiresFabricApi,
  resolveFabricApiArtifact,
  resolveFloodgateArtifact,
} = require('./floodgateCatalog');

const DEFAULT_NATIVE = ['26.2'];
const LOOKUP_TIMEOUT_MS = 10000;
const MAX_MINECRAFT_CANDIDATES = 20;
const MAX_LOADER_CANDIDATES = 3;
const SUCCESS_STATUSES = new Set(['supported', 'supported-with-warnings', 'supported-with-limitations']);
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
  const status = fields.status;
  return {
    providerId: 'geyser',
    supported: SUCCESS_STATUSES.has(status),
    status,
    code: fields.code || null,
    message: fields.message || '',
    recommendedMode: fields.recommendedMode || null,
    authentication: fields.authentication || null,
    target: fields.target,
    recommendedTarget: fields.recommendedTarget || null,
    selectionAdjusted: Boolean(fields.selectionAdjusted),
    requiredArtifacts: fields.requiredArtifacts || [],
    portRequirements: fields.portRequirements || { protocol: 'udp', family: 'ipv4' },
    warnings: fields.warnings || [],
    limitations: fields.limitations || fields.warnings || [],
    alternatives: fields.alternatives || [],
    summary: fields.summary || [],
    viaProxyReason: fields.viaProxyReason || '',
  };
}

function recommendedTargetOf(target) {
  if (!target) return null;
  return {
    edition: 'java',
    minecraftVersion: String(target.minecraftVersion || ''),
    loaderProviderId: String(target.loaderProviderId || ''),
    loaderVersion: String(target.loaderVersion || ''),
  };
}

function unsupported(code, message, target, extra = {}) {
  return result({
    status: 'unsupported',
    code,
    message,
    target,
    recommendedTarget: null,
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
    limitations: extra.limitations || extra.warnings || [],
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

function wantsLatestCompatible(target = {}, context = {}) {
  const policy = String(context.policy || target.policy || '').trim().toLowerCase();
  if (policy === 'latest-compatible') return true;
  return isVersionAlias(target.minecraftVersion) || (
    String(target.loaderProviderId || '') !== 'vanilla' && isVersionAlias(target.loaderVersion)
  );
}

async function evaluateConcrete(target = {}, context = {}) {
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
      'NO_STABLE_MINECRAFT',
      'No compatible stable Minecraft version was selected. Choose a specific release, or use automatic configuration to pick one.',
      normalized
    );
  }
  if (!loaderProviderId) {
    return unsupported(
      'LOADER_PROVIDER_UNAVAILABLE',
      'Geyser recommendations require a concrete Java loader.',
      normalized
    );
  }
  if (loaderProviderId === 'vanilla') {
    return unsupported(
      'VANILLA_AUTOMATIC_UNSUPPORTED',
      'Automatic Geyser configuration for Vanilla is not currently supported by Minecraft Server Manager.',
      normalized,
      {
        alternatives: [
          'Create the Vanilla Java server without Geyser',
          'Select Fabric or NeoForge to configure Geyser automatically',
          'Add Geyser later from the server details page if you configure it manually',
        ],
      }
    );
  }
  if (!loaderVersion || isVersionAlias(loaderVersion)) {
    return unsupported(
      'NO_COMPATIBLE_LOADER_VERSION',
      `No compatible ${loaderLabel(loaderProviderId) || 'loader'} version was selected. Choose a specific loader version, or use automatic configuration to pick one.`,
      normalized
    );
  }

  const mode = chooseMode(minecraftVersion, nativeVersions);
  if (mode.unsupported) {
    return unsupported(
      'GEYSER_PROTOCOL_UNSUPPORTED',
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
  const limitations = [];
  if (loader === 'fabric' || loader === 'neoforge') {
    warnings.unshift(
      'This new server has no extra mods yet. Server-software compatibility looks good, but installing client-required Java mods later can make the server unsuitable for Bedrock clients.'
    );
  }
  if (mode.recommendedMode === 'viaproxy') {
    limitations.push('This combination requires ViaProxy to translate Geyser to the selected Minecraft version.');
  }
  if (fabricApi) limitations.push('Fabric API will be installed because Floodgate on Fabric requires it.');
  if (floodgate) limitations.push('Floodgate will be installed for Bedrock authentication.');
  const status = mode.recommendedMode === 'viaproxy'
    ? 'supported-with-limitations'
    : 'supported';
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
  summary.push(status === 'supported-with-limitations' ? 'Supported configuration with limitations' : 'Supported configuration');

  return result({
    status,
    recommendedMode: mode.recommendedMode,
    authentication: 'floodgate',
    target: normalized,
    recommendedTarget: recommendedTargetOf(normalized),
    requiredArtifacts: requiredArtifacts.filter(Boolean),
    warnings,
    limitations: [...limitations, ...warnings],
    summary,
    viaProxyReason: mode.viaProxyReason,
    message: status === 'supported-with-limitations'
      ? 'Automatic Geyser configuration is available for this Java target, with the limitations listed below.'
      : 'Automatic Geyser configuration is available for this Java target.',
  });
}

async function findLatestCompatible(target = {}, context = {}) {
  const loaderProviderId = String(target.loaderProviderId || target.loader || '').toLowerCase();
  const requested = {
    kind: 'java',
    minecraftVersion: String(target.minecraftVersion || ''),
    loaderProviderId,
    loaderVersion: String(target.loaderVersion || ''),
  };
  if (!loaderProviderId) {
    return unsupported(
      'LOADER_PROVIDER_UNAVAILABLE',
      'Select a Java loader before configuring Geyser automatically.',
      requested
    );
  }
  if (loaderProviderId === 'vanilla') {
    return evaluateConcrete({ ...requested, minecraftVersion: requested.minecraftVersion || 'latest', loaderVersion: 'vanilla' }, context);
  }
  const catalog = context.loaderCatalog;
  if (!catalog || typeof catalog.listMinecraftVersions !== 'function' || typeof catalog.listLoaderVersions !== 'function') {
    return unsupported(
      'LOADER_PROVIDER_UNAVAILABLE',
      `The ${loaderLabel(loaderProviderId) || 'selected'} loader is not installed or is disabled.`,
      requested
    );
  }
  const timeoutMs = Number(context.timeoutMs) > 0 ? Number(context.timeoutMs) : LOOKUP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let minecraftVersions;
  try {
    minecraftVersions = await withTimeout(
      catalog.listMinecraftVersions(),
      Math.max(250, deadline - Date.now()),
      'VERSION_CATALOG_UNAVAILABLE',
      'Timed out while loading Minecraft versions for this loader. Try again, or create the Java server without Geyser.'
    );
  } catch (err) {
    return unsupported(
      err.code || 'VERSION_CATALOG_UNAVAILABLE',
      err.message || 'The Java version catalog could not be loaded.',
      requested
    );
  }
  const stableMc = sortVersionsNewest(
    (Array.isArray(minecraftVersions) ? minecraftVersions : []).filter((id) => !isUnstableRelease(id)),
    'minecraft'
  ).slice(0, MAX_MINECRAFT_CANDIDATES);
  if (!stableMc.length) {
    return unsupported(
      'NO_STABLE_MINECRAFT',
      `No compatible stable Minecraft version is available for ${loaderLabel(loaderProviderId)}.`,
      requested
    );
  }

  let lastFailure = null;
  for (const minecraftVersion of stableMc) {
    if (Date.now() > deadline) {
      return unsupported(
        'VERSION_CATALOG_UNAVAILABLE',
        'Timed out while searching for a compatible Geyser configuration. Try again, or create the Java server without Geyser.',
        requested
      );
    }
    let loaderVersions;
    try {
      loaderVersions = await withTimeout(
        catalog.listLoaderVersions(minecraftVersion),
        Math.max(250, deadline - Date.now()),
        'VERSION_CATALOG_UNAVAILABLE',
        `Timed out while loading ${loaderLabel(loaderProviderId)} versions.`
      );
    } catch (err) {
      lastFailure = unsupported(
        err.code || 'VERSION_CATALOG_UNAVAILABLE',
        err.message || `Could not load ${loaderLabel(loaderProviderId)} versions.`,
        { ...requested, minecraftVersion }
      );
      continue;
    }
    const stableLoaders = sortVersionsNewest(
      (Array.isArray(loaderVersions) ? loaderVersions : []).filter((id) => !isUnstableRelease(id))
    ).slice(0, MAX_LOADER_CANDIDATES);
    if (!stableLoaders.length) {
      lastFailure = unsupported(
        'NO_COMPATIBLE_LOADER_VERSION',
        `No stable ${loaderLabel(loaderProviderId)} version is available for Minecraft ${minecraftVersion}.`,
        { ...requested, minecraftVersion }
      );
      continue;
    }
    for (const loaderVersion of stableLoaders) {
      if (Date.now() > deadline) break;
      const candidate = {
        kind: 'java',
        minecraftVersion,
        loaderProviderId,
        loaderVersion,
      };
      const rec = await evaluateConcrete(candidate, context);
      if (SUCCESS_STATUSES.has(rec.status)) {
        const adjusted = isVersionAlias(requested.minecraftVersion)
          || isVersionAlias(requested.loaderVersion)
          || requested.minecraftVersion !== minecraftVersion
          || requested.loaderVersion !== loaderVersion;
        const newestMc = stableMc[0];
        const limitations = [...(rec.limitations || [])];
        if (minecraftVersion !== newestMc) {
          limitations.unshift(
            `Minecraft ${minecraftVersion} is not the newest ${loaderLabel(loaderProviderId)} release; newer versions are not compatible with the current Geyser/Floodgate set.`
          );
        }
        const message = adjusted
          ? `Geyser automatic configuration selected Minecraft ${minecraftVersion} and ${loaderLabel(loaderProviderId)} ${loaderVersion} because they are the newest compatible versions.`
          : rec.message;
        return result({
          status: rec.status,
          recommendedMode: rec.recommendedMode,
          authentication: rec.authentication,
          message,
          selectionAdjusted: adjusted,
          target: candidate,
          recommendedTarget: recommendedTargetOf(candidate),
          requiredArtifacts: rec.requiredArtifacts,
          warnings: rec.warnings,
          limitations,
          summary: rec.summary,
          viaProxyReason: rec.viaProxyReason,
        });
      }
      lastFailure = rec;
    }
  }
  if (lastFailure) {
    return unsupported(
      lastFailure.code || 'NO_COMPATIBLE_COMBINATION',
      lastFailure.message || `No compatible Geyser configuration exists for ${loaderLabel(loaderProviderId)}.`,
      requested,
      {
        alternatives: lastFailure.alternatives,
        summary: lastFailure.summary,
      }
    );
  }
  return unsupported(
    'NO_COMPATIBLE_COMBINATION',
    `No compatible Geyser protocol route, Floodgate build, or ${loaderLabel(loaderProviderId)} version was found.`,
    requested
  );
}

async function recommendProspectiveTarget(target = {}, context = {}) {
  const loaderProviderId = String(target.loaderProviderId || target.loader || '').toLowerCase();
  if (loaderProviderId && context.loaderCatalog?.id && String(context.loaderCatalog.id).toLowerCase() !== loaderProviderId) {
    return unsupported(
      'LOADER_PROVIDER_UNAVAILABLE',
      'Automatic configuration will not change the selected Java loader.',
      {
        kind: 'java',
        minecraftVersion: String(target.minecraftVersion || ''),
        loaderProviderId,
        loaderVersion: String(target.loaderVersion || ''),
      }
    );
  }
  if (wantsLatestCompatible(target, context)) {
    return findLatestCompatible(target, context);
  }
  return evaluateConcrete(target, context);
}

module.exports = {
  LIMITATIONS,
  LOOKUP_TIMEOUT_MS,
  SUCCESS_STATUSES,
  evaluateConcrete,
  findLatestCompatible,
  recommendProspectiveTarget,
};
