const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const db = require('../db/connection');
const logger = require('./logger');
const packFiles = require('./packFiles');

const execFileAsync = promisify(execFile);
const ARCHIVE_EXTS = new Set(packFiles.ARCHIVE_EXTS);
const SKIP_DIRS = new Set(['__macosx', '.git', 'node_modules']);

function readJson(filePath) {
  const raw = fs.readFileSync(filePath);
  const text = raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF
    ? raw.slice(3).toString('utf8')
    : raw.toString('utf8');
  return JSON.parse(text);
}

function packTypeFromManifest(manifest) {
  const types = new Set((manifest.modules || []).map((module) => String(module.type || '').toLowerCase()));
  if (types.has('resources') && !types.has('data') && !types.has('script')) return 'resources';
  if (types.has('data') || types.has('script') || types.has('javascript')) return 'data';
  return null;
}

function findManifestPacks(root) {
  const packs = [];
  const walk = (dir, depth = 0) => {
    if (depth > 8 || !fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const manifestPath = path.join(dir, 'manifest.json');
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
      try {
        const manifest = readJson(manifestPath);
        const uuid = manifest?.header?.uuid;
        const version = manifest?.header?.version;
        const type = packTypeFromManifest(manifest);
        if (uuid && Array.isArray(version) && type) {
          packs.push({ dir, uuid: String(uuid), version, type });
        }
      } catch (err) {
        logger.warn(`Skipped invalid pack manifest at ${manifestPath}: ${err.message}`);
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(root);
  return packs;
}

async function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    await execFileAsync('unzip', ['-o', '-q', archivePath, '-d', destDir], {
      timeout: 180000,
      windowsHide: true,
    });
    return;
  } catch (unzipErr) {
    try {
      await execFileAsync('tar', ['-xf', archivePath, '-C', destDir], {
        timeout: 180000,
        windowsHide: true,
      });
    } catch (tarErr) {
      throw new Error(`Could not extract ${path.basename(archivePath)}: ${unzipErr.stderr || unzipErr.message}`);
    }
  }
}

async function extractNestedArchives(root, depth = 0) {
  if (depth > 3) return;
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) walk(full);
      } else if (ARCHIVE_EXTS.has(path.extname(entry.name).toLowerCase()) && path.extname(entry.name).toLowerCase() !== '.mcworld') {
        files.push(full);
      }
    }
  };
  walk(root);
  for (const archive of files) {
    const nestedDir = `${archive}.extracted`;
    await extractArchive(archive, nestedDir);
    fs.unlinkSync(archive);
    await extractNestedArchives(nestedDir, depth + 1);
  }
}

function findStructureFiles(root, base = root, collected = []) {
  if (!root || !fs.existsSync(root)) return collected;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return collected; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name.toLowerCase())) findStructureFiles(full, base, collected);
      continue;
    }
    if (!packFiles.isStructureExt(path.extname(entry.name))) continue;
    const rel = path.relative(base, full).split(path.sep);
    const idx = rel.map((part) => part.toLowerCase()).lastIndexOf('structures');
    const stored = (idx >= 0 ? rel.slice(idx + 1) : [entry.name]).join('/');
    collected.push({ abs: full, rel: stored.replace(/\\/g, '/') });
  }
  return collected;
}

function placeStructures(server, mod, files) {
  const world = worldDir(server);
  const placed = [];
  for (const file of files) {
    const safeRel = String(file.rel || path.basename(file.abs)).replace(/\.\./g, '').replace(/^\/+/, '');
    const dest = path.join(world, 'structures', safeRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file.abs, dest);
    placed.push({
      type: 'structure',
      dir: path.relative(server.data_path, dest).split(path.sep).join('/'),
    });
  }
  removeLooseArchiveCopies(server.data_path, path.basename(mod.file_path || ''));
  return placed;
}

function isWorldMod(mod) {
  const ext = packFiles.extOf(mod.file_path);
  return mod.type === 'world' || mod.type === 'map' || mod.type === 'template'
    || ext === '.mcworld' || ext === '.mctemplate';
}

function isStructureMod(mod) {
  return mod.type === 'structure' || packFiles.isStructureExt(packFiles.extOf(mod.file_path));
}

function isZipFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4B && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
  } catch {
    return false;
  }
}

