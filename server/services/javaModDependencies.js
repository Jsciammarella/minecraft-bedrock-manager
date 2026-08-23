const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const logger = require('./logger');
const pluginAudit = require('./pluginAudit');
const javaModMetadata = require('./javaModMetadata');
const javaModInstall = require('./javaModInstall');
const minecraftVersions = require('./minecraftVersions');
const catalogModMeta = require('./catalogModMeta');
const modCompatibility = require('./modCompatibility');

const BUILTIN = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric-loader', 'fabric',
  'neoforge', 'forge', 'fml', 'mcp', 'quilt_loader',
]);
const FABRIC_ONLY = new Set([
  'fabric-api', 'fabric', 'fabricloader', 'fabric-loader', 'fabric-language-kotlin', 'quilted_fabric_api',
]);

function parseJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function emptyState() {
  return {
    required: [],
    optional: [],
    catalogAvailable: true,
    message: '',
    unresolved: [],
  };
}

function readStored(server) {
  const parsed = parseJson(server?.missing_mod_dependencies, null);
  if (!parsed || typeof parsed !== 'object') return emptyState();
  return {
    required: Array.isArray(parsed.required) ? parsed.required : [],
    optional: Array.isArray(parsed.optional) ? parsed.optional : [],
    catalogAvailable: parsed.catalogAvailable !== false,
    message: parsed.message || '',
    unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved : [],
  };
}

function publicState(server) {
  const stored = readStored(server);
  if (!stored.required.length && !stored.optional.length) return null;
  return stored;
}

