const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const catalogModMeta = require('./catalogModMeta');
const minecraftVersions = require('./minecraftVersions');
const modCompatibility = require('./modCompatibility');
const javaModMetadata = require('./javaModMetadata');
const modArchives = require('./modArchives');
const packFiles = require('./packFiles');

function parseJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function publicFile(file) {
  if (!file?.path) return null;
  return {
    path: file.path,
    name: file.name || path.basename(file.path),
    size: Number(file.size) || 0,
    sha256: file.sha256 || '',
    loader: catalogModMeta.normalizeLoader(file.loader, 'java') || 'unknown',
    minecraftVersions: minecraftVersions.parseVersionList(file.minecraftVersions),
    environment: file.environment || 'unknown',
    curseforgeFileId: file.curseforgeFileId || file.fileId || '',
    version: file.version || '',
  };
}

function recordFromHints(filePath, hints = {}, jarMeta = {}) {
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  const loader = catalogModMeta.normalizeLoader(
    jarMeta.loader && jarMeta.loader !== 'any' && jarMeta.loader !== 'unknown'
      ? jarMeta.loader
      : (hints.loader || jarMeta.loader),
    'java'
  );
  const versions = (hints.minecraftVersions && hints.minecraftVersions.length)
    ? hints.minecraftVersions
    : (jarMeta.minecraftVersions || []);
  return {
    path: filePath,
    name: hints.name || path.basename(filePath),
    size: hints.size || stat?.size || 0,
    sha256: jarMeta.sha256 || hints.sha256 || '',
    loader: loader || 'unknown',
    minecraftVersions: Array.isArray(versions) ? versions : [],
    environment: javaModMetadata.preferJarEnvironment(jarMeta.environment, hints.environment),
    curseforgeFileId: String(hints.curseforgeFileId || hints.fileId || hints.id || ''),
    version: hints.version || hints.displayName || jarMeta.version || '',
    kind: packFiles.typeFromExt(filePath, 'mod'),
  };
}

function inspectPath(filePath, hints = {}) {
  let jarMeta = {};
  try {
    if (String(filePath).toLowerCase().endsWith('.jar')) {
      jarMeta = javaModMetadata.inspectJar(filePath);
    }
  } catch {
    jarMeta = {};
  }
  return recordFromHints(filePath, hints, jarMeta);
}

function listFiles(mod) {
  if (!mod) return [];
  const extras = modArchives.parseExtraFiles(mod.extra_files);
  const primaryVersions = minecraftVersions.modMinecraftVersions(mod);
  const primary = mod.file_path
    ? [{
      path: mod.file_path,
      name: path.basename(mod.file_path),
      size: Number(mod.file_size) || 0,
      sha256: mod.sha256 || '',
      loader: mod.loader || 'unknown',
      minecraftVersions: primaryVersions,
      environment: mod.environment || 'unknown',
      curseforgeFileId: parseJson(mod.metadata_json, {}).curseforgeFileId || '',
      version: mod.version || '',
      kind: packFiles.typeFromExt(mod.file_path, mod.type || 'mod'),
    }]
    : [];
  const seen = new Set();
  const out = [];
  for (const item of [...primary, ...extras]) {
    if (!item?.path) continue;
    const key = path.resolve(item.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      path: item.path,
      name: item.name || path.basename(item.path),
      size: Number(item.size) || 0,
      sha256: item.sha256 || '',
      loader: item.loader || mod.loader || 'unknown',
      minecraftVersions: Array.isArray(item.minecraftVersions) && item.minecraftVersions.length
        ? item.minecraftVersions
        : primaryVersions,
      environment: item.environment || mod.environment || 'unknown',
      curseforgeFileId: item.curseforgeFileId || item.fileId || '',
      version: item.version || '',
      kind: item.kind || packFiles.typeFromExt(item.path, 'mod'),
    });
  }
  return out;
}

function aggregate(files) {
  const loaders = [...new Set(files.map((file) => catalogModMeta.normalizeLoader(file.loader, 'java')).filter((id) => id && id !== 'unknown' && id !== 'any'))];
  const versions = [...new Set(files.flatMap((file) => file.minecraftVersions || []))];
  const size = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  return {
    loaders,
    minecraftVersions: versions,
    loader: loaders.length === 1 ? loaders[0] : (loaders.length ? 'any' : 'unknown'),
    fileSize: size,
  };
}

function fileMatchesServer(file, server, { allowUnknown = false } = {}) {
  return modCompatibility.fileCompatibleWithServer(file, server, { allowUnknown });
}

function matchingFiles(mod, server, options = {}) {
  return listFiles(mod).filter((file) => fileMatchesServer(file, server, options));
}

