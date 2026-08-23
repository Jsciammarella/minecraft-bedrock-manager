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

export function parseModMinecraftVersions(mod) {
  const raw = mod?.minecraftVersions ?? mod?.minecraft_versions;
  if (Array.isArray(raw)) return raw.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    } catch {
      return raw.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

export function serverMinecraftVersion(server) {
  return String(server?.minecraftVersion || server?.minecraft_version || server?.version || '').trim();
}

function listedSupportsServer(listed, serverVersion) {
  const a = String(listed || '').trim();
  const b = String(serverVersion || '').trim();
  if (!a || a.toLowerCase() === 'any' || a === '*') return true;
  if (a === b) return true;
  const ta = a.split('.').filter(Boolean);
  const tb = b.split('.').filter(Boolean);
  if (ta.length === 2 && tb.length >= 2 && ta[0] === tb[0] && ta[1] === tb[1]) return true;
  return false;
}

export function supportsMinecraftVersion(versions, serverVersion) {
  const wanted = String(serverVersion || '').trim();
  if (!wanted) return true;
  const list = Array.isArray(versions) ? versions : parseModMinecraftVersions({ minecraftVersions: versions });
  if (!list.length) return true;
  return list.some((item) => listedSupportsServer(item, wanted));
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
    const versionOk = supportsMinecraftVersion(parseModMinecraftVersions(mod), serverMinecraftVersion(server));
    if (!modLoader || modLoader === 'any' || modLoader === 'unknown') {
      if (!(meta ? meta.supportsMods !== false : loaderId !== 'vanilla')) return false;
      return versionOk;
    }
    if (loaderId === 'neoforge' && (modLoader === 'neoforge' || modLoader === 'forge')) return versionOk;
    return modLoader === loaderId && versionOk;
  }
  return !javaMod;
}
