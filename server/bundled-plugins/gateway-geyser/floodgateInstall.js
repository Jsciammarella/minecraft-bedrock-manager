'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const controlledFs = require('../../services/controlledFs');
const javaLoaderHost = require('../../services/javaLoaderHost');
const {
  FABRIC_API_MOD_ID,
  FLOODGATE_MOD_ID,
  isFabricApiModId,
} = require('./floodgateVersions');
const {
  resolveFabricApiArtifact,
  resolveFloodgateArtifact,
  safeJarName,
} = require('./floodgateCatalog');
const {
  inspectInstalledMods,
  validateFabricApiJar,
  validateFloodgateJar,
} = require('./floodgateJar');
const provenance = require('./floodgateProvenance');

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

function uniqueDestination(serverDir, preferredRel, filename) {
  const preferred = controlledFs.assertRelative(preferredRel);
  const dest = controlledFs.resolveInRoot(serverDir, preferred);
  if (!fs.existsSync(dest)) return preferred;
  const dir = path.posix.dirname(preferred);
  const safe = safeJarName(filename, path.posix.basename(preferred));
  const alt = dir === '.' ? safe : `${dir}/${safe}`;
  const altPath = controlledFs.resolveInRoot(serverDir, alt);
  if (!fs.existsSync(altPath) || path.resolve(altPath) === path.resolve(dest)) return alt;
  const parsed = path.posix.parse(safe);
  const tagged = `${dir === '.' ? '' : `${dir}/`}${parsed.name}-${crypto.randomBytes(4).toString('hex')}${parsed.ext}`;
  return tagged;
}

function findInstalled(serverDir, modId) {
  const installed = inspectInstalledMods(serverDir).filter((item) => !item.unreadable);
  if (typeof modId === 'function') return installed.find(modId) || null;
  if (isFabricApiModId(modId) || modId === FABRIC_API_MOD_ID) {
    return installed.find((item) => isFabricApiModId(item.modId)) || null;
  }
  return installed.find((item) => item.modId === modId) || null;
}

function existingState(serverDir, modId, validate, target, artifact) {
  const installed = findInstalled(serverDir, modId);
  if (!installed) return { present: false };
  try {
    validate(installed.path, target, artifact);
    return {
      present: true,
      compatible: true,
      managerOwned: provenance.isManagerOwned(serverDir, installed.rel),
      installed,
    };
  } catch (err) {
    return {
      present: true,
      compatible: false,
      managerOwned: provenance.isManagerOwned(serverDir, installed.rel),
      installed,
      error: err,
    };
  }
}

async function planModInstall(server, deps = {}) {
  const target = {
    loader: String(server.loader_provider_id || server.loader || '').toLowerCase(),
    minecraftVersion: String(server.minecraft_version || server.minecraftVersion || server.version || '').trim(),
    loaderVersion: String(server.loader_version || server.loaderVersion || '').trim(),
  };
  if (!target.minecraftVersion) {
    throw Object.assign(new Error('This Java server does not have a known Minecraft version, so Floodgate cannot be resolved.'), {
      status: 400,
      code: 'JAVA_VERSION_UNKNOWN',
    });
  }
  if (!target.loaderVersion) {
    throw Object.assign(new Error(`This Java server does not have a known ${target.loader} version, so Floodgate cannot be validated.`), {
      status: 400,
      code: 'JAVA_LOADER_UNKNOWN',
      loader: target.loader,
      minecraftVersion: target.minecraftVersion,
    });
  }
  const floodgate = await resolveFloodgateArtifact(target, deps);
  const artifacts = [floodgate];
  const floodgateState = existingState(server.data_path, FLOODGATE_MOD_ID, validateFloodgateJar, target, floodgate);
  if (floodgateState.present && !floodgateState.compatible && !floodgateState.managerOwned) {
    throw Object.assign(
      new Error('An existing Floodgate JAR is not compatible with this Java server. The manager will not replace a user-installed file. Remove it or choose a supported server version.'),
      { status: 400, code: 'FLOODGATE_USER_FILE_PRESERVED' }
    );
  }
  let fabricApi = null;
  if (target.loader === 'fabric') {
    fabricApi = await resolveFabricApiArtifact(target, deps);
    artifacts.push(fabricApi);
    const apiState = existingState(server.data_path, FABRIC_API_MOD_ID, validateFabricApiJar, target, fabricApi);
    if (apiState.present && !apiState.compatible && !apiState.managerOwned) {
      throw Object.assign(
        new Error('An existing Fabric API JAR is not compatible with this Java server. The manager will not replace a user-installed file. Install a matching Fabric API build or choose another authentication method.'),
        { status: 400, code: 'FABRIC_API_USER_FILE_PRESERVED' }
      );
    }
    floodgate.needsFabricApi = true;
  }
  return {
    installMode: 'atomic',
    target,
    artifacts,
    existing: {
      floodgate: floodgateState,
      fabricApi: fabricApi
        ? existingState(server.data_path, FABRIC_API_MOD_ID, validateFabricApiJar, target, fabricApi)
        : { present: false },
    },
    result: {
      loader: target.loader,
      floodgateVersion: floodgate.versionNumber,
      fabricApiVersion: fabricApi?.versionNumber || null,
      destinationKind: 'mods',
      needsFabricApi: Boolean(fabricApi),
    },
    downloads: artifacts.map((item) => ({
      url: item.url,
      destination: item.destination,
      maximumBytes: item.maximumBytes,
      project: item.role === 'fabric-api' ? 'Fabric API' : 'Floodgate',
      version: item.versionNumber,
      license: item.license,
      sha512: item.hashes.sha512,
      sha256: item.hashes.sha256,
      sha1: item.hashes.sha1,
    })),
  };
}

