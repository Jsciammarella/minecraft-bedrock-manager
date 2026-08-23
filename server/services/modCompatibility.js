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

function loadersCompatible(modLoader, serverLoader, { allowUnknown = true } = {}) {
  const mod = catalogModMeta.normalizeLoader(modLoader, 'java');
  const server = catalogModMeta.normalizeLoader(serverLoader, 'java');
  if (!server || server === 'vanilla' || server === 'any') return false;
  if (!mod || mod === 'any' || mod === 'unknown') return allowUnknown;
  if (server === 'neoforge' && (mod === 'neoforge' || mod === 'forge')) return true;
  return mod === server;
}

function compatibleWithServer(mod, server) {
  if (!server || server.kind === 'remote' || server.kind === 'bedrock_connect') return false;
  const javaMod = catalogModMeta.isJavaMod(mod);
  if (server.kind === 'java') {
    if (!javaMod) return false;
    const loaderId = serverLoaderId(server);
    if (!loaderSupportsMods(loaderId)) return false;
    const versionOk = minecraftVersions.supportsMinecraftVersion(
      minecraftVersions.modMinecraftVersions(mod),
      minecraftVersions.serverMinecraftVersion(server)
    );
    if (!versionOk) return false;
    return loadersCompatible(mod.loader, loaderId);
  }
  return !javaMod;
}

module.exports = {
  compatibleWithServer,
  loadersCompatible,
  loaderSupportsMods,
  serverLoaderId,
};
