const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const db = require('../db/connection');
const logger = require('./logger');
const pluginAudit = require('./pluginAudit');
const controlledDownload = require('./controlledDownload');
const zipGuard = require('./zipGuard');
const javaModMetadata = require('./javaModMetadata');
const catalogModMeta = require('./catalogModMeta');
const modManager = require('./modManager');
const packFiles = require('./packFiles');
const catalogDownloadPolicy = require('./catalogDownloadPolicy');
const { moveFile } = require('./fsMove');

const MODS_DIR = process.env.MC_MANAGER_MODS_DIR
  ? path.resolve(process.env.MC_MANAGER_MODS_DIR)
  : path.join(__dirname, '../../data/mods');
const JAVA_EXTS = new Set(['.jar', '.zip']);

function json(value) {
  return JSON.stringify(value == null ? null : value);
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function resolvedCatalogLoader({ jarLoader, fileLoader, requestedLoader } = {}) {
  const jar = catalogModMeta.normalizeLoader(jarLoader, 'java');
  const file = catalogModMeta.normalizeLoader(fileLoader, 'java');
  const requested = catalogModMeta.normalizeLoader(requestedLoader, 'java');
  if (jar && jar !== 'unknown' && jar !== 'any') return jar;
  if (file && file !== 'unknown' && file !== 'any') return file;
  if (requested && requested !== 'unknown' && requested !== 'any') return requested;
  return jar || file || requested || 'unknown';
}

async function importDownloadPlan(plan, { allowHosts, providerId, loader: requestedLoader } = {}) {
  const project = plan?.project || {};
  const files = Array.isArray(plan?.files) ? plan.files : [];
  if (!files.length) throw new Error('Catalog download did not include a file');
  try {
    catalogDownloadPolicy.assertPlanNotClientOnly(plan, { providerId });
  } catch (err) {
    catalogDownloadPolicy.auditRejectedDownload({
      providerId: providerId || project.providerId,
      projectId: project.curseforgeId || project.slug,
      fileId: err.fileId,
      code: err.code,
    });
    throw err;
  }
  pluginAudit.record('catalog.download.start', {
    targetType: 'catalog-source',
    targetId: providerId || project.providerId || '',
    detail: { slug: project.slug, curseforgeId: project.curseforgeId, files: files.length },
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-catalog-'));
  const stored = [];
  try {
    for (const file of files) {
      const ext = path.extname(file.fileName || file.name || '').toLowerCase();
      if (!JAVA_EXTS.has(ext) && !packFiles.isImportExt(ext)) {
        throw new Error('Catalog file type is not allowed in the Mod Library');
      }
      if (project.edition === 'java' && !JAVA_EXTS.has(ext)) {
        throw new Error('Java catalog downloads must be JAR or ZIP archives');
      }
      const tmpName = modManager.sanitizeFilename(file.fileName || file.name || `${project.slug || 'mod'}${ext || '.jar'}`);
      const tmpPath = path.join(tmpDir, tmpName);
      let downloaded;
      try {
        downloaded = await controlledDownload.downloadToFile({
          url: file.url,
          destination: tmpPath,
          allowHosts,
          sha1: file.sha1,
          maximumBytes: file.maximumBytes,
          project: project.name || project.slug,
          version: file.displayName || file.fileName,
        });
      } catch (err) {
        pluginAudit.record('catalog.download.rejected', {
          targetType: 'catalog-source',
          targetId: providerId || '',
          detail: { error: err.message, slug: project.slug },
        });
        throw err;
      }
      if (JAVA_EXTS.has(ext)) {
        zipGuard.assertSafeZipNames(zipGuard.listStoredZipEntries(tmpPath));
      }
      const destName = modManager.getAvailableFilename(tmpName);
      const dest = path.join(MODS_DIR, destName);
      fs.mkdirSync(MODS_DIR, { recursive: true });
      moveFile(tmpPath, dest);
      stored.push({
        ...file,
        path: dest,
        sha256: downloaded.sha256,
        size: downloaded.bytes,
        name: destName,
      });
    }

    const primary = stored[0];
    let jarMeta = {};
    if (path.extname(primary.path).toLowerCase() === '.jar') {
      jarMeta = javaModMetadata.inspectJar(primary.path);
    } else {
      jarMeta = {
        sha256: crypto.createHash('sha256').update(fs.readFileSync(primary.path)).digest('hex'),
      };
    }
    pluginAudit.record('catalog.checksum', {
      targetType: 'mod',
      targetId: project.slug || '',
      detail: { sha256: jarMeta.sha256 || primary.sha256 },
    });

    const extraFiles = stored.slice(1).map((file) => ({
      path: file.path,
      name: file.name,
      size: file.size,
      kind: packFiles.typeFromExt(file.name || file.path, 'mod'),
    }));
    const extraJson = extraFiles.length ? require('./modArchives').serializeExtraFiles(extraFiles) : null;
    const fileSize = stored.reduce((sum, file) => sum + (file.size || 0), 0);
    const loader = resolvedCatalogLoader({
      jarLoader: jarMeta.loader,
      fileLoader: primary.loader,
      requestedLoader,
    });
    const environment = primary.environment && primary.environment !== 'unknown'
      ? primary.environment
      : (jarMeta.environment || 'unknown');
    const minecraftVersions = (primary.minecraftVersions && primary.minecraftVersions.length)
      ? primary.minecraftVersions
      : (jarMeta.minecraftVersions || []);
    const warning = [
      jarMeta.warning || 'Java mods are executable code. Only install mods you trust.',
      environment === 'client' ? 'This file is marked client-only and may not load on a dedicated server.' : '',
    ].filter(Boolean).join(' ');
    const slug = modManager.getAvailableSlug(project.slug || project.name || path.parse(primary.name).name);
    const metadata = {
      providerId: providerId || project.providerId,
      curseforgeProjectId: project.curseforgeId || null,
      curseforgeFileId: primary.fileId || primary.id || null,
      releaseType: primary.releaseType || 'unknown',
      catalog: true,
    };
    const result = db.prepare(`
      INSERT INTO mods (
        name, slug, type, version, description, author, thumbnail, file_path, file_size, extra_files,
        curseforge_id, source, edition, artifact_type, loader, minecraft_versions, environment,
        dependencies, source_url, license, sha256, metadata_json, warning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.name || slug,
      slug,
      project.artifactType || jarMeta.artifactType || 'mod',
      primary.displayName || jarMeta.version || '1.0.0',
      project.description || '',
      project.author || 'Unknown',
      project.thumbnail || '',
      primary.path,
      fileSize,
      extraJson,
      project.curseforgeId != null ? String(project.curseforgeId) : '',
      project.source || 'curseforge',
      project.edition || 'java',
      project.artifactType || 'mod',
      loader,
      JSON.stringify(minecraftVersions),
      environment,
      json(jarMeta.dependencies || []),
      project.websiteUrl || '',
      jarMeta.license || '',
      jarMeta.sha256 || primary.sha256,
      JSON.stringify(metadata),
      warning
    );
    pluginAudit.record('catalog.library.insert', {
      targetType: 'mod',
      targetId: String(result.lastInsertRowid),
      detail: {
        slug,
        providerId: metadata.providerId,
        sha256: jarMeta.sha256 || primary.sha256,
        loader,
        edition: project.edition || 'java',
      },
    });
    logger.info(`Imported catalog mod ${slug} from ${metadata.providerId || 'catalog'}`);
    return {
      success: true,
      modId: result.lastInsertRowid,
      name: project.name || slug,
      files: stored.map((file) => file.name),
    };
  } catch (err) {
    for (const file of stored) {
      try { if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch { /* ignore */ }
    }
    throw err;
  } finally {
    cleanup(tmpDir);
  }
}

module.exports = {
  importDownloadPlan,
  resolvedCatalogLoader,
};
