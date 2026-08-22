const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_ARCHIVE_ENTRIES = 8000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function isInsideDir(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertRelative(relPath) {
  const raw = String(relPath || '').replace(/\\/g, '/');
  if (!raw || raw.includes('\0')) {
    throw Object.assign(new Error('Path is required'), { status: 400 });
  }
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('//')) {
    throw Object.assign(new Error('Absolute paths are not allowed'), { status: 400 });
  }
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw Object.assign(new Error('Path traversal is not allowed'), { status: 400 });
  }
  return parts.join('/');
}

function resolveInRoot(root, relPath) {
  const rel = assertRelative(relPath);
  const dest = path.resolve(root, rel);
  if (!isInsideDir(root, dest)) {
    throw Object.assign(new Error('Path escapes the allowed directory'), { status: 400 });
  }
  return dest;
}

function assertNotSymlinkEscape(root, target) {
  let current = target;
  for (let i = 0; i < 12; i += 1) {
    let stat;
    try { stat = fs.lstatSync(current); } catch { return; }
    if (stat.isSymbolicLink()) {
      const next = fs.readlinkSync(current);
      const resolved = path.resolve(path.dirname(current), next);
      if (!isInsideDir(root, resolved)) {
        throw Object.assign(new Error('Symbolic-link escape is not allowed'), { status: 400 });
      }
      current = resolved;
      continue;
    }
    current = path.dirname(current);
    if (!isInsideDir(root, current) && path.resolve(current) !== path.resolve(root)) return;
    if (path.resolve(current) === path.resolve(root)) return;
  }
}

function mkdirp(root, relPath = '.') {
  const dest = relPath === '.' ? path.resolve(root) : resolveInRoot(root, relPath);
  fs.mkdirSync(dest, { recursive: true });
  return dest;
}

function writeFileAtomic(root, relPath, data, { mode } = {}) {
  const dest = resolveInRoot(root, relPath);
  assertNotSymlinkEscape(root, dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, dest);
  if (mode) fs.chmodSync(dest, mode);
  return dest;
}

function copyFileInto(root, relPath, sourcePath) {
  const dest = resolveInRoot(root, relPath);
  assertNotSymlinkEscape(root, dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.copy.tmp`;
  fs.copyFileSync(sourcePath, tmp);
  fs.renameSync(tmp, dest);
  return dest;
}

function readFile(root, relPath, encoding = 'utf8') {
  const dest = resolveInRoot(root, relPath);
  assertNotSymlinkEscape(root, dest);
  return fs.readFileSync(dest, encoding);
}

function remove(root, relPath) {
  const dest = resolveInRoot(root, relPath);
  assertNotSymlinkEscape(root, dest);
  fs.rmSync(dest, { recursive: true, force: true });
}

function exists(root, relPath) {
  try {
    return fs.existsSync(resolveInRoot(root, relPath));
  } catch {
    return false;
  }
}

function scoped(root) {
  const resolvedRoot = path.resolve(root);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  return {
    root: resolvedRoot,
    resolve: (relPath) => resolveInRoot(resolvedRoot, relPath),
    mkdirp: (relPath) => mkdirp(resolvedRoot, relPath),
    writeFileAtomic: (relPath, data, opts) => writeFileAtomic(resolvedRoot, relPath, data, opts),
    copyFileInto: (relPath, sourcePath) => copyFileInto(resolvedRoot, relPath, sourcePath),
    readFile: (relPath, encoding) => readFile(resolvedRoot, relPath, encoding),
    remove: (relPath) => remove(resolvedRoot, relPath),
    exists: (relPath) => exists(resolvedRoot, relPath),
  };
}

function tempDir(prefix = 'mbm-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  assertNotSymlinkEscape,
  assertRelative,
  copyFileInto,
  exists,
  isInsideDir,
  mkdirp,
  readFile,
  remove,
  resolveInRoot,
  scoped,
  tempDir,
  writeFileAtomic,
};