function findWorldRoot(root, depth = 0) {
  if (!root || !fs.existsSync(root) || depth > 4) return null;
  if (fs.existsSync(path.join(root, 'level.dat'))) return root;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
    const found = findWorldRoot(path.join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

function readLevelNameSetting(serverPath) {
  const propsPath = path.join(serverPath, 'server.properties');
  if (!fs.existsSync(propsPath)) return 'Bedrock level';
  const match = fs.readFileSync(propsPath, 'utf8').match(/^level-name=(.*)$/m);
  return (match && match[1].trim()) || 'Bedrock level';
}

function writeLevelNameSetting(serverPath, levelName) {
  const propsPath = path.join(serverPath, 'server.properties');
  const line = `level-name=${levelName}`;
  if (!fs.existsSync(propsPath)) {
    fs.writeFileSync(propsPath, `${line}\n`);
    return;
  }
  const current = fs.readFileSync(propsPath, 'utf8');
  if (/^level-name=/m.test(current)) {
    fs.writeFileSync(propsPath, current.replace(/^level-name=.*$/m, line));
  } else {
    fs.writeFileSync(propsPath, `${current.replace(/\s*$/, '')}\n${line}\n`);
  }
}

function worldFolderName(worldRoot, fallback) {
  const nameFile = path.join(worldRoot, 'levelname.txt');
  if (fs.existsSync(nameFile)) {
    const name = fs.readFileSync(nameFile, 'utf8').split(/\r?\n/)[0].trim();
    if (name) return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim() || fallback;
  }
  return fallback;
}

function uniqueWorldFolder(serverPath, desired) {
  const worlds = path.join(serverPath, 'worlds');
  let candidate = desired || 'Imported World';
  let suffix = 2;
  while (fs.existsSync(path.join(worlds, candidate))) {
    candidate = `${desired} ${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function collectManifestUuids(dir, collected = new Set()) {
  if (!dir || !fs.existsSync(dir)) return collected;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return collected; }
  const manifestPath = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const uuid = readJson(manifestPath)?.header?.uuid;
      if (uuid) collected.add(String(uuid));
    } catch { /* ignore */ }
    return collected;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name.toLowerCase())) {
      collectManifestUuids(path.join(dir, entry.name), collected);
    }
  }
  return collected;
}

function readPackList(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePackList(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(entries, null, 2)}\n`);
}

function worldDir(server) {
  return path.join(server.data_path, 'worlds', readLevelNameSetting(server.data_path));
}

function removeLooseArchiveCopies(serverPath, filename) {
  if (!filename) return;
  for (const folder of ['behavior_packs', 'resource_packs', 'texture_packs', 'worlds']) {
    const candidate = path.join(serverPath, folder, filename);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      fs.unlinkSync(candidate);
    }
  }
}

function parseManifest(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : parsed.packs || [];
  } catch {
    return [];
  }
}

