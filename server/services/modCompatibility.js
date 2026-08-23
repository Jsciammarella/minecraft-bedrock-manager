const javaLoaderRegistry = require('./javaLoaderRegistry');
const catalogModMeta = require('./catalogModMeta');
const minecraftVersions = require('./minecraftVersions');

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
    const versionOk = minecraftVersions.supportsMinecraftVersion(
      minecraftVersions.modMinecraftVersions(mod),
      minecraftVersions.serverMinecraftVersion(server)
    );
    if (!modLoader || modLoader === 'any' || modLoader === 'unknown') return versionOk;
    if (loaderId === 'neoforge' && (modLoader === 'neoforge' || modLoader === 'forge')) return versionOk;
    if (modLoader !== loaderId) return false;
    return versionOk;
  }
  return !javaMod;
}

module.exports = {
  compatibleWithServer,
  loaderSupportsMods,
  serverLoaderId,
};
