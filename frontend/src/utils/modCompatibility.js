export function isJavaLibraryMod(mod) {
  const edition = String(mod?.edition || '').toLowerCase();
  const loader = String(mod?.loader || '').toLowerCase();
  return edition === 'java' || ['fabric', 'neoforge', 'forge', 'vanilla'].includes(loader);
}

export function loaderDisplayName(id) {
  const key = String(id || '').toLowerCase();
  if (key === 'neoforge') return 'NeoForge';
  if (key === 'fabric') return 'Fabric';
  if (key === 'vanilla') return 'Vanilla';
  if (key === 'forge') return 'Forge';
  if (!key || key === 'any' || key === 'unknown') return '';
  return String(id);
}

export function serverLoaderId(server) {
  return server?.loaderProviderId || server?.loader_provider_id || 'vanilla';
}

export function isModCompatibleWithServer(mod, server, { loaders = [] } = {}) {
  if (!server || server.kind === 'remote' || server.kind === 'bedrock_connect') return false;
  const javaMod = isJavaLibraryMod(mod);
  if (server.kind === 'java') {
    if (!javaMod) return false;
    const loaderId = serverLoaderId(server);
    const meta = loaders.find((item) => item.id === loaderId);
    if (meta?.supportsMods === false) return false;
    if (!loaders.length && loaderId === 'vanilla') return false;
    const modLoader = String(mod.loader || 'any').toLowerCase();
    if (!modLoader || modLoader === 'any' || modLoader === 'unknown') {
      return meta ? meta.supportsMods !== false : loaderId !== 'vanilla';
    }
    if (loaderId === 'neoforge' && (modLoader === 'neoforge' || modLoader === 'forge')) return true;
    return modLoader === loaderId;
  }
  return !javaMod;
}
