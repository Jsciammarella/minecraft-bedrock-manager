const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const db = require('../db/connection');
const logger = require('./logger');
const packFiles = require('./packFiles');
const platform = require('./platform');

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

const PACK_ICON_RANK = {
  '.png': 0,
  '.jpeg': 1,
  '.jpg': 2,
  '.webp': 3,
  '.gif': 4,
};
const NESTED_PACK_EXTS = new Set(['.mcaddon', '.mcpack', '.zip']);

function unzipText(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value || '');
}

function unzipDetail(err) {
  const parts = [err?.stderr, err?.stdout, err?.message]
    .map((value) => unzipText(value).trim())
    .filter(Boolean);
  return [...new Set(parts)].join('\n').trim();
}

function unzipExitCode(err) {
  return typeof err?.code === 'number' ? err.code : null;
}

function isFilenameEncodingWarning(text) {
  return /mismatching ["']local["'] filename|#U[0-9A-Fa-f]{4}|needs extra bytes to extract|UTF-8.*filename|Unicode pathname/i.test(String(text || ''));
}

function isIncompleteArchiveError(text) {
  const value = String(text || '');
  if (isFilenameEncodingWarning(value) && !/bad CRC|bad zipfile offset|unexpected end of (?:file|archive)/i.test(value)) {
    return false;
  }
  return /bad CRC|bad zipfile offset|unexpected end of (?:file|archive)|missing \d+ bytes|end[- ]of[- ]central[- ]directory|not a zip|zipfile is empty|incorrect headers|failed CRC|cannot find (?:either )?zipfile|zipfile directory|file (?:is )?too short|invalid zip|lseek|extra bytes at beginning|Command failed: unzip/i.test(value);
}

function isUnzipIntegrityFailure(code, detail) {
  if (isFilenameEncodingWarning(detail) && !isIncompleteArchiveError(detail)) return false;
  if (isIncompleteArchiveError(detail)) return true;
  return [2, 3, 9, 11, 12].includes(Number(code));
}

function unzipWarningOnly(code, detail) {
  return Number(code) === 1 && !isIncompleteArchiveError(detail);
}

function extractionLooksComplete(destDir) {
  if (!destDir || !fs.existsSync(destDir)) return false;
  try {
    return fs.readdirSync(destDir).some((name) => name && name !== '.' && name !== '..');
  } catch {
    return false;
  }
}

function friendlyExtractError(archivePath, err) {
  const name = path.basename(archivePath);
  const detail = unzipDetail(err);
  const code = unzipExitCode(err);
  if (isUnzipIntegrityFailure(code, detail)) {
    return `${name} looks incomplete or corrupted. Wait until the copy finishes, then upload the pack again.`;
  }
  if (isFilenameEncodingWarning(detail)) {
    return `${name} has international characters in filenames. Extraction continued using the zip central directory names.`;
  }
  return `Could not extract ${name}: ${detail || 'unknown unzip error'}`;
}

function runUnzip(args, extra = {}) {
  return new Promise((resolve, reject) => {
    execFile('unzip', args, {
      timeout: extra.timeout || 180000,
      windowsHide: true,
      maxBuffer: extra.maxBuffer || 10 * 1024 * 1024,
      encoding: extra.encoding || 'utf8',
    }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') {
        reject(err);
        return;
      }
      const code = err ? unzipExitCode(err) : 0;
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
      }
      resolve({
        code,
        stdout,
        stderr,
        error: err || null,
      });
    });
  });
}

async function verifyArchive(archivePath) {
  if (!packFiles.isArchiveExt(path.extname(archivePath))) return;
  if (process.platform === 'win32') {
    await platform.listZipEntries(archivePath);
    return;
  }
  const result = await runUnzip(['-t', '-q', archivePath]);
  if (result.code === 0) return;
  const err = result.error || {
    stderr: result.stderr,
    stdout: result.stdout,
    code: result.code,
  };
  const detail = unzipDetail(err);
  if ((unzipWarningOnly(result.code, detail) || isFilenameEncodingWarning(detail)) && !isIncompleteArchiveError(detail)) {
    logger.warn(`Archive test warning for ${path.basename(archivePath)}: ${detail}`);
    return;
  }
  throw new Error(friendlyExtractError(archivePath, err));
}

function parseUnzipList(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const names = [];
  let inFiles = false;
  for (const line of lines) {
    if (/^-{5,}/.test(line.trim())) {
      inFiles = !inFiles;
      continue;
    }
    if (!inFiles) continue;
    const match = line.match(/\s+\d{2}:\d{2}\s+(.+)$/);
    if (match) names.push(match[1].replace(/\\/g, '/').trim());
  }
  return names.filter(Boolean);
}

