const javaLoaderRegistry = require('./javaLoaderRegistry');
const catalogModMeta = require('./catalogModMeta');

function serverLoaderId(server) {
  return String(server?.loader_provider_id || server?.loaderProviderId || 'vanilla');
}

function loaderSupportsMods(loaderId) {
  const entry = javaLoaderRegistry.get(loaderId);
  if (!entry) return false;
  return Boolean(entry.provider.getModSupport?.()?.supportsMods);
}

function compatibleWithServer(mod, server) {
  if (!server || server.kind === 'remote' || server.kind === 'bedrock_connect') return false;
  const javaMod = catalogModMeta.isJavaMod(mod);
  if (server.kind === 'java') {
    if (!javaMod) return false;
    const loaderId = serverLoaderId(server);
    if (!loaderSupportsMods(loaderId)) return false;
    const modLoader = catalogModMeta.normalizeLoader(mod.loader, 'java');
    if (!modLoader || modLoader === 'any' || modLoader === 'unknown') return true;
    if (loaderId === 'neoforge' && (modLoader === 'neoforge' || modLoader === 'forge')) return true;
    return modLoader === loaderId;
  }
  return !javaMod;
}

module.exports = {
  compatibleWithServer,
  loaderSupportsMods,
  serverLoaderId,
};
