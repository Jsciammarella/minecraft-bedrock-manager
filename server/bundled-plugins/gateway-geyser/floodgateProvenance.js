'use strict';

const fs = require('fs');
const path = require('path');
const controlledFs = require('../../services/controlledFs');

const REL = '.mc-manager/geyser-installed-mods.json';

function emptyDoc() {
  return { version: 1, artifacts: [] };
}

function read(serverDir) {
  try {
    const dest = controlledFs.resolveInRoot(serverDir, REL);
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.artifacts)) return emptyDoc();
    return {
      version: 1,
      artifacts: parsed.artifacts.filter((item) => item && typeof item === 'object' && item.filename),
    };
  } catch {
    return emptyDoc();
  }
}

function write(serverDir, doc) {
  controlledFs.writeFileAtomic(serverDir, REL, `${JSON.stringify({
    version: 1,
    artifacts: Array.isArray(doc.artifacts) ? doc.artifacts : [],
  }, null, 2)}\n`);
}

function record(serverDir, artifacts) {
  const doc = read(serverDir);
  const now = new Date().toISOString();
  for (const item of artifacts || []) {
    const next = {
      projectId: item.projectId || '',
      versionId: item.versionId || '',
      versionNumber: item.versionNumber || '',
      minecraftVersion: item.minecraftVersion || '',
      loader: item.loader || '',
      loaderVersion: item.loaderVersion || '',
      filename: item.filename,
      destination: item.destination,
      sha256: item.sha256 || '',
      sourceUrl: item.sourceUrl || item.url || '',
      installedAt: now,
      installedBy: 'gateway-geyser',
      dependency: item.role === 'fabric-api' || item.dependency === true,
      modId: item.modId || '',
    };
    doc.artifacts = doc.artifacts.filter((existing) => (
      existing.destination !== next.destination && existing.filename !== next.filename
    ));
    doc.artifacts.push(next);
  }
  write(serverDir, doc);
  return doc;
}

function findByModId(serverDir, modId) {
  return read(serverDir).artifacts.filter((item) => String(item.modId) === String(modId));
}

function isManagerOwned(serverDir, filenameOrRel) {
  const wanted = String(filenameOrRel || '').replace(/\\/g, '/');
  const base = path.posix.basename(wanted);
  return read(serverDir).artifacts.some((item) => (
    item.filename === base
    || item.destination === wanted
    || path.posix.basename(String(item.destination || '')) === base
  ));
}

function removeByModId(serverDir, modId) {
  const doc = read(serverDir);
  doc.artifacts = doc.artifacts.filter((item) => String(item.modId) !== String(modId));
  write(serverDir, doc);
  return doc;
}

module.exports = {
  REL,
  findByModId,
  isManagerOwned,
  read,
  record,
  removeByModId,
  write,
};
