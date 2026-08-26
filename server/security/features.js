const CORE_FEATURES = new Set([
  'coreManagement',
  'plugins',
  'javaHosting',
  'catalogProviders',
  'gateways',
  'bedrockConnect',
  'websocketConsole',
]);

const RBAC_FEATURES = new Set([
  'userManagement',
  'roleManagement',
  'authentication',
  'sessions',
  'passwordManagement',
]);

function supportsCore(feature) {
  return CORE_FEATURES.has(String(feature || ''));
}

function supportsRbac(feature) {
  return RBAC_FEATURES.has(String(feature || ''));
}

module.exports = {
  CORE_FEATURES,
  RBAC_FEATURES,
  supportsCore,
  supportsRbac,
};
