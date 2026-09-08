'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  FLOODGATE_MOD_ID,
  isFabricApiModId,
  isGeyserNativeJavaVersion,
  loaderLabel,
  paperLikeLoader,
} = require('./floodgateVersions');
const { inspectInstalledMods, validateFabricApiJar, validateFloodgateJar } = require('./floodgateJar');
const { resolveFloodgateArtifact, resolveFabricApiArtifact } = require('./floodgateCatalog');
const provenance = require('./floodgateProvenance');

const KEY_BYTES = 16;

function redactSensitive(text) {
  return String(text || '')
    .replace(/\b(?:key\.pem|floodgate-key-file)\b/gi, '[redacted-path]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b[0-9a-f:]{2,}:[0-9a-f:]{2,}\b/gi, '[redacted-ip]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]')
    .slice(0, 1000);
}

function explainLastError(message) {
  const text = String(message || '');
  if (!/ReadTimeoutException|timed?\s*out/i.test(text)) return redactSensitive(text);
  return 'Bedrock login timed out. The Bedrock client reached Geyser, but the Java-side handshake did not finish. Check that backend Floodgate is installed and compatible, that the Floodgate keys match, and that ViaProxy can reach the Java server if compatibility mode is enabled. ViaProxy and FloodgateJoin cannot replace a missing or incompatible backend Floodgate mod.';
}

function keyPath(dir) {
  return path.join(dir, 'key.pem');
}

function keyIsValid(file) {
  try {
    return fs.existsSync(file) && fs.readFileSync(file).length === KEY_BYTES;
  } catch {
    return false;
  }
}

