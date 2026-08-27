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

export function isEligibleJavaInstallTarget(server, { loaders = [] } = {}) {
  if (!server || server.kind !== 'java') return false;
  if (server.kind === 'remote' || server.kind === 'bedrock_connect') return false;
  if (server.remoteHost || server.remote_host) return false;
  const loaderId = serverLoaderId(server);
  if (loaderId === 'vanilla') return false;
  const meta = loaders.find((item) => item.id === loaderId);
  if (meta?.supportsMods === false) return false;
  return true;
}

export function isClientOnlyOnly(mod) {
  const files = Array.isArray(mod?.files) && mod.files.length ? mod.files : null;
  if (files) return files.every((file) => file.environment === 'client');
  return String(mod?.environment || '').toLowerCase() === 'client';
}

export function candidateInstallFiles(mod) {
  return (Array.isArray(mod?.files) ? mod.files : []).filter((file) => file.environment !== 'client');
}

export function incompatibilityReasonCodes(mod, server) {
  if (!mod || !server) return ['UNKNOWN_METADATA'];
  if (isClientOnlyOnly(mod)) return ['CLIENT_ONLY'];
  const loaderId = serverLoaderId(server);
  const files = candidateInstallFiles(mod);
  const codes = [];
  if (files.length) {
    const versionOk = files.some((file) => supportsMinecraftVersion(
      file.minecraftVersions?.length ? file.minecraftVersions : parseModMinecraftVersions(mod),
      serverMinecraftVersion(server)
    ));
    const loaderOk = files.some((file) => loadersCompatible(file.loader || mod.loader, loaderId, { allowUnknown: false }));
    const known = files.some((file) => {
      const loader = String(file.loader || mod.loader || '').toLowerCase();
      return loader && loader !== 'unknown' && loader !== 'any';
    });
    if (!known || !(parseModMinecraftVersions(mod).length || files.some((file) => (file.minecraftVersions || []).length))) {
      codes.push('UNKNOWN_METADATA');
    }
    if (!versionOk) codes.push('VERSION_MISMATCH');
    if (!loaderOk) codes.push('LOADER_MISMATCH');
    if (!codes.length) codes.push('NO_MATCHING_JAR');
    return [...new Set(codes)];
  }
  if (!parseModMinecraftVersions(mod).length && !modLoaderIds(mod).length) return ['UNKNOWN_METADATA'];
  if (!supportsMinecraftVersion(parseModMinecraftVersions(mod), serverMinecraftVersion(server))) {
    codes.push('VERSION_MISMATCH');
  }
  const ids = modLoaderIds(mod);
  if (!ids.length) codes.push('UNKNOWN_METADATA');
  else if (!ids.some((id) => loadersCompatible(id, loaderId, { allowUnknown: false }))) {
    codes.push('LOADER_MISMATCH');
  }
  return codes.length ? [...new Set(codes)] : ['UNKNOWN_METADATA'];
}

export const COMPAT_REASON_LABELS = {
  VERSION_MISMATCH: 'Minecraft version mismatch',
  LOADER_MISMATCH: 'Loader mismatch',
  UNKNOWN_METADATA: 'Compatibility metadata unavailable',
  NO_MATCHING_JAR: 'No automatically matching JAR',
  CLIENT_ONLY: 'Client-only',
  METADATA_DISAGREEMENT: 'Declared metadata does not match the JAR',
};

export function incompatibilityReasonLabel(codes = []) {
  return codes.map((code) => COMPAT_REASON_LABELS[code] || code).filter(Boolean).join(' · ');
}

export function canOverrideCompatibility(codes = []) {
  const allowed = new Set([
    'VERSION_MISMATCH',
    'LOADER_MISMATCH',
    'UNKNOWN_METADATA',
    'NO_MATCHING_JAR',
    'METADATA_DISAGREEMENT',
  ]);
  if (!codes.length) return false;
  if (codes.includes('CLIENT_ONLY')) return false;
  return codes.every((code) => allowed.has(code));
}

export function needsJarSelection(mod, server, { loaders = [] } = {}) {
  if (isModCompatibleWithServer(mod, server, { loaders })) return false;
  return candidateInstallFiles(mod).length > 1;
}
