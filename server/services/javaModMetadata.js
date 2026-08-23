const path = require('path');
const crypto = require('crypto');
const zipGuard = require('./zipGuard');

function parseDepends(raw, optional = false) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).map(([id, version]) => ({
    id,
    version: typeof version === 'string' ? version : String(version?.value || version || '*'),
    optional: Boolean(optional),
  }));
}

function minecraftFromConstraint(value) {
  return String(value || '').match(/\d+\.\d+(?:\.\d+)?/g) || [];
}

function detectFabric(text) {
  try {
    const json = JSON.parse(text);
    const env = json.environment === 'client' || json.environment === 'server' ? json.environment : (json.environment === '*' ? 'both' : 'unknown');
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

function detectNeoForge(text) {
  const id = text.match(/modId\s*=\s*"([^"]+)"/i);
  const version = text.match(/version\s*=\s*"([^"]+)"/i);
  const name = text.match(/\n\s*displayName\s*=\s*"([^"]+)"/i);
  const side = /clientSideOnly\s*=\s*true/i.test(text) ? 'client' : /serverSideOnly\s*=\s*true/i.test(text) ? 'server' : 'unknown';
  const mc = [...text.matchAll(/minecraftVersion\s*=\s*"([^"]+)"/gi)].map((item) => item[1]);
  if (!id) return null;
  const dependencies = parseNeoForgeDependencies(text, id[1]);
  return {
    loader: 'neoforge',
    artifactType: 'mod',
    name: name ? name[1] : id[1],
    version: version ? version[1] : '0.0.0',
    environment: side,
    dependencies,
    minecraftVersions: mc,
    license: '',
    metadata: { modId: id[1] },
  };
}

function inspectJar(filePath) {
  const names = zipGuard.assertSafeZipNames(zipGuard.listStoredZipEntries(filePath));
  const fabricName = names.find((name) => name === 'fabric.mod.json' || name.endsWith('/fabric.mod.json'));
  const neoName = names.find((name) => name.endsWith('neoforge.mods.toml') || name.endsWith('mods.toml'));
  let detected = null;
  if (fabricName) {
    detected = detectFabric(zipGuard.readNamedText(filePath, fabricName));
  }
  if (!detected && neoName) {
    detected = detectNeoForge(zipGuard.readNamedText(filePath, neoName));
  }
  const sha256 = crypto.createHash('sha256').update(require('fs').readFileSync(filePath)).digest('hex');
  const fileSize = require('fs').statSync(filePath).size;
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
  detectFabric,
  detectNeoForge,
  inspectJar,
};
