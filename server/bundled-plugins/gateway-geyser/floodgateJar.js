'use strict';

const fs = require('fs');
const path = require('path');
const javaModMetadata = require('../../services/javaModMetadata');
const zipGuard = require('../../services/zipGuard');
const {
  FABRIC_LOADER_MOD_ID,
  FLOODGATE_MOD_ID,
  evaluateConstraint,
  fabricApiDependIds,
  isFabricApiModId,
  neoForgeMajor,
  preferredFabricApiDependId,
} = require('./floodgateVersions');

function formatConstraint(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((item) => String(item)).join(' | ');
  return String(value);
}

function listJarNames(filePath) {
  return zipGuard.assertSafeZipNames(
    zipGuard.listStoredZipEntries(filePath, { limitEntries: false }),
    { limitEntries: false }
  );
}

function readJarText(filePath, name) {
  return zipGuard.readNamedText(filePath, name);
}

function assertJarArchive(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw Object.assign(new Error('Downloaded Floodgate artifact is not a JAR archive'), {
      status: 400,
      code: 'FLOODGATE_JAR_INVALID',
    });
  }
}

function findEntry(names, wanted) {
  return names.find((name) => name === wanted || name.endsWith(`/${wanted}`));
}

function neoForgeMetadataKind(names) {
  if (findEntry(names, 'META-INF/neoforge.mods.toml') || names.some((name) => name.endsWith('neoforge.mods.toml'))) {
    return 'neoforge.mods.toml';
  }
  if (names.some((name) => name.endsWith('mods.toml'))) return 'mods.toml';
  return null;
}

function neoForgeFormatSupported(kind, loaderVersion) {
  const major = neoForgeMajor(loaderVersion);
  if (!kind) return false;
  if (major == null) return true;
  if (major <= 20) return kind === 'mods.toml';
  return kind === 'neoforge.mods.toml' || kind === 'mods.toml';
}

function fabricDepends(json) {
  const depends = json && typeof json.depends === 'object' && !Array.isArray(json.depends) ? json.depends : {};
  return depends;
}

function inspectFabric(filePath, names) {
  try {
  const name = findEntry(names, 'fabric.mod.json');
  if (!name) return null;
  const json = JSON.parse(readJarText(filePath, name));
  const depends = fabricDepends(json);
  return {
    loader: 'fabric',
    metadataKind: 'fabric.mod.json',
    modId: String(json.id || ''),
    environment: String(json.environment || '*'),
    minecraftConstraint: depends.minecraft || '',
    loaderConstraint: depends[FABRIC_LOADER_MOD_ID] || depends.fabricloader || '',
    requiresFabricApi: fabricApiDependIds(depends).length > 0,
    fabricApiDependId: preferredFabricApiDependId(depends),
    depends,
  };
  } catch {
    return null;
  }
}

function inspectNeoForge(filePath, names) {
  const kind = neoForgeMetadataKind(names);
  if (!kind) return null;
  const name = names.find((item) => item.endsWith(kind));
  const text = readJarText(filePath, name);
  const detected = javaModMetadata.detectNeoForge(text);
  if (!detected) return null;
  const minecraftDep = (detected?.dependencies || []).find((item) => String(item.id).toLowerCase() === 'minecraft');
  const neoDep = (detected?.dependencies || []).find((item) => ['neoforge', 'forge'].includes(String(item.id).toLowerCase()));
  const minecraftField = (detected?.minecraftVersions || [])[0] || '';
  return {
    loader: 'neoforge',
    metadataKind: kind,
    modId: String(detected?.metadata?.modId || ''),
    environment: detected?.environment || 'unknown',
    minecraftConstraint: minecraftDep?.version || minecraftField || '',
    loaderConstraint: neoDep?.version || '',
    requiresFabricApi: false,
    depends: detected?.dependencies || [],
  };
}

function inspectModJar(filePath) {
  assertJarArchive(filePath);
  const names = listJarNames(filePath);
  let inspected = inspectFabric(filePath, names);
  if (!inspected) inspected = inspectNeoForge(filePath, names);
  if (!inspected) {
    throw Object.assign(new Error('The downloaded JAR does not contain Fabric or NeoForge mod metadata'), {
      status: 400,
      code: 'FLOODGATE_JAR_INVALID',
    });
  }
  const info = javaModMetadata.inspectJar(filePath, { hash: true });
  return { ...inspected, sha256: info.sha256, fileSize: info.fileSize, environment: inspected.environment || info.environment };
}

function clientOnly(inspected) {
  const env = String(inspected.environment || '').toLowerCase();
  return env === 'client';
}

