const fs = require('fs');
const path = require('path');
const packFiles = require('./packFiles');

function parseExtraFiles(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && item.path);
  } catch {
    return [];
  }
}

function serializeExtraFiles(files = []) {
  return JSON.stringify((files || []).map((item) => ({
    path: item.path,
    name: item.name || path.basename(item.path),
    kind: item.kind || packFiles.typeFromExt(item.path),
    size: Number(item.size) || 0,
  })));
}

function archiveList(mod) {
  const extras = parseExtraFiles(mod && mod.extra_files);
  const primary = mod && mod.file_path
    ? [{ path: mod.file_path, kind: mod.type || packFiles.typeFromExt(mod.file_path), size: mod.file_size }]
    : [];
  const seen = new Set();
  return [...primary, ...extras].filter((item) => {
    if (!item?.path) return false;
    const key = path.resolve(item.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function existingArchives(mod) {
  return archiveList(mod).filter((item) => fs.existsSync(item.path));
}

function extraFilesFromPaths(paths = [], primaryPath) {
  const extras = [];
  const seen = new Set(primaryPath ? [path.resolve(primaryPath)] : []);
  for (const filePath of paths || []) {
    if (!filePath) continue;
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    extras.push({
      path: filePath,
      name: path.basename(filePath),
      kind: packFiles.typeFromExt(filePath),
      size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
    });
  }
  return extras;
}

function orderArchivePaths(files = []) {
  const rank = { '.mcaddon': 0, '.zip': 1, '.mcpack': 2, '.mcworld': 3, '.mctemplate': 4, '.mcstructure': 5 };
  return [...files].sort((a, b) => {
    const aPath = typeof a === 'string' ? a : a.path;
    const bPath = typeof b === 'string' ? b : b.path;
    const aRank = rank[path.extname(aPath || '').toLowerCase()] ?? 9;
    const bRank = rank[path.extname(bPath || '').toLowerCase()] ?? 9;
    return aRank - bRank || path.basename(aPath).localeCompare(path.basename(bPath));
  });
}

module.exports = {
  parseExtraFiles,
  serializeExtraFiles,
  archiveList,
  existingArchives,
  extraFilesFromPaths,
  orderArchivePaths,
};