function save(serverId, state) {
  const payload = state && (state.required?.length || state.optional?.length)
    ? JSON.stringify({
      required: state.required || [],
      optional: state.optional || [],
      catalogAvailable: state.catalogAvailable !== false,
      message: state.message || '',
      unresolved: state.unresolved || [],
    })
    : null;
  db.prepare('UPDATE servers SET missing_mod_dependencies = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(payload, serverId);
}

function clear(serverId) {
  save(serverId, null);
}

function depKey(dep) {
  return String(dep?.id || '').trim().toLowerCase();
}

function isBuiltin(id) {
  return BUILTIN.has(String(id || '').toLowerCase());
}

function isForeignForLoader(id, serverLoader) {
  const key = String(id || '').toLowerCase();
  if (isBuiltin(key)) return true;
  const loader = catalogModMeta.normalizeLoader(serverLoader, 'java');
  if ((loader === 'neoforge' || loader === 'forge') && FABRIC_ONLY.has(key)) return true;
  return false;
}

function jarIdentityKeys(info, fileName) {
  const meta = info?.metadata || {};
  const keys = [];
  for (const value of [meta.modId, meta.id, info?.name, path.parse(fileName || '').name]) {
    const key = String(value || '').trim().toLowerCase();
    if (key) keys.push(key);
  }
  return keys;
}

function mergeDeps(list, extra, optional) {
  const byId = new Map(list.map((item) => [depKey(item), item]));
  for (const item of extra || []) {
    const id = depKey(item);
    if (!id || isBuiltin(id)) continue;
    const current = byId.get(id);
    const next = {
      id: String(item.id).trim(),
      version: item.version || current?.version || '*',
      optional: optional || Boolean(item.optional),
      displayName: item.displayName || item.id,
    };
    if (current) {
      current.version = current.version && current.version !== '*' ? current.version : next.version;
      current.optional = current.optional && next.optional;
      current.displayName = current.displayName || next.displayName;
    } else {
      byId.set(id, next);
    }
  }
  return [...byId.values()];
}

function parseVersionRange(raw) {
  const text = String(raw || '').trim();
  if (!text) return '*';
  const bracket = text.match(/^\[([^,\]]+)/);
  if (bracket) return bracket[1].trim() || '*';
  return text.replace(/\s+or above/i, '').trim() || '*';
}

function parseLoaderCrash(text) {
  const required = [];
  const blob = String(text || '');
  let match;
  const sorter = /Mod ID:\s*'([^']+)'\s*,\s*Requested by:\s*'([^']+)'\s*,\s*Expected range:\s*'([^']*)'\s*,\s*Actual version:\s*'\[MISSING\]'/gi;
  while ((match = sorter.exec(blob))) {
    required.push({
      id: match[1],
      version: parseVersionRange(match[3]),
      optional: false,
      displayName: match[1],
    });
  }
  const neo = /Mod\s+(\S+)\s+requires\s+(\S+)\s+([^\n]+)/gi;
  while ((match = neo.exec(blob))) {
    const requestedBy = String(match[1] || '').replace(/:$/, '');
    if (/^(id|loading|list|file)$/i.test(requestedBy)) continue;
    required.push({
      id: match[2],
      version: parseVersionRange(match[3]),
      optional: false,
      displayName: match[2],
    });
  }
  const missingLine = /Currently,\s+(\S+)\s+is not installed/gi;
  while ((match = missingLine.exec(blob))) {
    required.push({ id: match[1], version: '*', optional: false, displayName: match[1] });
  }
  const fabric = /(?:Mod ['"]?[\w.-]+['"]?|[Mm]od resolution failed)[\s\S]{0,200}?requires(?: version ([^,]+?) of )?['"]?([a-z0-9_-]+)['"]?/gi;
  while ((match = fabric.exec(blob))) {
    required.push({
      id: match[2],
      version: (match[1] || '*').trim(),
      optional: false,
      displayName: match[2],
    });
  }
  const fabricMissing = /version [^\n]+ of ([a-z0-9_-]+), which is missing/gi;
  while ((match = fabricMissing.exec(blob))) {
    required.push({ id: match[1], version: '*', optional: false, displayName: match[1] });
  }
  return mergeDeps([], required, false);
}

function parseWrongLoaderSkips(text) {
  const skipped = [];
  const re = /(?:Skipping jar\. File |File )(.+?\.jar) is a (Fabric|Forge|NeoForge|Quilt) mod and cannot be loaded/gi;
  let match;
  while ((match = re.exec(String(text || '')))) {
    skipped.push({
      filePath: match[1].trim(),
      loader: String(match[2] || '').toLowerCase(),
    });
  }
  return skipped;
}

function readNamedLogs(dataPath, names) {
  let out = '';
  for (const rel of names) {
    const filePath = path.join(dataPath, rel);
    try {
      if (fs.existsSync(filePath)) out += `\n${fs.readFileSync(filePath, 'utf8').slice(-128000)}`;
    } catch {
      /* ignore unreadable logs */
    }
  }
  return out;
}

function readLogFiles(dataPath) {
  return readNamedLogs(dataPath, ['logs/latest.log', 'logs/debug.log']);
}

function readCrashReports(dataPath, sinceMs = 0) {
  const dir = path.join(dataPath, 'crash-reports');
  try {
    if (!fs.existsSync(dir)) return '';
    const files = fs.readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.txt'))
      .map((name) => {
        const filePath = path.join(dir, name);
        return { filePath, name, mtime: fs.statSync(filePath).mtimeMs };
      })
      .filter((file) => !sinceMs || file.mtime >= sinceMs - 15000)
      .sort((a, b) => {
        const aFml = /fml/i.test(a.name) ? 0 : 1;
        const bFml = /fml/i.test(b.name) ? 0 : 1;
        if (aFml !== bFml) return aFml - bFml;
        return b.mtime - a.mtime;
      })
      .slice(0, 3);
    let out = '';
    for (const file of files) {
      out += `\n${fs.readFileSync(file.filePath, 'utf8').slice(-128000)}`;
    }
    return out;
  } catch {
    return '';
  }
}

function installedIdentities(server) {
  const ids = new Set();
  const serverLoader = server.loader_provider_id;
  for (const item of javaModInstall.list(server.id)) {
    const mod = item.mod || {};
    if (!modCompatibility.loadersCompatible(mod.loader, serverLoader, { allowUnknown: false })) continue;
    const meta = parseJson(mod.metadata_json, mod.metadata || {});
    for (const value of [mod.name, meta.modId, meta.id, path.parse(mod.filePath || '').name]) {
      const key = String(value || '').trim().toLowerCase();
      if (key) ids.add(key);
    }
  }
  const modsDir = path.join(server.data_path, 'mods');
  try {
    for (const name of fs.readdirSync(modsDir)) {
      if (!name.toLowerCase().endsWith('.jar')) continue;
      try {
        const info = javaModMetadata.inspectJar(path.join(modsDir, name));
        if (!modCompatibility.loadersCompatible(info.loader, serverLoader, { allowUnknown: false })) continue;
        for (const key of jarIdentityKeys(info, name)) ids.add(key);
      } catch {
        /* unreadable jars do not satisfy a dependency */
      }
    }
  } catch {
    /* mods dir may not exist yet */
  }
  return ids;
}

function manifestDependencies(server) {
  const deps = [];
  const serverLoader = server.loader_provider_id;
  const modsDir = path.join(server.data_path, 'mods');
  try {
    for (const name of fs.readdirSync(modsDir)) {
      if (!name.toLowerCase().endsWith('.jar') || name.toLowerCase().endsWith('.pending')) continue;
      try {
        const info = javaModMetadata.inspectJar(path.join(modsDir, name));
        if (!modCompatibility.loadersCompatible(info.loader, serverLoader, { allowUnknown: false })) continue;
        deps.push(...(info.dependencies || []));
      } catch {
        /* skip unreadable jars */
      }
    }
  } catch {
    /* ignore */
  }
  for (const item of javaModInstall.list(server.id)) {
    const mod = item.mod || {};
    if (!modCompatibility.loadersCompatible(mod.loader, serverLoader, { allowUnknown: false })) continue;
    deps.push(...(mod.dependencies || []));
  }
  return deps;
}

function looksLikeDependencyFailure(text) {
  return /ModLoadingException|ModLoadingCrashException|is not installed|which is missing|Mod resolution failed|Missing or unsupported mandatory dependencies|Actual version:\s*'\[MISSING\]'|Mod loading has failed|pre-loading phase|Failure message:|Loading errors encountered|Mod\s+\S+\s+requires\s+\S+|cannot be loaded|Skipping jar/i.test(String(text || ''));
}

function looksLikeStarted(text) {
  return /Done \(|For help, type "help"|Loading Minecraft .*Done/i.test(String(text || ''));
}

function detectFromText(server, text, options = {}) {
  if (!server || server.kind !== 'java') return null;
  const loader = String(server.loader_provider_id || 'vanilla');
  if (loader === 'vanilla') return null;
  const fromLog = parseLoaderCrash(text);
  const extraRequired = [...(options.extraRequired || [])];
  for (const skipped of parseWrongLoaderSkips(text)) {
    try {
      if (!skipped.filePath || !fs.existsSync(skipped.filePath)) continue;
      const info = javaModMetadata.inspectJar(skipped.filePath);
      const id = info.metadata?.modId || info.metadata?.id || path.parse(skipped.filePath).name;
      extraRequired.push({ id, version: '*', optional: false, displayName: id });
    } catch {
      extraRequired.push({
        id: path.parse(skipped.filePath).name,
        version: '*',
        optional: false,
        displayName: path.parse(skipped.filePath).name,
      });
    }
  }
  const installed = installedIdentities(server);
  let missingRequired = mergeDeps([], fromLog, false);
  missingRequired = mergeDeps(missingRequired, extraRequired, false)
    .filter((dep) => !installed.has(depKey(dep)) && !isForeignForLoader(dep.id, loader));
  const fromManifest = manifestDependencies(server);
  if (options.includeManifestRequired) {
    const manifestRequired = fromManifest
      .filter((dep) => !dep.optional && !isForeignForLoader(dep.id, loader) && !installed.has(depKey(dep)))
      .map((dep) => ({
        id: dep.id,
        version: dep.version || '*',
        optional: false,
        displayName: dep.id,
      }));
    missingRequired = mergeDeps(missingRequired, manifestRequired, false);
  }
  const missingOptional = fromManifest
    .filter((dep) => dep.optional && !isForeignForLoader(dep.id, loader) && !installed.has(depKey(dep)))
    .map((dep) => ({
      id: dep.id,
      version: dep.version || '*',
      optional: true,
      displayName: dep.id,
    }));
  const required = mergeDeps([], missingRequired, false);
  const optional = mergeDeps([], missingOptional, true)
    .filter((dep) => !required.some((item) => depKey(item) === depKey(dep)));
  if (!required.length && !optional.length) return null;
  const skippedWrongLoader = parseWrongLoaderSkips(text).length > 0;
  return {
    required,
    optional,
    catalogAvailable: true,
    message: required.length
      ? (skippedWrongLoader
        ? `A dependency jar is for a different loader. Resolve to install the ${loader} build that matches this server.`
        : 'There are missing dependencies.')
      : '',
    unresolved: [],
  };
}

function recordFromCrash(server, consoleText = '', options = {}) {
  try {
    const text = `${consoleText || ''}\n${readLogFiles(server.data_path)}\n${readCrashReports(server.data_path, options.sinceMs || 0)}`;
    const detected = detectFromText(server, text, options);
    if (!detected || !detected.required.length) return readStored(server);
    const previous = readStored(server);
    const previousIds = previous.required.map(depKey).sort().join(',');
    const nextIds = detected.required.map(depKey).sort().join(',');
    if (previousIds === nextIds && previous.required.length) return previous;
    save(server.id, detected);
    logger.info(`Java server ${server.id} is missing mods: ${detected.required.map((item) => item.id).join(', ')}`);
    pluginAudit.record('java.mod.dependencies.detected', {
      targetType: 'server',
      targetId: String(server.id),
      detail: { required: detected.required.map((item) => item.id) },
    });
    return detected;
  } catch (err) {
    logger.warn(`Java dependency detection failed for server ${server?.id}: ${err.message}`);
    return readStored(server);
  }
}

function maybeClearOnReady(server, text) {
  if (!server || server.kind !== 'java') return;
  if (!looksLikeStarted(text)) return;
  const stored = readStored(server);
  if (!stored.required.length && !stored.optional.length) return;
  clear(server.id);
}

function fileMatchesServer(file, server, { allowUnknown = false } = {}) {
  if (file.environment === 'client') return false;
  if (!minecraftVersions.supportsMinecraftVersion(file.minecraftVersions || [], server.minecraft_version)) {
    return false;
  }
  const loader = String(server.loader_provider_id || '').toLowerCase();
  const name = String(file.fileName || file.name || '').toLowerCase();
  if (loader !== 'fabric' && name.includes('fabric')) return false;
  if (loader === 'fabric' && name.includes('neoforge')) return false;
  return modCompatibility.loadersCompatible(file.loader, loader, { allowUnknown });
}

function scoreFile(file, server) {
  let score = 0;
  const name = String(file.fileName || file.name || '').toLowerCase();
  const loader = String(server.loader_provider_id || '').toLowerCase();
  if (fileMatchesServer(file, server)) score += 100;
  if (loader && name.includes(loader)) score += 25;
  if (loader === 'neoforge' && /forge/.test(name) && !name.includes('fabric')) score += 10;
  if (loader !== 'fabric' && name.includes('fabric')) score -= 60;
  if (loader !== 'neoforge' && loader !== 'forge' && name.includes('neoforge')) score -= 40;
  return score;
}

function scoreProject(project, dep, server) {
  const id = depKey(dep);
  const slug = String(project.slug || '').toLowerCase();
  const name = String(project.name || '').toLowerCase();
  const loader = String(server?.loader_provider_id || '').toLowerCase();
  let score = 10;
  if (slug === id || name === id) score = 100;
  else if (slug.replace(/-/g, '') === id.replace(/-/g, '')) score = 90;
  else if (slug.includes(id) || name.includes(id)) score = 80;
  if (loader && `${slug} ${name}`.includes(loader)) score += 25;
  if (loader === 'neoforge' && `${slug} ${name}`.includes('fabric') && !`${slug} ${name}`.includes('neoforge')) {
    score -= 40;
  }
  return score;
}

async function catalogIsReachable() {
  try {
    const catalogService = require('./catalogService');
    const listed = catalogService.listProviders();
    const sources = listed.sources || {};
    return Boolean(sources['curseforge-java']?.available || sources.git?.available || sources.file?.available);
  } catch {
    return false;
  }
}

function libraryCandidates(dep) {
  const id = depKey(dep);
  const rows = db.prepare('SELECT * FROM mods WHERE edition = ?').all('java');
  return rows.filter((row) => {
    const meta = parseJson(row.metadata_json, {});
    const names = [row.name, row.slug, meta.modId, meta.id].map((item) => String(item || '').toLowerCase());
    return names.includes(id) || names.some((name) => name.includes(id));
  });
}

function libraryMatch(dep, server) {
  const javaModFiles = require('./javaModFiles');
  for (const row of libraryCandidates(dep)) {
    const file = javaModFiles.bestFileForServer(row, server);
    if (file) return { mod: row, file };
  }
  return null;
}

function libraryMismatch(dep) {
  const javaModFiles = require('./javaModFiles');
  const candidates = libraryCandidates(dep);
  if (!candidates.length) return null;
  const mod = candidates[0];
  return {
    mod,
    files: javaModFiles.listFiles(mod).filter((file) => file.environment !== 'client'),
  };
}

function publicMismatchFile(file) {
  return {
    name: file.name || file.fileName,
    sha256: file.sha256 || '',
    loader: file.loader || 'unknown',
    minecraftVersions: file.minecraftVersions || [],
    environment: file.environment || 'unknown',
    id: file.id || file.fileId || file.sha256 || file.name,
    fileId: file.fileId || file.id,
  };
}

function removeIncompatibleJars(server, dep) {
  const wanted = depKey(dep);
  if (!wanted) return;
  const modsDir = path.join(server.data_path, 'mods');
  try {
    for (const name of fs.readdirSync(modsDir)) {
      if (!name.toLowerCase().endsWith('.jar')) continue;
      const filePath = path.join(modsDir, name);
      try {
        const info = javaModMetadata.inspectJar(filePath);
        const keys = jarIdentityKeys(info, name);
        if (!keys.includes(wanted)) continue;
        if (modCompatibility.loadersCompatible(info.loader, server.loader_provider_id, { allowUnknown: false })) {
          continue;
        }
        fs.unlinkSync(filePath);
        logger.info(`Removed ${name} from server ${server.id}; it is not built for ${server.loader_provider_id}`);
      } catch {
        /* skip unreadable jars */
      }
    }
  } catch {
    /* mods dir may not exist */
  }
  for (const item of javaModInstall.list(server.id)) {
    const mod = item.mod || {};
    const meta = parseJson(mod.metadata_json, mod.metadata || {});
    const names = [mod.name, meta.modId, meta.id, path.parse(mod.filePath || '').name]
      .map((value) => String(value || '').toLowerCase());
    if (!names.includes(wanted)) continue;
    let loader = mod.loader;
    try {
      if (mod.filePath && fs.existsSync(mod.filePath)) {
        const info = javaModMetadata.inspectJar(mod.filePath);
        if (info.loader && info.loader !== 'any' && info.loader !== 'unknown') loader = info.loader;
      }
    } catch {
      /* keep declared loader */
    }
    const dest = path.join(modsDir, javaModInstall.destName({ file_path: mod.filePath }, { installed_file: item.installedFile }));
    const destMissing = Boolean(mod.filePath) && !fs.existsSync(dest);
    if (!destMissing && modCompatibility.loadersCompatible(loader, server.loader_provider_id, { allowUnknown: false })) {
      continue;
    }
    try { javaModInstall.remove(server, item.id); } catch { /* already gone */ }
  }
}

async function searchCatalog(dep, server, { loader } = {}) {
  const catalogService = require('./catalogService');
  const query = String(dep.id || '').replace(/[-_]/g, ' ');
  const result = await catalogService.searchMods(query, {
    edition: 'java',
    pageSize: 15,
    page: 1,
    sortBy: 'relevancy',
    loader: loader || undefined,
    gameVersions: [{ version: server.minecraft_version, edition: 'java' }],
  });
  return [...(result.results || [])].sort((a, b) => scoreProject(b, dep, server) - scoreProject(a, dep, server));
}

async function installCatalogFile(server, project, file, { override = false } = {}) {
  const catalogService = require('./catalogService');
  const loader = catalogModMeta.normalizeLoader(file.loader || server.loader_provider_id, 'java');
  const downloaded = await catalogService.downloadMod(project.slug || String(project.id), {
    provider: project.providerId,
    source: project.source,
    edition: 'java',
    curseforgeId: project.curseforgeId || project.id,
    files: [String(file.id || file.fileId)],
    loader,
  });
  if (!downloaded?.modId) return { status: 'missing', error: 'Catalog download did not return a library mod' };
  const row = db.prepare('SELECT * FROM mods WHERE id = ?').get(downloaded.modId);
  const javaModFiles = require('./javaModFiles');
  const chosen = javaModFiles.bestFileForServer(row, server, {
    sha256: file.sha256,
    allowMismatch: override,
  });
  const check = javaModInstall.validate(server, row, { file: chosen, override });
  if (!check.ok) return { status: 'missing', error: check.error, modId: downloaded.modId };
  const already = db.prepare('SELECT id FROM server_mods WHERE server_id = ? AND mod_id = ?')
    .get(server.id, downloaded.modId);
  if (!already) javaModInstall.install(server, downloaded.modId, { fileSha256: chosen?.sha256, override });
  return { status: 'installed', name: downloaded.name, modId: downloaded.modId };
}

async function resolveOne(server, dep, overrides = {}) {
  removeIncompatibleJars(server, dep);
  const override = overrides[depKey(dep)] || null;
  if (override?.modId && (override.sha256 || override.name || override.allowMismatch)) {
    const row = db.prepare('SELECT * FROM mods WHERE id = ?').get(override.modId);
    if (row) {
      const already = db.prepare('SELECT id FROM server_mods WHERE server_id = ? AND mod_id = ?')
        .get(server.id, row.id);
      if (!already) {
        javaModInstall.install(server, row.id, { fileSha256: override.sha256 || override.name, override: true });
      }
      return { id: dep.id, status: 'installed', name: row.name, override: true };
    }
  }
  if (override?.source === 'catalog' && override.project && (override.fileId || override.id)) {
    const installed = await installCatalogFile(server, override.project, {
      id: override.fileId || override.id,
      fileId: override.fileId || override.id,
      loader: override.loader,
      sha256: override.sha256,
    }, { override: true });
    if (installed.status === 'installed') return { id: dep.id, ...installed, override: true };
  }

  const existing = libraryMatch(dep, server);
  if (existing) {
    const already = db.prepare('SELECT id FROM server_mods WHERE server_id = ? AND mod_id = ?')
      .get(server.id, existing.mod.id);
    if (already) return { id: dep.id, status: 'installed', name: existing.mod.name };
    javaModInstall.install(server, existing.mod.id, { fileSha256: existing.file?.sha256 });
    return { id: dep.id, status: 'installed', name: existing.mod.name };
  }

  const mismatch = libraryMismatch(dep);
  if (mismatch?.files?.length) {
    return {
      id: dep.id,
      status: 'mismatch',
      name: mismatch.mod.name,
      source: 'library',
      modId: mismatch.mod.id,
      warning: 'None of the downloaded files match this server Minecraft version or launcher. Installing one anyway may not work.',
      files: mismatch.files.map(publicMismatchFile),
    };
  }

  const catalogService = require('./catalogService');
  let hits = await searchCatalog(dep, server, { loader: server.loader_provider_id });
  if (!hits.length) hits = await searchCatalog(dep, server, {});
  if (!hits.length) {
    return { id: dep.id, status: 'missing', error: 'Not found in the catalog' };
  }

  for (const project of hits) {
    const files = await catalogService.listDownloadFiles(project.slug || project.id, {
      provider: project.providerId,
      source: project.source,
      edition: 'java',
      curseforgeId: project.curseforgeId || project.id,
    });
    const listed = files || [];
    let selectable = listed
      .filter((file) => fileMatchesServer(file, server, { allowUnknown: false }))
      .sort((a, b) => scoreFile(b, server) - scoreFile(a, server));
    if (!selectable.length) {
      selectable = listed
        .filter((file) => fileMatchesServer(file, server, { allowUnknown: true }))
        .sort((a, b) => scoreFile(b, server) - scoreFile(a, server));
    }
    if (selectable.length) {
      const installed = await installCatalogFile(server, project, selectable[0]);
      if (installed.status === 'installed') {
        removeIncompatibleJars(server, dep);
        return { id: dep.id, ...installed };
      }
      continue;
    }
    const overrideFiles = listed.filter((file) => file.environment !== 'client');
    if (overrideFiles.length) {
      return {
        id: dep.id,
        status: 'mismatch',
        name: project.name,
        source: 'catalog',
        project: {
          slug: project.slug,
          id: project.id,
          providerId: project.providerId,
          source: project.source,
          curseforgeId: project.curseforgeId || project.id,
          name: project.name,
        },
        warning: 'A catalog match was found, but none of its files match this server Minecraft version or launcher. Installing one anyway may not work.',
        files: overrideFiles.map(publicMismatchFile),
      };
    }
  }
  return { id: dep.id, status: 'missing', error: `No ${server.loader_provider_id || 'compatible'} catalog file` };
}

async function resolve(server, selectedIds, overrides = {}) {
  const stored = readStored(server);
  const catalogAvailable = await catalogIsReachable();
  const wantedIds = new Set((selectedIds || []).map((id) => String(id).toLowerCase()));
  const pool = [...stored.required, ...stored.optional];
  const selected = pool.filter((dep) => !wantedIds.size || wantedIds.has(depKey(dep)));
  if (!selected.length) {
    throw Object.assign(new Error('Select at least one dependency to resolve'), { status: 400 });
  }
  const overrideMap = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    overrideMap[String(key).toLowerCase()] = value;
  }
  const hasOverrides = Object.keys(overrideMap).length > 0;
  if (!catalogAvailable && !hasOverrides && !selected.some((dep) => libraryMatch(dep, server) || libraryMismatch(dep))) {
    const next = {
      ...stored,
      catalogAvailable: false,
      message: 'The catalog is unavailable. Download these mods into the library, then install them on this server.',
      unresolved: selected.map((dep) => dep.id),
    };
    save(server.id, next);
    return next;
  }

  const results = [];
  for (const dep of selected) {
    try {
      results.push(await resolveOne(server, dep, overrideMap));
    } catch (err) {
      logger.warn(`Could not resolve ${dep.id} for server ${server.id}: ${err.message}`);
      results.push({ id: dep.id, status: 'missing', error: err.message });
    }
  }

  const installedIds = new Set(results.filter((item) => item.status === 'installed').map((item) => depKey(item)));
  const required = stored.required.filter((dep) => !installedIds.has(depKey(dep)));
  const optional = stored.optional.filter((dep) => !installedIds.has(depKey(dep)));
  const unresolved = results.filter((item) => item.status !== 'installed');
  const mismatches = results.filter((item) => item.status === 'mismatch');
  const next = {
    required,
    optional,
    catalogAvailable,
    message: mismatches.length
      ? `A matching file was not found for: ${mismatches.map((item) => item.id).join(', ')}. You can pick a downloaded file anyway; it may not work.`
      : unresolved.length
        ? `Could not automatically install: ${unresolved.map((item) => item.id).join(', ')}. Download them into the library if they are not in the catalog.`
        : (required.length ? 'There are missing dependencies.' : ''),
    unresolved: unresolved.map((item) => item.id),
  };
  save(server.id, required.length || optional.length ? next : null);
  pluginAudit.record('java.mod.dependencies.resolve', {
    targetType: 'server',
    targetId: String(server.id),
    detail: { installed: results.filter((item) => item.status === 'installed').map((item) => item.id), unresolved: next.unresolved },
  });
  return {
    ...next,
    results,
  };
}

function pruneResolved(server) {
  const stored = readStored(server);
  if (!stored.required.length && !stored.optional.length) return null;
  const installed = installedIdentities(server);
  const required = stored.required.filter((dep) => !installed.has(depKey(dep)) && !isForeignForLoader(dep.id, server.loader_provider_id));
  const optional = stored.optional.filter((dep) => !installed.has(depKey(dep)) && !isForeignForLoader(dep.id, server.loader_provider_id));
  const next = required.length || optional.length
    ? { ...stored, required, optional, unresolved: required.map((item) => item.id) }
    : null;
  save(server.id, next);
  return next;
}

module.exports = {
  clear,
  detectFromText,
  emptyState,
  looksLikeDependencyFailure,
  looksLikeStarted,
  maybeClearOnReady,
  mergeDeps,
  parseLoaderCrash,
  parseWrongLoaderSkips,
  publicState,
  readCrashReports,
  readStored,
  recordFromCrash,
  resolve,
  pruneResolved,
  fileMatchesServer,
};
