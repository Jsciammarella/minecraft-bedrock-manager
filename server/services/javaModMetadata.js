const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zipGuard = require('./zipGuard');
const { evaluateFabricDependency } = require('./fabricVersionPredicate');
const { isMavenRange, satisfiesMavenRange } = require('./mavenVersionRange');

const ALLOWED_ENVIRONMENTS = new Set(['client', 'server', 'both', 'unknown']);

function parseDependValue(version) {
  if (Array.isArray(version)) return version;
  if (typeof version === 'string') return version;
  if (version && typeof version === 'object' && version.value != null) {
    return Array.isArray(version.value) ? version.value : String(version.value);
  }
  return String(version || '*');
}

function parseDepends(raw, optional = false) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).map(([id, version]) => ({
    id,
    version: parseDependValue(version),
    optional: Boolean(optional),
  }));
}

function minecraftFromConstraint(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => minecraftFromConstraint(item)))];
  }
  return String(value || '').match(/\d+\.\d+(?:\.\d+)?/g) || [];
}

function fabricMinecraftRequirement(artifact) {
  const depends = artifact?.metadata?.depends;
  if (depends && typeof depends === 'object' && !Array.isArray(depends)
    && Object.prototype.hasOwnProperty.call(depends, 'minecraft')) {
    return depends.minecraft;
  }
  const listed = artifact?.dependencies;
  if (Array.isArray(listed)) {
    const dep = listed.find((item) => String(item?.id || '').toLowerCase() === 'minecraft');
    if (dep && dep.version != null && dep.version !== '') return dep.version;
  }
  return null;
}

function evaluateMinecraftRequirement(candidate, artifact) {
  const requirement = fabricMinecraftRequirement(artifact);
  if (requirement == null || requirement === '') return null;
  if (!Array.isArray(requirement) && isMavenRange(requirement)) {
    const compatible = satisfiesMavenRange(requirement, candidate, 'minecraft');
    return {
      compatible,
      candidate,
      constraint: String(requirement),
      normalizedCandidate: candidate,
      reason: compatible ? '' : `Minecraft ${candidate} is outside the required range ${requirement}.`,
    };
  }
  const loader = String(artifact?.loader || '').toLowerCase();
  if (loader === 'neoforge' || loader === 'forge') return null;
  return evaluateFabricDependency(candidate, requirement, {
    normalizeMinecraft: true,
    subject: 'Minecraft',
  });
}

function normalizeEnvironment(value) {
  const env = String(value || 'unknown').trim().toLowerCase();
  return ALLOWED_ENVIRONMENTS.has(env) ? env : 'unknown';
}

function fabricEnvironment(value) {
  const raw = value == null ? '' : String(value).trim().toLowerCase();
  if (raw === 'client' || raw === 'server') return raw;
  if (raw === '*' || raw === 'both' || raw === '') return 'both';
  return 'unknown';
}

function preferJarEnvironment(jarEnv, hintEnv) {
  const jar = normalizeEnvironment(jarEnv);
  if (jar !== 'unknown') return jar;
  return normalizeEnvironment(hintEnv);
}

function aggregateEnvironments(values) {
  const known = [...new Set((values || []).map(normalizeEnvironment).filter((value) => value !== 'unknown'))];
  if (!known.length) return 'unknown';
  if (known.length === 1) return known[0];
  if (known.includes('both') || (known.includes('client') && known.includes('server'))) return 'both';
  return known[0];
}

function detectFabric(text) {
  try {
    const json = JSON.parse(text);
    const env = fabricEnvironment(json.environment);
    const dependencies = [
      ...parseDepends(json.depends, false),
      ...parseDepends(json.recommends, true),
      ...parseDepends(json.suggests, true),
    ];
    return {
      loader: 'fabric',
      artifactType: 'mod',
      name: json.name || json.id,
      version: json.version || '0.0.0',
      environment: env,
      dependencies,
      minecraftVersions: minecraftFromConstraint(json.depends?.minecraft),
      license: Array.isArray(json.license) ? json.license.join(', ') : String(json.license || ''),
      metadata: { ...json, modId: json.id || json.name },
    };
  } catch {
    return null;
  }
}

function detectQuilt(text) {
  try {
    const json = JSON.parse(text);
    const loader = json.quilt_loader;
    if (!loader || typeof loader !== 'object') return null;
    const env = fabricEnvironment(
      json.minecraft?.environment ?? loader.environment ?? json.environment
    );
    return {
      loader: 'fabric',
      artifactType: 'mod',
      name: loader.metadata?.name || loader.id,
      version: loader.version || json.version || '0.0.0',
      environment: env,
      dependencies: [],
      minecraftVersions: minecraftFromConstraint(loader.depends?.minecraft || json.depends?.minecraft),
      license: String(loader.metadata?.license || ''),
      metadata: { ...json, modId: loader.id },
    };
  } catch {
    return null;
  }
}

