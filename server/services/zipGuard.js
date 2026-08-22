const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const platform = require('./platform');
const controlledFs = require('./controlledFs');

const execFileAsync = promisify(execFile);

function listStoredZipEntries(filePath) {
  const buf = fs.readFileSync(filePath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65557; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive');
  const entries = buf.readUInt16LE(eocd + 10);
  if (entries > controlledFs.MAX_ARCHIVE_ENTRIES) {
    throw Object.assign(new Error('Archive has too many entries'), { status: 400 });
  }
  let offset = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < entries; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    names.push(name.replace(/\\/g, '/'));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function assertSafeZipNames(names) {
  let totalHint = 0;
  for (const name of names) {
    const normalized = String(name || '').replace(/\\/g, '/');
    if (!normalized) continue;
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.includes('..')) {
      throw Object.assign(new Error(`Malicious archive entry "${normalized}"`), { status: 400 });
    }
    totalHint += 1;
  }
  if (totalHint > controlledFs.MAX_ARCHIVE_ENTRIES) {
    throw Object.assign(new Error('Archive has too many entries'), { status: 400 });
  }
  return names;
}

function inflateEntry(filePath, wanted) {
  const buf = fs.readFileSync(filePath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65557; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOff = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    offset += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;
    if (uncompSize > 2 * 1024 * 1024) {
      throw new Error('Zip entry is too large to inspect');
    }
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const compressed = buf.slice(dataStart, dataStart + compSize);
    if (method === 0) return compressed.toString('utf8');
    if (method === 8) return zlib.inflateRawSync(compressed).toString('utf8');
    throw new Error(`Unsupported zip compression ${method}`);
  }
  return null;
}

function readNamedText(filePath, entryName) {
  const names = assertSafeZipNames(listStoredZipEntries(filePath));
  const wanted = names.find((name) => name === entryName || name.endsWith(`/${entryName}`));
  if (!wanted) return null;
  return inflateEntry(filePath, wanted);
}

async function extractZipSafe(zipPath, destDir) {
  const names = assertSafeZipNames(listStoredZipEntries(zipPath));
  if (fs.statSync(zipPath).size > controlledFs.MAX_ARCHIVE_BYTES) {
    throw Object.assign(new Error('Archive is too large'), { status: 400 });
  }
  fs.mkdirSync(destDir, { recursive: true });
  if (platform.isWindows) {
    await platform.unzipArchive(zipPath, destDir);
    return names;
  }
  await execFileAsync('unzip', ['-o', '-qq', zipPath, '-d', destDir], { timeout: 180000 });
  return names;
}

function looksLikeJar(filePath) {
  return path.extname(filePath || '').toLowerCase() === '.jar';
}

module.exports = {
  assertSafeZipNames,
  extractZipSafe,
  listStoredZipEntries,
  looksLikeJar,
  readNamedText,
};