async function listArchiveEntries(archivePath) {
  if (process.platform === 'win32') {
    return platform.listZipEntries(archivePath);
  }
  try {
    const { stdout } = await execFileAsync('unzip', ['-Z1', archivePath], {
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\\/g, '/').trim())
      .filter(Boolean);
  } catch (err) {
    const listed = String(err.stdout || '').trim();
    if (listed) {
      return listed.split(/\r?\n/).map((line) => line.replace(/\\/g, '/').trim()).filter(Boolean);
    }
    const { stdout } = await execFileAsync('unzip', ['-l', archivePath], {
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseUnzipList(stdout);
  }
}

function pickPackIconPath(entries) {
  const matches = [];
  for (const entry of entries || []) {
    const normalized = String(entry || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some((part) => part.toLowerCase() === '__macosx' || part === '.DS_Store')) continue;
    const base = (parts[parts.length - 1] || '').toLowerCase();
    const extMatch = base.match(/^pack_icon(\.png|\.jpe?g|\.webp|\.gif)$/);
    if (!extMatch) continue;
    matches.push({
      entry: normalized,
      depth: parts.length,
      rank: PACK_ICON_RANK[extMatch[1]] ?? 9,
    });
  }
  matches.sort((a, b) => a.depth - b.depth || a.rank - b.rank);
  return matches[0]?.entry || null;
}

async function extractOneToFile(archivePath, entry, destPath) {
  if (process.platform === 'win32') {
    const data = await platform.extractZipEntryToBuffer(archivePath, entry);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, data);
    return;
  }
  const { stdout } = await execFileAsync('unzip', ['-p', archivePath, entry], {
    encoding: null,
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 6 * 1024 * 1024,
  });
  if (!stdout || !stdout.length) throw new Error(`No data for ${entry}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, stdout);
}

async function findPackIconSource(archivePath) {
  const direct = pickPackIconPath(await listArchiveEntries(archivePath));
  if (direct) return { archivePath, entry: direct, cleanup: null };

  const entries = await listArchiveEntries(archivePath);
  for (const nestedName of entries) {
    if (!NESTED_PACK_EXTS.has(path.extname(nestedName).toLowerCase())) continue;
    const tmp = path.join(os.tmpdir(), `mc-icon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      await extractOneToFile(archivePath, nestedName, tmp);
      const inner = pickPackIconPath(await listArchiveEntries(tmp));
      if (inner) return { archivePath: tmp, entry: inner, cleanup: tmp };
    } catch {
      // try the next nested archive
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  return null;
}

async function extractPackIconFromArchive(archivePath, destDir, destBase) {
  if (!packFiles.isArchiveExt(path.extname(archivePath))) return null;
  const found = await findPackIconSource(archivePath);
  if (!found) return null;
  const ext = path.extname(found.entry).toLowerCase() || '.png';
  const destPath = path.join(destDir, `${destBase}${ext}`);
  try {
    await extractOneToFile(found.archivePath, found.entry, destPath);
    return destPath;
  } finally {
    if (found.cleanup) {
      try { fs.unlinkSync(found.cleanup); } catch { /* ignore */ }
    }
  }
}

const PYTHON_EXTRACT = `
import os, sys, zipfile
src, dest = sys.argv[1], sys.argv[2]
dest = os.path.abspath(dest)
os.makedirs(dest, exist_ok=True)
try:
    archive = zipfile.ZipFile(src, metadata_encoding="utf-8")
except TypeError:
    archive = zipfile.ZipFile(src)
with archive:
    for info in archive.infolist():
        name = info.filename.replace("\\\\", "/")
        parts = [part for part in name.split("/") if part and part != "."]
        if any(part == ".." for part in parts):
            continue
        target = os.path.abspath(os.path.join(dest, *parts)) if parts else dest
        if target != dest and not target.startswith(dest + os.sep):
            continue
        if name.endswith("/"):
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with archive.open(info) as source, open(target, "wb") as out:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
`;

async function extractWithPython(archivePath, destDir) {
  let python = 'python3';
  try {
    await execFileAsync(python, ['-V'], { timeout: 5000, windowsHide: true });
  } catch {
    python = 'python';
  }
  await execFileAsync(python, ['-c', PYTHON_EXTRACT, archivePath, destDir], {
    timeout: 180000,
    windowsHide: true,
  });
}

async function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    await platform.unzipArchive(archivePath, destDir);
    if (!extractionLooksComplete(destDir)) {
      throw new Error(friendlyExtractError(archivePath, { message: 'Windows zip extract produced no files' }));
    }
    return;
  }
  const unzipAttempts = [
    ['-O', 'UTF-8', '-I', 'UTF-8', '-o', '-qq', archivePath, '-d', destDir],
    ['-o', '-qq', archivePath, '-d', destDir],
  ];
  let lastErr = null;
  for (const args of unzipAttempts) {
    try {
      const result = await runUnzip(args);
      const detail = unzipDetail(result.error || { stderr: result.stderr, stdout: result.stdout, code: result.code });
      if (result.code === 0) return;
      if (unzipWarningOnly(result.code, detail) && extractionLooksComplete(destDir)) {
        logger.warn(`Extracted ${path.basename(archivePath)} with filename warnings: ${detail}`);
        return;
      }
      lastErr = result.error || new Error(detail || `unzip exited ${result.code}`);
      if (isIncompleteArchiveError(detail)) break;
    } catch (err) {
      lastErr = err;
    }
  }

  try {
    await extractWithPython(archivePath, destDir);
    if (extractionLooksComplete(destDir)) return;
  } catch (pyErr) {
    lastErr = pyErr;
  }

  try {
    await execFileAsync('tar', ['-xf', archivePath, '-C', destDir], {
      timeout: 180000,
      windowsHide: true,
    });
    if (extractionLooksComplete(destDir)) return;
  } catch (tarErr) {
    lastErr = tarErr;
  }

  if (extractionLooksComplete(destDir)) {
    logger.warn(`Extracted ${path.basename(archivePath)} despite tool warnings`);
    return;
  }
  throw new Error(friendlyExtractError(archivePath, lastErr || { message: 'unknown unzip error' }));
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
  if (!server || server.kind === 'bedrock_connect' || server.kind === 'remote') return;
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
  verifyArchive,
  pickPackIconPath,
  extractPackIconFromArchive,
  isIncompleteArchiveError,
  isFilenameEncodingWarning,
  isUnzipIntegrityFailure,
  friendlyExtractError,
};
