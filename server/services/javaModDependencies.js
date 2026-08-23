const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const logger = require('./logger');
const pluginAudit = require('./pluginAudit');
const javaModMetadata = require('./javaModMetadata');
const javaModInstall = require('./javaModInstall');
const minecraftVersions = require('./minecraftVersions');
const catalogModMeta = require('./catalogModMeta');

const BUILTIN = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric-loader', 'fabric',
  'neoforge', 'forge', 'fml', 'mcp', 'quilt_loader',
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
  for (const item of javaModInstall.list(server.id)) {
    const mod = item.mod || {};
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
        const meta = info.metadata || {};
        for (const value of [info.name, meta.modId, meta.id, path.parse(name).name]) {
          const key = String(value || '').trim().toLowerCase();
          if (key) ids.add(key);
        }
      } catch {
        ids.add(path.parse(name).name.toLowerCase());
      }
    }
  } catch {
    /* mods dir may not exist yet */
  }
  return ids;
}

function manifestDependencies(server) {
  const deps = [];
  const modsDir = path.join(server.data_path, 'mods');
  try {
    for (const name of fs.readdirSync(modsDir)) {
      if (!name.toLowerCase().endsWith('.jar') || name.toLowerCase().endsWith('.pending')) continue;
      try {
        const info = javaModMetadata.inspectJar(path.join(modsDir, name));
        deps.push(...(info.dependencies || []));
      } catch {
        /* skip unreadable jars */
      }
    }
  } catch {
    /* ignore */
  }
  for (const item of javaModInstall.list(server.id)) {
    deps.push(...(item.mod?.dependencies || []));
  }
  return deps;
}

function looksLikeDependencyFailure(text) {
  return /ModLoadingException|ModLoadingCrashException|is not installed|which is missing|Mod resolution failed|Missing or unsupported mandatory dependencies|Actual version:\s*'\[MISSING\]'|Mod loading has failed|pre-loading phase|Failure message:|Loading errors encountered|Mod\s+\S+\s+requires\s+\S+/i.test(String(text || ''));
}