function syncWorldPackLists(server) {
  const rows = db.prepare(`
    SELECT install_manifest FROM server_mods WHERE server_id = ?
  `).all(server.id);
  const managedBehavior = [];
  const managedResources = [];
  const seen = new Set();
  for (const row of rows) {
    for (const pack of parseManifest(row.install_manifest)) {
      if (pack.type === 'world' || !pack.uuid) continue;
      const key = `${pack.uuid}:${JSON.stringify(pack.version)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = { pack_id: pack.uuid, version: pack.version };
      if (pack.type === 'resources') managedResources.push(entry);
      else managedBehavior.push(entry);
    }
  }

  const world = worldDir(server);
  const worldBehaviorUuids = collectManifestUuids(path.join(world, 'behavior_packs'));
  const worldResourceUuids = collectManifestUuids(path.join(world, 'resource_packs'));
  const merge = (filePath, worldUuids, managed) => {
    const managedIds = new Set(managed.map((entry) => entry.pack_id));
    const kept = readPackList(filePath).filter((entry) => (
      entry.pack_id && worldUuids.has(entry.pack_id) && !managedIds.has(entry.pack_id)
    ));
    const combined = [...kept];
    for (const entry of managed) {
      if (!combined.some((item) => item.pack_id === entry.pack_id)) combined.push(entry);
    }
    writePackList(filePath, combined);
  };
  merge(path.join(world, 'world_behavior_packs.json'), worldBehaviorUuids, managedBehavior);
  merge(path.join(world, 'world_resource_packs.json'), worldResourceUuids, managedResources);
}

async function extractToTemp(archivePath, { nested = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-pack-'));
  try {
    await extractArchive(archivePath, tmp);
    if (nested) await extractNestedArchives(tmp);
    return tmp;
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

function destParent(type) {
  return type === 'resources' ? 'resource_packs' : 'behavior_packs';
}

function placePacks(server, mod, packs) {
  const placed = [];
  for (const pack of packs) {
    const folder = destParent(pack.type);
    const destName = `addon_${mod.id}_${String(pack.uuid).replace(/-/g, '').slice(0, 8)}`;
    const dest = path.join(server.data_path, folder, destName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(pack.dir, dest, { recursive: true });
    placed.push({
      uuid: pack.uuid,
      version: pack.version,
      type: pack.type,
      dir: path.join(folder, destName),
    });
  }
  removeLooseArchiveCopies(server.data_path, path.basename(mod.file_path));
  return placed;
}

function placeWorld(server, mod, worldRoot) {
  const previousLevelName = readLevelNameSetting(server.data_path);
  const fallback = path.parse(mod.file_path || 'Imported World').name.replace(/_/g, ' ') || 'Imported World';
  const folderName = uniqueWorldFolder(server.data_path, worldFolderName(worldRoot, fallback));
  const dest = path.join(server.data_path, 'worlds', folderName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(worldRoot, dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'levelname.txt'), `${folderName}\n`);
  writeLevelNameSetting(server.data_path, folderName);
  removeLooseArchiveCopies(server.data_path, path.basename(mod.file_path || ''));
  return [{
    type: 'world',
    dir: path.join('worlds', folderName),
    previousLevelName,
  }];
}

async function installModToServer(server, mod) {
  if (isStructureMod(mod) && !isZipFile(mod.file_path)) {
    return placeStructures(server, mod, [{
      abs: mod.file_path,
      rel: path.basename(mod.file_path),
    }]);
  }

  const tmp = await extractToTemp(mod.file_path, { nested: false });
  try {
    const worldRoot = findWorldRoot(tmp);
    if (worldRoot) return placeWorld(server, mod, worldRoot);
    if (isWorldMod(mod)) {
      throw new Error(`No level.dat found in ${path.basename(mod.file_path)}`);
    }
    await extractNestedArchives(tmp);
    const packs = findManifestPacks(tmp);
    if (packs.length) return placePacks(server, mod, packs);
    const structures = findStructureFiles(tmp);
    if (structures.length) return placeStructures(server, mod, structures);
    throw new Error(`${path.basename(mod.file_path)} is not a Bedrock pack, world, template, or structure file`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function uninstallModFromServer(server, mod, manifestRaw) {
  const currentLevel = readLevelNameSetting(server.data_path);
  for (const pack of parseManifest(manifestRaw)) {
    if (!pack.dir) continue;
    const dest = path.join(server.data_path, pack.dir);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    if (pack.type === 'world') {
      const folderName = path.basename(pack.dir);
      if (currentLevel === folderName && pack.previousLevelName) {
        writeLevelNameSetting(server.data_path, pack.previousLevelName);
      }
    }
  }
  removeLooseArchiveCopies(server.data_path, path.basename(mod.file_path || ''));
}

async function activateServerPacks(server) {
  if (!server || server.kind === 'bedrock_connect') return;
  const rows = db.prepare(`
    SELECT sm.mod_id, sm.install_manifest, m.file_path, m.name, m.type
    FROM server_mods sm
    JOIN mods m ON m.id = sm.mod_id
    WHERE sm.server_id = ?
  `).all(server.id);

  for (const row of rows) {
    const existing = parseManifest(row.install_manifest);
    const placedDirsExist = existing.length > 0 && existing.every((pack) => (
      pack.dir && fs.existsSync(path.join(server.data_path, pack.dir))
    ));
    if (placedDirsExist) continue;
    if (!row.file_path || !fs.existsSync(row.file_path)) continue;
    try {
      const placed = await installModToServer(server, {
        id: row.mod_id,
        file_path: row.file_path,
        type: row.type,
      });
      db.prepare(`
        UPDATE server_mods SET install_manifest = ? WHERE server_id = ? AND mod_id = ?
      `).run(JSON.stringify(placed), server.id, row.mod_id);
      logger.info(`Activated ${placed.length} pack(s) from ${row.name} on ${server.name}`);
    } catch (err) {
      logger.warn(`Could not activate ${row.name} on ${server.name}: ${err.message}`);
    }
  }
  syncWorldPackLists(server);
}

module.exports = {
  findManifestPacks,
  findWorldRoot,
  findStructureFiles,
  packTypeFromManifest,
  isWorldMod,
  isStructureMod,
  installModToServer,
  uninstallModFromServer,
  activateServerPacks,
  syncWorldPackLists,
  parseManifest,
};
