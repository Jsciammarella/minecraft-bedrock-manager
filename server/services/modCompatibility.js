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

function fileCompatibleWithServer(file, server, { allowUnknown = false } = {}) {
  if (!file || !server) return false;
  if (file.environment === 'client') return false;
  if (!minecraftVersions.supportsMinecraftVersion(
    file.minecraftVersions || [],
    minecraftVersions.serverMinecraftVersion(server)
  )) {
    return false;
  }
  return loadersCompatible(file.loader, serverLoaderId(server), { allowUnknown });
}

function filesFromMod(mod) {
  if (!mod) return [];
  const extras = require('./modArchives').parseExtraFiles(mod.extra_files);
  const primaryVersions = minecraftVersions.modMinecraftVersions(mod);
  const files = [];
  if (mod.file_path || extras.length) {
    files.push({
      loader: mod.loader,
      minecraftVersions: primaryVersions,
      environment: mod.environment,
    });
  }
  for (const extra of extras) {
    files.push({
      loader: extra.loader || mod.loader,
      minecraftVersions: Array.isArray(extra.minecraftVersions) && extra.minecraftVersions.length
        ? extra.minecraftVersions
        : primaryVersions,
      environment: extra.environment || mod.environment,
    });
  }
  return files;
}

function compatibleWithServer(mod, server) {
  if (!server || server.kind === 'remote' || server.kind === 'bedrock_connect') return false;
  const javaMod = catalogModMeta.isJavaMod(mod);
  if (server.kind === 'java') {
    if (!javaMod) return false;
    const loaderId = serverLoaderId(server);
    if (!loaderSupportsMods(loaderId)) return false;
    const files = filesFromMod(mod);
    if (files.length) {
      return files.some((file) => fileCompatibleWithServer(file, server));
    }
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
  fileCompatibleWithServer,
  filesFromMod,
  loadersCompatible,
  loaderSupportsMods,
  serverLoaderId,
};
