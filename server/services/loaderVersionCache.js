'use strict';

const fs = require('fs');
const path = require('path');
const minecraftVersions = require('./minecraftVersions');

const FORMAT = 2;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function cacheFileName({ loader, channel = 'all', format = FORMAT } = {}) {
  const safeLoader = String(loader || 'unknown').replace(/[^a-z0-9-]/gi, '_');
  const safeChannel = String(channel || 'all').replace(/[^a-z0-9-]/gi, '_');
  return `${safeLoader}-versions-v${Number(format) || FORMAT}-${safeChannel}.json`;
}

function cachePath(dir, options) {
  return path.join(dir, cacheFileName(options));
}

function entryIsInvalid(entry) {
  const mc = String(entry?.minecraftVersion || '').trim();
  if (!mc) return true;
  if (minecraftVersions.isFabricatedMinecraftVersion(mc)) return true;
  return false;
}

function catalogIsInvalid(payload, { loader, channel = 'all', format = FORMAT } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true;
  if (Number(payload.format) !== Number(format || FORMAT)) return true;
  if (String(payload.loader || '') !== String(loader || '')) return true;
  if (String(payload.channel || 'all') !== String(channel || 'all')) return true;
  const versions = Array.isArray(payload.versions) ? payload.versions : [];
  if (versions.some(entryIsInvalid)) return true;
  const minecraft = Array.isArray(payload.minecraftVersions) ? payload.minecraftVersions : [];
  if (minecraft.some((item) => minecraftVersions.isFabricatedMinecraftVersion(item))) return true;
  return false;
}

function readCatalog(dir, options = {}) {
  if (!dir) return null;
  const file = cachePath(dir, options);
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (catalogIsInvalid(payload, options)) {
    try { fs.unlinkSync(file); } catch { /* ignore stale cache */ }
    return null;
  }
  const ttl = Number(options.ttlMs || DEFAULT_TTL_MS);
  const fetchedAt = Date.parse(payload.fetchedAt || '') || 0;
  if (ttl > 0 && fetchedAt && Date.now() - fetchedAt > ttl) return null;
  return payload;
}

function writeCatalog(dir, payload, options = {}) {
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    format: options.format || FORMAT,
    loader: String(options.loader || payload.loader || ''),
    channel: String(options.channel || payload.channel || 'all'),
    fetchedAt: new Date().toISOString(),
    versions: Array.isArray(payload.versions) ? payload.versions : [],
    minecraftVersions: Array.isArray(payload.minecraftVersions) ? payload.minecraftVersions : [],
  };
  if (catalogIsInvalid(record, options)) return null;
  fs.writeFileSync(cachePath(dir, options), `${JSON.stringify(record)}\n`);
  return record;
}

function clearCatalog(dir, options = {}) {
  if (!dir) return;
  try { fs.unlinkSync(cachePath(dir, options)); } catch { /* ignore */ }
}

module.exports = {
  DEFAULT_TTL_MS,
  FORMAT,
  cacheFileName,
  cachePath,
  catalogIsInvalid,
  clearCatalog,
  readCatalog,
  writeCatalog,
};