function bestFileForServer(mod, server, { sha256, allowUnknown = false, allowMismatch = false } = {}) {
  const files = listFiles(mod);
  const nonClient = files.filter((file) => file.environment !== 'client');
  if (sha256) {
    const exact = files.find((file) => file.sha256 && file.sha256 === sha256)
      || files.find((file) => path.basename(file.path) === sha256)
      || files.find((file) => file.path === sha256);
    if (exact && exact.environment !== 'client') {
      if (allowMismatch || fileMatchesServer(exact, server, { allowUnknown })) return exact;
    }
  }
  const matched = files.filter((file) => fileMatchesServer(file, server, { allowUnknown }));
  if (matched.length) return matched[0];
  if (allowMismatch) return nonClient[0] || null;
  return null;
}

function parseMetadata(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function markJarEnvironment(modId) {
  const row = db.prepare('SELECT metadata_json FROM mods WHERE id = ?').get(modId);
  const metadata = parseMetadata(row?.metadata_json);
  if (metadata.jarEnvironment === true) return;
  metadata.jarEnvironment = true;
  db.prepare('UPDATE mods SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), modId);
}

function refreshJarEnvironment(mod) {
  if (!mod?.id || String(mod.edition || '').toLowerCase() !== 'java') return mod;
  const metadata = parseMetadata(mod.metadata_json);
  if (metadata.jarEnvironment === true) return mod;
  const files = listFiles(mod);
  const hasJar = files.some((file) => (
    String(file.path || '').toLowerCase().endsWith('.jar') && fs.existsSync(file.path)
  ));
  if (!hasJar) return mod;
  let inspected = false;
  const next = files.map((file) => {
    if (!String(file.path || '').toLowerCase().endsWith('.jar') || !fs.existsSync(file.path)) return file;
    try {
      const jarMeta = javaModMetadata.inspectJar(file.path, { hash: false });
      inspected = true;
      return {
        ...file,
        environment: javaModMetadata.preferJarEnvironment(jarMeta.environment, file.environment),
      };
    } catch {
      return file;
    }
  });
  if (!inspected) return mod;
  return persistFiles(mod.id, next, { jarEnvironment: true });
}

function decorate(mod, { usageByMod } = {}) {
  if (!mod) return mod;
  const current = refreshJarEnvironment(mod);
  const files = listFiles(current).map((file) => publicFile(file)).filter(Boolean);
  const stats = aggregate(files);
  const usageRows = usageByMod?.get(Number(mod.id)) || [];
  const primaryName = path.basename(mod.file_path || '');
  const decoratedFiles = files.map((file) => {
    const servers = usageRows.filter((row) => {
      const installed = String(row.installed_file || '').trim();
      if (!installed) return file.name === primaryName;
      return installed === file.name || installed === path.basename(file.path || '') || installed === file.sha256;
    }).map((row) => ({ id: row.serverId, name: row.name }));
    return { ...file, inUse: servers.length > 0, usedBy: servers };
  });
  const usedBy = [...new Map(usageRows.map((row) => [row.serverId, { id: row.serverId, name: row.name }])).values()];
  return {
    ...current,
    files: decoratedFiles,
    loaders: stats.loaders,
    minecraftVersions: stats.minecraftVersions.length ? stats.minecraftVersions : minecraftVersions.modMinecraftVersions(current),
    loader: stats.loaders.length ? stats.loader : (current.loader || 'any'),
    environment: javaModMetadata.aggregateEnvironments(files.map((file) => file.environment)),
    inUse: usedBy.length > 0,
    usedBy,
  };
}

function loadUsageByMod() {
  const rows = db.prepare(`
    SELECT sm.mod_id as modId, sm.installed_file, s.id as serverId, s.name
    FROM server_mods sm
    JOIN servers s ON s.id = sm.server_id
    ORDER BY s.name COLLATE NOCASE
  `).all();
  const byMod = new Map();
  for (const row of rows) {
    const id = Number(row.modId);
    if (!byMod.has(id)) byMod.set(id, []);
    byMod.get(id).push(row);
  }
  return byMod;
}

function decorateMany(rows) {
  const usageByMod = loadUsageByMod();
  return (rows || []).map((row) => decorate(row, { usageByMod }));
}

function persistFiles(modId, files, { jarEnvironment = false } = {}) {
  const list = (files || []).filter((file) => file?.path);
  if (!list.length) throw Object.assign(new Error('A Java mod must keep at least one jar file'), { status: 400 });
  const primary = list[0];
  const extras = list.slice(1);
  const stats = aggregate(list);
  const environment = javaModMetadata.normalizeEnvironment(primary.environment);
  db.prepare(`
    UPDATE mods
    SET file_path = ?, file_size = ?, extra_files = ?, loader = ?, minecraft_versions = ?, sha256 = ?, environment = ?
    WHERE id = ?
  `).run(
    primary.path,
    stats.fileSize,
    extras.length ? modArchives.serializeExtraFiles(extras) : null,
    stats.loader,
    JSON.stringify(stats.minecraftVersions),
    primary.sha256 || '',
    environment,
    modId
  );
  if (jarEnvironment) markJarEnvironment(modId);
  return decorate(db.prepare('SELECT * FROM mods WHERE id = ?').get(modId));
}

function findExistingLibraryMod(project = {}) {
  const curseforgeId = project.curseforgeId != null && project.curseforgeId !== ''
    ? String(project.curseforgeId)
    : '';
  const modrinthId = String(project.modrinthId || project.metadata?.modrinth?.projectId || '').trim();
  const slug = String(project.slug || '').trim();
  if (curseforgeId) {
    const byId = db.prepare('SELECT * FROM mods WHERE curseforge_id = ?').get(curseforgeId);
    if (byId) return byId;
  }
  if (modrinthId) {
    const byModrinth = db.prepare(`
      SELECT * FROM mods
      WHERE json_extract(metadata_json, '$.modrinthProjectId') = ?
         OR json_extract(metadata_json, '$.modrinth.projectId') = ?
    `).get(modrinthId, modrinthId);
    if (byModrinth) return byModrinth;
  }
  if (slug) {
    const bySlug = db.prepare('SELECT * FROM mods WHERE slug = ?').get(slug);
    if (bySlug && String(bySlug.edition || '').toLowerCase() === 'java') {
      if (curseforgeId && bySlug.curseforge_id && String(bySlug.curseforge_id) !== curseforgeId) {
        return null;
      }
      return bySlug;
    }
  }
  return null;
}

function findExistingByHash(sha256) {
  const hash = String(sha256 || '').trim().toLowerCase();
  if (!hash) return null;
  return db.prepare('SELECT * FROM mods WHERE lower(COALESCE(sha256, \'\')) = ?').get(hash) || null;
}

function appendFiles(mod, incoming) {
  const current = listFiles(mod);
  const seenHash = new Set(current.map((file) => file.sha256).filter(Boolean));
  const seenPath = new Set(current.map((file) => path.resolve(file.path)));
  const added = [];
  for (const file of incoming || []) {
    if (!file?.path) continue;
    if (file.sha256 && seenHash.has(file.sha256)) {
      const already = current.find((item) => item.sha256 === file.sha256);
      if (already && path.resolve(already.path) !== path.resolve(file.path) && fs.existsSync(file.path)) {
        try { fs.unlinkSync(file.path); } catch { /* ignore duplicate copy */ }
      }
      continue;
    }
    const resolved = path.resolve(file.path);
    if (seenPath.has(resolved)) continue;
    seenHash.add(file.sha256 || '');
    seenPath.add(resolved);
    current.push(file);
    added.push(file);
  }
  persistFiles(mod.id, current, { jarEnvironment: true });
  return { added, files: listFiles(db.prepare('SELECT * FROM mods WHERE id = ?').get(mod.id)) };
}

function fileKey(file) {
  return file?.sha256 || path.resolve(file?.path || '');
}

function usageForFile(modId, file) {
  const basename = path.basename(file?.path || file?.name || '');
  const rows = db.prepare(`
    SELECT s.id, s.name, sm.installed_file
    FROM server_mods sm
    JOIN servers s ON s.id = sm.server_id
    WHERE sm.mod_id = ?
    ORDER BY s.name COLLATE NOCASE
  `).all(modId);
  return rows.filter((row) => {
    const installed = String(row.installed_file || '').trim();
    if (!installed) {
      const mod = db.prepare('SELECT file_path FROM mods WHERE id = ?').get(modId);
      return path.basename(mod?.file_path || '') === basename;
    }
    return installed === basename || installed === file?.sha256 || installed === file?.path;
  }).map((row) => ({ id: row.id, name: row.name }));
}

function usageForMod(modId) {
  return db.prepare(`
    SELECT s.id, s.name
    FROM server_mods sm
    JOIN servers s ON s.id = sm.server_id
    WHERE sm.mod_id = ?
    ORDER BY s.name COLLATE NOCASE
  `).all(modId);
}

module.exports = {
  aggregate,
  appendFiles,
  bestFileForServer,
  decorate,
  decorateMany,
  fileKey,
  fileMatchesServer,
  findExistingLibraryMod,
  findExistingByHash,
  inspectPath,
  listFiles,
  matchingFiles,
  persistFiles,
  publicFile,
  recordFromHints,
  usageForFile,
  usageForMod,
};
