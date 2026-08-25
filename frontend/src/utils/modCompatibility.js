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

export function missingModDependenciesOf(server) {
  return server?.missingModDependencies || server?.stats?.missingModDependencies || null;
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

export function loadersCompatible(modLoader, serverLoader, { allowUnknown = true } = {}) {
  const mod = String(modLoader || 'any').toLowerCase();
  const server = String(serverLoader || '').toLowerCase();
  if (!server || server === 'vanilla' || server === 'any') return false;
  if (!mod || mod === 'any' || mod === 'unknown') return allowUnknown;
  if (server === 'neoforge' && (mod === 'neoforge' || mod === 'forge')) return true;
  return mod === server;
}

export function modLoaderIds(mod) {
  const fromFiles = (mod?.files || []).map((file) => file.loader);
  const listed = Array.isArray(mod?.loaders) ? mod.loaders : [];
  return [...new Set([...listed, ...fromFiles, mod?.loader]
    .map((item) => String(item || '').toLowerCase())
    .filter((item) => item && item !== 'any' && item !== 'unknown'))];
}

export function modVersionTags(mod) {
  const fromFiles = (mod?.files || []).flatMap((file) => parseModMinecraftVersions(file));
  return [...new Set([...parseModMinecraftVersions(mod), ...fromFiles])];
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
    const files = Array.isArray(mod.files) && mod.files.length ? mod.files : null;
    if (files) {
      return files.some((file) => {
        if (file.environment === 'client') return false;
        const versionOk = supportsMinecraftVersion(
          file.minecraftVersions?.length ? file.minecraftVersions : parseModMinecraftVersions(mod),
          serverMinecraftVersion(server)
        );
        if (!versionOk) return false;
        return loadersCompatible(file.loader || mod.loader, loaderId, { allowUnknown: true });
      });
    }
    const versionOk = supportsMinecraftVersion(parseModMinecraftVersions(mod), serverMinecraftVersion(server));
    if (!versionOk) return false;
    const ids = modLoaderIds(mod);
    if (!ids.length) {
      return meta ? meta.supportsMods !== false : loaderId !== 'vanilla';
    }
    return ids.some((id) => loadersCompatible(id, loaderId, { allowUnknown: false }));
  }
  return !javaMod;
}