function keysMatch(left, right) {
  try {
    if (!keyIsValid(left) || !keyIsValid(right)) return false;
    const a = fs.readFileSync(left);
    const b = fs.readFileSync(right);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function paperFloodgateJar(serverDir) {
  const folder = path.join(serverDir, 'plugins');
  let names = [];
  try { names = fs.readdirSync(folder); } catch { return null; }
  const name = names.find((item) => /floodgate/i.test(item) && /\.jar$/i.test(item));
  return name ? path.join(folder, name) : null;
}

function floodgateKeyLocations(serverDir) {
  return [
    path.join(serverDir, 'plugins', 'floodgate', 'key.pem'),
    path.join(serverDir, 'config', 'floodgate', 'key.pem'),
  ];
}

function targetFrom(server = {}) {
  return {
    loader: String(server.loader_provider_id || server.loader || '').toLowerCase(),
    minecraftVersion: String(server.minecraft_version || server.minecraftVersion || server.version || '').trim(),
    loaderVersion: String(server.loader_version || server.loaderVersion || '').trim(),
  };
}

function inspectModReadiness(server) {
  const target = targetFrom(server);
  const installed = inspectInstalledMods(server.data_path || '');
  const floodgate = installed.find((item) => item.modId === FLOODGATE_MOD_ID);
  const fabricApi = installed.find((item) => isFabricApiModId(item.modId));
  let floodgateError = null;
  let fabricError = null;
  if (floodgate) {
    try { validateFloodgateJar(floodgate.path, target, { gameVersions: [target.minecraftVersion] }); } catch (err) { floodgateError = err; }
  }
  if (fabricApi && target.loader === 'fabric') {
    try { validateFabricApiJar(fabricApi.path, target, { gameVersions: [target.minecraftVersion] }); } catch (err) { fabricError = err; }
  }
  const floodgateCompatible = Boolean(floodgate) && !floodgateError;
  const fabricCompatible = target.loader !== 'fabric' || (Boolean(fabricApi) && !fabricError);
  const ready = floodgateCompatible && fabricCompatible;
  return {
    target,
    floodgateInstalled: Boolean(floodgate),
    floodgateCompatible,
    floodgateManagerOwned: floodgate ? provenance.isManagerOwned(server.data_path, floodgate.rel) : false,
    fabricApiInstalled: Boolean(fabricApi),
    fabricApiCompatible: fabricCompatible,
    fabricApiManagerOwned: fabricApi ? provenance.isManagerOwned(server.data_path, fabricApi.rel) : false,
    ready,
    floodgateError,
    fabricError,
    code: ready
      ? null
      : (!floodgate
        ? 'FLOODGATE_MISSING'
        : (floodgateError
          ? (floodgateError.code || 'FLOODGATE_INCOMPATIBLE')
          : (!fabricApi ? 'FABRIC_API_MISSING' : (fabricError?.code || 'FABRIC_API_INCOMPATIBLE')))),
  };
}

function inspectReadiness(server) {
  const target = targetFrom(server);
  if (paperLikeLoader(target.loader)) {
    const jar = paperFloodgateJar(server.data_path || '');
    return {
      target,
      floodgateInstalled: Boolean(jar),
      floodgateCompatible: Boolean(jar),
      fabricApiInstalled: false,
      fabricApiCompatible: true,
      ready: Boolean(jar),
      code: jar ? null : 'FLOODGATE_MISSING',
    };
  }
  return inspectModReadiness(server);
}

function viaProxyRequired(minecraftVersion, nativeVersions) {
  if (!minecraftVersion) return false;
  return !isGeyserNativeJavaVersion(minecraftVersion, nativeVersions);
}

function lineForFloodgate(readiness, catalog) {
  if (catalog?.unsupported) return 'Floodgate: No compatible build available';
  if (readiness.floodgateCompatible) return 'Floodgate: Installed and compatible';
  if (readiness.floodgateInstalled) return 'Floodgate: Installed but incompatible';
  if (catalog?.floodgate) return `Floodgate: Compatible version found (${catalog.floodgate.versionNumber})`;
  return 'Floodgate: Missing';
}

function lineForFabricApi(readiness, catalog) {
  if (readiness.target.loader !== 'fabric') return null;
  if (readiness.fabricApiCompatible && readiness.fabricApiInstalled) return 'Fabric API: Installed and compatible';
  if (readiness.fabricApiInstalled) return 'Fabric API: Installed but incompatible';
  if (catalog?.fabricApi) return 'Fabric API: Required — will be installed';
  return 'Fabric API: Required';
}

function actionRequired(readiness, catalog, viaNeeded, viaEnabled) {
  if (catalog?.unsupported) {
    return 'Action required: Change the server loader/version or authentication mode';
  }
  if (!readiness.ready) {
    return 'Action required: Install a compatible Floodgate backend before starting Geyser. ViaProxy cannot correct a missing Floodgate mod.';
  }
  if (viaNeeded && !viaEnabled) {
    return 'Action required: Enable ViaProxy for protocol translation. ViaProxy does not replace backend Floodgate.';
  }
  return '';
}

async function catalogProbe(target, deps) {
  if (!['fabric', 'neoforge'].includes(target.loader) || !target.minecraftVersion) {
    return { floodgate: null, fabricApi: null, unsupported: false };
  }
  try {
    const floodgate = await resolveFloodgateArtifact(target, deps);
    let fabricApi = null;
    if (target.loader === 'fabric') {
      fabricApi = await resolveFabricApiArtifact(target, deps);
    }
    return { floodgate, fabricApi, unsupported: false };
  } catch (err) {
    if (err.code === 'FLOODGATE_UNSUPPORTED_TARGET' || err.code === 'FABRIC_API_UNSUPPORTED_TARGET') {
      return { floodgate: null, fabricApi: null, unsupported: true, error: err };
    }
    throw err;
  }
}

function summaryLines({ server, gateway, nativeVersions, readiness, catalog }) {
  const target = readiness.target;
  const viaNeeded = viaProxyRequired(target.minecraftVersion, nativeVersions);
  const viaEnabled = String(gateway?.compatibility_mode || gateway?.compatibilityMode || 'direct') === 'viaproxy';
  const lines = [
    `Target: Minecraft ${target.minecraftVersion || 'unknown'}`,
    `Loader: ${loaderLabel(target.loader)}${target.loaderVersion ? ` ${target.loaderVersion}` : ''}`,
    lineForFloodgate(readiness, catalog),
  ];
  const fabricLine = lineForFabricApi(readiness, catalog);
  if (fabricLine) lines.push(fabricLine);
  lines.push(viaNeeded
    ? (viaEnabled
      ? 'ViaProxy: Required for protocol translation'
      : 'ViaProxy: Required for protocol translation')
    : 'ViaProxy: Not required for protocol compatibility');
  const action = actionRequired(readiness, catalog, viaNeeded, viaEnabled);
  if (action) lines.push(action);
  return lines;
}

function structuredError(code, message, extra = {}) {
  return Object.assign(new Error(message), { status: 400, code, ...extra });
}

function preflightStart({ server, gateway, nativeVersions, skipKeys = false, keysOnly = false }) {
  if (!keysOnly) {
    if (!server) {
      return structuredError('JAVA_SERVER_MISSING', 'The associated Java server no longer exists. Choose a new target before starting this gateway.');
    }
    const target = targetFrom(server);
    if (!target.minecraftVersion) {
      return structuredError('JAVA_VERSION_UNKNOWN', 'This Java server does not have a known Minecraft version.');
    }
    if (!target.loader) {
      return structuredError('JAVA_LOADER_UNKNOWN', 'This Java server does not have a known loader.');
    }
    if (['fabric', 'neoforge'].includes(target.loader) && !target.loaderVersion) {
      return structuredError('JAVA_LOADER_UNKNOWN', `This Java server does not have a known ${loaderLabel(target.loader)} version.`, {
        loader: target.loader,
        minecraftVersion: target.minecraftVersion,
      });
    }
    const viaNeeded = viaProxyRequired(target.minecraftVersion, nativeVersions);
    const viaEnabled = String(gateway.compatibility_mode || 'direct') === 'viaproxy';
    if (viaNeeded && !viaEnabled) {
      return structuredError(
        'VIAPROXY_REQUIRED',
        'This Java server is older than Geyser\'s native protocol. Enable ViaProxy for translation. ViaProxy does not replace backend Floodgate.'
      );
    }
    if (gateway.authentication !== 'floodgate') return null;
    if (String(gateway.compatibility_mode || 'direct') === 'viaproxy' && gateway.authentication === 'online') {
      return structuredError('AUTH_INCOMPATIBLE', 'ViaProxy CLI mode cannot join an online-mode Java server without Floodgate.');
    }
    const readiness = inspectReadiness(server);
    if (!readiness.floodgateInstalled) {
      return structuredError(
        'FLOODGATE_MISSING',
        'Backend Floodgate is not installed on the Java server. Install Floodgate before starting Geyser. FloodgateJoin is not a replacement for the backend Floodgate mod.',
        { loader: target.loader, minecraftVersion: target.minecraftVersion, loaderVersion: target.loaderVersion }
      );
    }
    if (!readiness.floodgateCompatible) {
      return structuredError(
        readiness.code || 'FLOODGATE_INCOMPATIBLE',
        readiness.floodgateError?.message || 'The installed Floodgate JAR is not compatible with this Java server.',
        { loader: target.loader, minecraftVersion: target.minecraftVersion, loaderVersion: target.loaderVersion }
      );
    }
    if (target.loader === 'fabric' && !readiness.fabricApiCompatible) {
      return structuredError(
        readiness.fabricApiInstalled ? 'FABRIC_API_INCOMPATIBLE' : 'FABRIC_API_MISSING',
        readiness.fabricError?.message || 'Floodgate on Fabric requires a compatible Fabric API build. Fabric Loader is not a substitute.',
        { loader: target.loader, minecraftVersion: target.minecraftVersion, loaderVersion: target.loaderVersion }
      );
    }
    if (skipKeys) return null;
  }
  if (gateway.authentication !== 'floodgate') return null;
  const target = server ? targetFrom(server) : {};
  const gatewayKey = keyPath(gateway.data_path);
  if (!keyIsValid(gatewayKey)) {
    return structuredError('FLOODGATE_KEY_MISSING', 'The Geyser Floodgate key is missing or not a 16-byte AES key.');
  }
  if (server?.data_path) {
    const dests = floodgateKeyLocations(server.data_path).filter((file) => fs.existsSync(file));
    if (!dests.length) {
      return structuredError('FLOODGATE_KEY_MISSING', 'The Java server does not have a Floodgate key in the expected location.');
    }
    if (dests.some((file) => !keysMatch(gatewayKey, file))) {
      return structuredError('FLOODGATE_KEY_MISMATCH', 'The Geyser and Java Floodgate keys do not match.');
    }
  }
  return null;
}

async function statusFor({ server, gateway, nativeVersions, deps }) {
  const readiness = server ? inspectReadiness(server) : {
    target: targetFrom({}),
    ready: false,
    floodgateInstalled: false,
    floodgateCompatible: false,
    fabricApiCompatible: true,
    code: 'JAVA_SERVER_MISSING',
  };
  let catalog = { floodgate: null, fabricApi: null, unsupported: false };
  if (server && ['fabric', 'neoforge'].includes(readiness.target.loader)) {
    try {
      catalog = await catalogProbe(readiness.target, deps);
    } catch {
      catalog = { floodgate: null, fabricApi: null, unsupported: false };
    }
  }
  const viaNeeded = viaProxyRequired(readiness.target.minecraftVersion, nativeVersions);
  const viaEnabled = String(gateway?.compatibility_mode || gateway?.compatibilityMode || 'direct') === 'viaproxy';
  const canStart = gateway?.authentication !== 'floodgate'
    || (readiness.ready && (!viaNeeded || viaEnabled));
  return {
    target: readiness.target,
    ready: readiness.ready,
    canStart,
    code: catalog.unsupported ? 'FLOODGATE_UNSUPPORTED_TARGET' : readiness.code,
    unsupported: Boolean(catalog.unsupported),
    viaProxyRequired: viaNeeded,
    viaProxyEnabled: viaEnabled,
    floodgate: {
      installed: readiness.floodgateInstalled,
      compatible: readiness.floodgateCompatible,
      available: Boolean(catalog.floodgate) || (paperLikeLoader(readiness.target.loader) && true),
      version: catalog.floodgate?.versionNumber || null,
    },
    fabricApi: {
      required: readiness.target.loader === 'fabric',
      installed: readiness.fabricApiInstalled,
      compatible: readiness.fabricApiCompatible,
      willInstall: readiness.target.loader === 'fabric' && !readiness.fabricApiCompatible && Boolean(catalog.fabricApi),
    },
    summary: summaryLines({ server, gateway, nativeVersions, readiness, catalog }),
    message: catalog.error?.message || readiness.floodgateError?.message || '',
    loader: readiness.target.loader,
    minecraftVersion: readiness.target.minecraftVersion,
    loaderVersion: readiness.target.loaderVersion,
  };
}

module.exports = {
  explainLastError,
  inspectReadiness,
  keysMatch,
  keyIsValid,
  preflightStart,
  redactSensitive,
  statusFor,
  targetFrom,
  viaProxyRequired,
};