function parseNeoForgeDependencies(text, selfId) {
  const blocks = String(text || '').split(/\[\[dependencies[^\]]*\]\]/i).slice(1);
  return blocks.map((block) => {
    const id = (block.match(/modId\s*=\s*"([^"]+)"/i) || [])[1];
    if (!id || id === selfId) return null;
    const version = (block.match(/versionRange\s*=\s*"([^"]+)"/i) || [])[1] || '*';
    const type = String((block.match(/\btype\s*=\s*"([^"]+)"/i) || [])[1] || '').toLowerCase();
    const mandatoryRaw = (block.match(/mandatory\s*=\s*(true|false)/i) || [])[1];
    const optional = type === 'optional'
      || type === 'recommended'
      || (mandatoryRaw ? mandatoryRaw.toLowerCase() === 'false' : false);
    return { id, version, optional };
  }).filter(Boolean);
}

function tomlTables(text) {
  const chunks = String(text || '').split(/\n(?=\[\[)/);
  return chunks.map((chunk) => {
    const header = (chunk.match(/^\[\[([^\]]+)\]\]/) || [])[1] || '';
    return { header: String(header).trim(), body: chunk };
  });
}

function modsTableBodies(text) {
  return tomlTables(text)
    .filter((table) => /^mods$/i.test(table.header))
    .map((table) => table.body);
}

function environmentFromModsBody(body) {
  if (/clientSideOnly\s*=\s*true/i.test(body)) return 'client';
  if (/serverSideOnly\s*=\s*true/i.test(body)) return 'server';
  const displayTest = String((body.match(/displayTest\s*=\s*"?([A-Za-z_]+)"?/i) || [])[1] || '').toUpperCase();
  if (displayTest === 'IGNORE_SERVER_VERSION') return 'client';
  const side = String((body.match(/^\s*side\s*=\s*"([^"]+)"/im) || [])[1] || '').toUpperCase();
  if (side === 'CLIENT') return 'client';
  if (side === 'SERVER') return 'server';
  if (side === 'BOTH') return 'both';
  return 'unknown';
}

function neoForgeEnvironment(text) {
  const bodies = modsTableBodies(text);
  if (bodies.length) return aggregateEnvironments(bodies.map(environmentFromModsBody));
  if (/clientSideOnly\s*=\s*true/i.test(text)) return 'client';
  if (/serverSideOnly\s*=\s*true/i.test(text)) return 'server';
  return 'unknown';
}

function detectNeoForge(text) {
  const id = text.match(/modId\s*=\s*"([^"]+)"/i);
  const version = text.match(/version\s*=\s*"([^"]+)"/i);
  const name = text.match(/\n\s*displayName\s*=\s*"([^"]+)"/i);
  const mc = [...text.matchAll(/minecraftVersion\s*=\s*"([^"]+)"/gi)].map((item) => item[1]);
  if (!id) return null;
  const dependencies = parseNeoForgeDependencies(text, id[1]);
  return {
    loader: 'neoforge',
    artifactType: 'mod',
    name: name ? name[1] : id[1],
    version: version ? version[1] : '0.0.0',
    environment: neoForgeEnvironment(text),
    dependencies,
    minecraftVersions: mc,
    license: '',
    metadata: { modId: id[1] },
  };
}

function inspectJar(filePath, { hash = true } = {}) {
  const names = zipGuard.assertSafeZipNames(
    zipGuard.listStoredZipEntries(filePath, { limitEntries: false }),
    { limitEntries: false }
  );
  const fabricName = names.find((name) => name === 'fabric.mod.json' || name.endsWith('/fabric.mod.json'));
  const quiltName = names.find((name) => name === 'quilt.mod.json' || name.endsWith('/quilt.mod.json'));
  const neoName = names.find((name) => name.endsWith('neoforge.mods.toml') || name.endsWith('mods.toml'));
  let detected = null;
  if (fabricName) {
    detected = detectFabric(zipGuard.readNamedText(filePath, fabricName));
  }
  if (!detected && quiltName) {
    detected = detectQuilt(zipGuard.readNamedText(filePath, quiltName));
  }
  if (!detected && neoName) {
    detected = detectNeoForge(zipGuard.readNamedText(filePath, neoName));
  }
  const sha256 = hash
    ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
    : '';
  const fileSize = hash ? fs.statSync(filePath).size : 0;
  return {
    edition: 'java',
    artifactType: detected?.artifactType || 'mod',
    loader: detected?.loader || 'any',
    name: detected?.name || path.parse(filePath).name,
    version: detected?.version || '0.0.0',
    environment: detected?.environment || 'unknown',
    dependencies: detected?.dependencies || [],
    minecraftVersions: detected?.minecraftVersions || [],
    license: detected?.license || '',
    sha256,
    fileSize,
    sourceType: 'upload',
    warning: 'Java mods are executable code. Only install mods you trust.',
    metadata: detected?.metadata || {},
    advisory: true,
  };
}

module.exports = {
  aggregateEnvironments,
  detectFabric,
  detectNeoForge,
  detectQuilt,
  evaluateMinecraftRequirement,
  inspectJar,
  normalizeEnvironment,
  preferJarEnvironment,
};
