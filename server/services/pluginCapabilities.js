const UI_CAPABILITIES = new Set([
  'ui:pages',
]);

const CATALOG_CAPABILITIES = new Set([
  'catalog:metadata',
  'download:catalog-sources',
]);

const PRIVILEGED_CAPABILITIES = new Set([
  'provider:java-loader',
  'provider:gateway',
  'provider:catalog-source',
  'download:official-sources',
  'filesystem:server-java',
  'filesystem:server-mods',
  'filesystem:plugin-data',
  'runtime:java',
  'network:outbound-target',
  'ports:udp',
  'ports:tcp',
]);

const KNOWN_CAPABILITIES = new Set([
  ...UI_CAPABILITIES,
  ...CATALOG_CAPABILITIES,
  ...PRIVILEGED_CAPABILITIES,
]);

function isPrivilegedCapability(value) {
  return PRIVILEGED_CAPABILITIES.has(String(value || ''));
}

function parseCapabilities(rawCapabilities, source) {
  const requested = Array.isArray(rawCapabilities)
    ? rawCapabilities.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const unknown = requested.filter((item) => !KNOWN_CAPABILITIES.has(item));
  if (unknown.length) {
    return { ok: false, error: `unknown capability "${unknown[0]}"` };
  }
  const privileged = requested.filter(isPrivilegedCapability);
  if (source !== 'bundled' && privileged.length) {
    return {
      ok: true,
      capabilities: requested.filter((item) => !isPrivilegedCapability(item)),
      rejectedPrivileged: privileged,
    };
  }
  return { ok: true, capabilities: requested, rejectedPrivileged: [] };
}

function trustLevelFor(source, capabilities = [], { backendDeclared = false, backendEnabled = false } = {}) {
  if (source === 'bundled') return 'system-provider';
  if ((capabilities || []).some((item) => CATALOG_CAPABILITIES.has(item)) && !backendEnabled) {
    return 'catalog';
  }
  if (backendDeclared && backendEnabled) return 'user-backend';
  return 'ui';
}

function sourceFromDir(dir, bundledDir, userDir) {
  const path = require('path');
  const resolved = path.resolve(dir);
  if (resolved === path.resolve(bundledDir)) return 'bundled';
  if (resolved === path.resolve(userDir)) return 'user';
  return 'external';
}

module.exports = {
  CATALOG_CAPABILITIES,
  KNOWN_CAPABILITIES,
  PRIVILEGED_CAPABILITIES,
  UI_CAPABILITIES,
  isPrivilegedCapability,
  parseCapabilities,
  sourceFromDir,
  trustLevelFor,
};