function looksLikeStarted(text) {
  return /Done \(|For help, type "help"|Loading Minecraft .*Done/i.test(String(text || ''));
}

function detectFromText(server, text, options = {}) {
  if (!server || server.kind !== 'java') return null;
  const loader = String(server.loader_provider_id || 'vanilla');
  if (loader === 'vanilla') return null;
  const fromLog = parseLoaderCrash(text);
  const extraRequired = options.extraRequired || [];
  const installed = installedIdentities(server);
  let missingRequired = mergeDeps([], fromLog, false);
  missingRequired = mergeDeps(missingRequired, extraRequired, false)
    .filter((dep) => !installed.has(depKey(dep)) && !isBuiltin(dep.id));
  const fromManifest = manifestDependencies(server);
  if (options.includeManifestRequired) {
    const manifestRequired = fromManifest
      .filter((dep) => !dep.optional && !isBuiltin(dep.id) && !installed.has(depKey(dep)))
      .map((dep) => ({
        id: dep.id,
        version: dep.version || '*',
        optional: false,
        displayName: dep.id,
      }));
    missingRequired = mergeDeps(missingRequired, manifestRequired, false);
  }
  const missingOptional = fromManifest
    .filter((dep) => dep.optional && !isBuiltin(dep.id) && !installed.has(depKey(dep)))
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
  return {
    required,
    optional,
    catalogAvailable: true,
    message: required.length ? 'There are missing dependencies.' : '',
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

function fileMatchesServer(file, server) {
  const loader = String(server.loader_provider_id || '').toLowerCase();
  const fileLoader = String(file.loader || '').toLowerCase();
  if (file.environment === 'client') return false;
  if (fileLoader && fileLoader !== 'any' && fileLoader !== 'unknown' && fileLoader !== loader) {
    if (!(loader === 'neoforge' && fileLoader === 'forge')) return false;
  }
  return minecraftVersions.supportsMinecraftVersion(file.minecraftVersions || [], server.minecraft_version);
}

function scoreProject(project, dep) {
  const id = depKey(dep);
  const slug = String(project.slug || '').toLowerCase();
  const name = String(project.name || '').toLowerCase();
  if (slug === id || name === id) return 100;
  if (slug.includes(id) || name.includes(id)) return 80;
  if (slug.replace(/-/g, '') === id.replace(/-/g, '')) return 90;
  return 10;
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

function libraryMatch(dep) {
  const id = depKey(dep);
  const rows = db.prepare('SELECT * FROM mods WHERE edition = ?').all('java');
  return rows.find((row) => {
    const meta = parseJson(row.metadata_json, {});
    const names = [row.name, row.slug, meta.modId, meta.id].map((item) => String(item || '').toLowerCase());
    return names.includes(id) || names.some((name) => name.includes(id));
  });
}

async function resolveOne(server, dep) {
  const existing = libraryMatch(dep);
  if (existing) {
    const already = db.prepare('SELECT id FROM server_mods WHERE server_id = ? AND mod_id = ?')
      .get(server.id, existing.id);
    if (already) return { id: dep.id, status: 'installed' };
    javaModInstall.install(server, existing.id);
    return { id: dep.id, status: 'installed', name: existing.name };
  }

  const catalogService = require('./catalogService');
  const query = String(dep.id || '').replace(/[-_]/g, ' ');
  const result = await catalogService.searchMods(query, {
    edition: 'java',
    pageSize: 10,
    page: 1,
    sortBy: 'relevancy',
    gameVersions: [{ version: server.minecraft_version, edition: 'java' }],
  });
  const hits = [...(result.results || [])].sort((a, b) => scoreProject(b, dep) - scoreProject(a, dep));
  const project = hits.find((item) => scoreProject(item, dep) >= 80) || hits[0];
  if (!project) {
    return { id: dep.id, status: 'missing', error: 'Not found in the catalog' };
  }
  const files = await catalogService.listDownloadFiles(project.slug || project.id, {
    provider: project.providerId,
    source: project.source,
    edition: 'java',
    curseforgeId: project.curseforgeId || project.id,
  });
  const selectable = (files || []).filter((file) => fileMatchesServer(file, server));
  const file = selectable[0] || (files || []).find((item) => item.environment !== 'client');
  if (!file) {
    return { id: dep.id, status: 'missing', error: 'No compatible catalog file' };
  }
  const loader = catalogModMeta.normalizeLoader(server.loader_provider_id, 'java');
  const downloaded = await catalogService.downloadMod(project.slug || String(project.id), {
    provider: project.providerId,
    source: project.source,
    edition: 'java',
    curseforgeId: project.curseforgeId || project.id,
    files: [String(file.id || file.fileId)],
    loader,
  });
  if (!downloaded?.modId) {
    return { id: dep.id, status: 'missing', error: 'Catalog download did not return a library mod' };
  }
  const already = db.prepare('SELECT id FROM server_mods WHERE server_id = ? AND mod_id = ?')
    .get(server.id, downloaded.modId);
  if (!already) javaModInstall.install(server, downloaded.modId);
  return { id: dep.id, status: 'installed', name: downloaded.name };
}

async function resolve(server, selectedIds) {
  const stored = readStored(server);
  const catalogAvailable = await catalogIsReachable();
  const wantedIds = new Set((selectedIds || []).map((id) => String(id).toLowerCase()));
  const pool = [...stored.required, ...stored.optional];
  const selected = pool.filter((dep) => !wantedIds.size || wantedIds.has(depKey(dep)));
  if (!selected.length) {
    throw Object.assign(new Error('Select at least one dependency to resolve'), { status: 400 });
  }
  if (!catalogAvailable) {
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
      results.push(await resolveOne(server, dep));
    } catch (err) {
      logger.warn(`Could not resolve ${dep.id} for server ${server.id}: ${err.message}`);
      results.push({ id: dep.id, status: 'missing', error: err.message });
    }
  }

  const installedIds = new Set(results.filter((item) => item.status === 'installed').map((item) => depKey(item)));
  const required = stored.required.filter((dep) => !installedIds.has(depKey(dep)));
  const optional = stored.optional.filter((dep) => !installedIds.has(depKey(dep)));
  const unresolved = results.filter((item) => item.status !== 'installed');
  const next = {
    required,
    optional,
    catalogAvailable: true,
    message: unresolved.length
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

module.exports = {
  clear,
  detectFromText,
  emptyState,
  looksLikeDependencyFailure,
  looksLikeStarted,
  maybeClearOnReady,
  mergeDeps,
  parseLoaderCrash,
  publicState,
  readCrashReports,
  readStored,
  recordFromCrash,
  resolve,
};