function validateDownloaded(stagedPath, artifact, target) {
  if (artifact.role === 'fabric-api') return validateFabricApiJar(stagedPath, target, artifact);
  return validateFloodgateJar(stagedPath, target, artifact);
}

async function executeAtomicPlan(plan, {
  serverDir,
  allowHosts,
  downloadToFile,
  copyKey,
} = {}) {
  javaLoaderHost.validatePlan(plan);
  const controlledDownload = require('../../services/controlledDownload');
  const download = downloadToFile || controlledDownload.downloadToFile;
  const toInstall = [];
  for (const artifact of plan.artifacts || []) {
    const existing = artifact.role === 'fabric-api' ? plan.existing.fabricApi : plan.existing.floodgate;
    if (existing?.present && existing.compatible) continue;
    toInstall.push(artifact);
  }
  if (!toInstall.length) {
    if (typeof copyKey === 'function') copyKey();
    return { installed: false, alreadyPresent: true, artifacts: [] };
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mbm-floodgate-'));
  const staged = [];
  const backups = [];
  const placed = [];
  try {
    for (const artifact of toInstall) {
      const filename = safeJarName(artifact.filename, path.posix.basename(artifact.destination));
      const stagedPath = path.join(stage, filename);
      await download({
        url: artifact.url,
        destination: stagedPath,
        sha512: artifact.hashes.sha512,
        sha256: artifact.hashes.sha256,
        sha1: artifact.hashes.sha1,
        maximumBytes: artifact.maximumBytes,
        allowHosts,
        project: artifact.role === 'fabric-api' ? 'Fabric API' : 'Floodgate',
        version: artifact.versionNumber,
      });
      if (!fs.existsSync(stagedPath)) {
        throw Object.assign(new Error('Floodgate download did not produce a file'), { status: 500 });
      }
      const inspected = validateDownloaded(stagedPath, artifact, plan.target);
      staged.push({ artifact, stagedPath, inspected, filename });
    }

    for (const item of staged) {
      const existing = item.artifact.role === 'fabric-api' ? plan.existing.fabricApi : plan.existing.floodgate;
      let rel = item.artifact.destination;
      if (existing?.present && existing.managerOwned) {
        rel = existing.installed.rel;
        const dest = controlledFs.resolveInRoot(serverDir, rel);
        const backup = `${dest}.mbm-bak`;
        fs.copyFileSync(dest, backup);
        backups.push({ dest, backup, rel });
      } else if (existing?.present && existing.compatible) {
        continue;
      } else {
        rel = uniqueDestination(serverDir, item.artifact.destination, item.filename);
      }
      item.rel = rel;
    }

    for (const item of staged) {
      if (!item.rel) continue;
      const dest = controlledFs.resolveInRoot(serverDir, item.rel);
      if (fs.existsSync(dest) && !backups.some((entry) => entry.dest === dest)) {
        throw Object.assign(
          new Error(`Refusing to replace ${item.rel} because it was not installed by the Geyser plugin.`),
          { status: 400, code: 'FLOODGATE_USER_FILE_PRESERVED' }
        );
      }
      moveFile(item.stagedPath, dest);
      placed.push({ dest, rel: item.rel, artifact: item.artifact, inspected: item.inspected });
    }

    provenance.record(serverDir, placed.map((item) => ({
      ...item.artifact,
      filename: path.basename(item.dest),
      destination: item.rel,
      sha256: item.inspected.sha256,
      sourceUrl: item.artifact.url,
      modId: item.inspected.modId,
    })));

    if (typeof copyKey === 'function') copyKey();
    return {
      installed: true,
      alreadyPresent: false,
      artifacts: placed.map((item) => ({
        destination: item.rel,
        filename: path.basename(item.dest),
        version: item.artifact.versionNumber,
        role: item.artifact.role,
      })),
    };
  } catch (err) {
    for (const item of placed) {
      try { fs.rmSync(item.dest, { force: true }); } catch { /* ignore */ }
    }
    for (const item of backups) {
      try {
        if (fs.existsSync(item.backup)) moveFile(item.backup, item.dest);
      } catch { /* ignore */ }
    }
    throw err;
  } finally {
    for (const item of backups) {
      try { fs.rmSync(item.backup, { force: true }); } catch { /* ignore */ }
    }
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = {
  executeAtomicPlan,
  existingState,
  findInstalled,
  planModInstall,
};