function reject(code, message) {
  throw Object.assign(new Error(message), { status: 400, code });
}

function validateAgainstTarget(inspected, target, artifact) {
  if (clientOnly(inspected)) {
    reject('FLOODGATE_CLIENT_ONLY', 'That artifact is client-only and cannot be installed on a dedicated server.');
  }
  if (String(inspected.loader) !== String(target.loader)) {
    reject('FLOODGATE_LOADER_MISMATCH', `The JAR loader (${inspected.loader}) does not match this Java server (${target.loader}).`);
  }
  if (target.loader === 'neoforge' && !neoForgeFormatSupported(inspected.metadataKind, target.loaderVersion)) {
    reject(
      'FLOODGATE_METADATA_UNSUPPORTED',
      `This Floodgate JAR uses ${inspected.metadataKind}, which NeoForge ${target.loaderVersion || 'unknown'} cannot load.`
    );
  }
  if (inspected.minecraftConstraint) {
    const minecraft = evaluateConstraint(inspected.minecraftConstraint, target.minecraftVersion, 'minecraft');
    if (!minecraft.compatible) {
      reject(
        'FLOODGATE_MINECRAFT_MISMATCH',
        minecraft.parseError
          ? minecraft.reason
          : (minecraft.reason || `Floodgate requires Minecraft ${formatConstraint(inspected.minecraftConstraint)}, which does not include ${target.minecraftVersion}.`)
      );
    }
  }
  if (inspected.loaderConstraint && target.loaderVersion) {
    const loader = evaluateConstraint(inspected.loaderConstraint, target.loaderVersion, 'loader');
    if (!loader.compatible) {
      const label = target.loader === 'fabric' ? 'Fabric Loader' : 'NeoForge';
      reject(
        'FLOODGATE_LOADER_VERSION_MISMATCH',
        loader.parseError
          ? loader.reason
          : (loader.reason || `Floodgate requires ${label} ${formatConstraint(inspected.loaderConstraint)}, which does not include ${target.loaderVersion}.`)
      );
    }
  }
  if (artifact?.gameVersions?.length && inspected.minecraftConstraint) {
    const disagree = artifact.gameVersions.filter((version) => (
      !evaluateConstraint(inspected.minecraftConstraint, version, 'minecraft').compatible
    ));
    if (disagree.length) {
      reject(
        'FLOODGATE_METADATA_DISAGREEMENT',
        'The Modrinth catalog version does not match the Minecraft constraint embedded in the JAR.'
      );
    }
  }
  return inspected;
}

function validateFloodgateJar(filePath, target, artifact) {
  const inspected = inspectModJar(filePath);
  if (inspected.modId !== FLOODGATE_MOD_ID) {
    reject('FLOODGATE_JAR_INVALID', `Expected Floodgate JAR (id floodgate), found "${inspected.modId || 'unknown'}".`);
  }
  return validateAgainstTarget(inspected, target, artifact);
}

function validateFabricApiJar(filePath, target, artifact) {
  const inspected = inspectModJar(filePath);
  if (inspected.modId === FABRIC_LOADER_MOD_ID) {
    reject('FABRIC_LOADER_NOT_API', 'That file is Fabric Loader, not Fabric API. Floodgate requires the Fabric API mod.');
  }
  if (!isFabricApiModId(inspected.modId)) {
    reject('FABRIC_API_JAR_INVALID', `Expected Fabric API JAR (id fabric-api), found "${inspected.modId || 'unknown'}".`);
  }
  return validateAgainstTarget(inspected, { ...target, loader: 'fabric' }, artifact);
}

function inspectInstalledMods(serverDir) {
  const modsDir = path.join(serverDir, 'mods');
  let names = [];
  try { names = fs.readdirSync(modsDir); } catch { return []; }
  const found = [];
  for (const name of names) {
    if (!/\.jar$/i.test(name)) continue;
    const filePath = path.join(modsDir, name);
    try {
      const inspected = inspectModJar(filePath);
      found.push({
        filename: name,
        path: filePath,
        rel: `mods/${name}`,
        ...inspected,
      });
    } catch {
      found.push({
        filename: name,
        path: filePath,
        rel: `mods/${name}`,
        modId: '',
        loader: '',
        unreadable: true,
      });
    }
  }
  return found;
}

module.exports = {
  inspectInstalledMods,
  inspectModJar,
  neoForgeFormatSupported,
  neoForgeMetadataKind,
  validateFabricApiJar,
  validateFloodgateJar,
};
