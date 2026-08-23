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
        zipGuard.assertSafeZipNames(
          zipGuard.listStoredZipEntries(tmpPath, { limitEntries: false }),
          { limitEntries: false }
        );
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

    const javaModFiles = require('./javaModFiles');
    const records = stored.map((file) => javaModFiles.inspectPath(file.path, {
      name: file.name,
      size: file.size,
      sha256: file.sha256,
      loader: resolvedCatalogLoader({
        fileLoader: file.loader,
        requestedLoader,
      }),
      minecraftVersions: file.minecraftVersions,
      environment: file.environment,
      curseforgeFileId: file.fileId || file.id,
      version: file.displayName || file.version,
    }));
    const existing = javaModFiles.findExistingLibraryMod(project);
    if (existing) {
      if (!existing.curseforge_id && project.curseforgeId != null && project.curseforgeId !== '') {
        try {
          db.prepare('UPDATE mods SET curseforge_id = ? WHERE id = ?').run(String(project.curseforgeId), existing.id);
        } catch {
          /* unique conflict is fine; the row already matches */
        }
      }
      const { added } = javaModFiles.appendFiles(existing, records);
      pluginAudit.record('catalog.library.merge', {
        targetType: 'mod',
        targetId: String(existing.id),
        detail: {
          slug: existing.slug,
          added: added.map((file) => file.name),
          providerId: providerId || project.providerId,
        },
      });
      logger.info(`Added ${added.length} file(s) to library mod ${existing.slug}`);
      return {
        success: true,
        merged: true,
        modId: existing.id,
        name: existing.name,
        files: stored.map((file) => file.name),
        added: added.map((file) => file.name),
      };
    }

    const primaryRecord = records[0];
    const loader = resolvedCatalogLoader({
      jarLoader: jarMeta.loader,
      fileLoader: primary.loader,
      requestedLoader,
    }) || primaryRecord.loader;
    const environment = primaryRecord.environment && primaryRecord.environment !== 'unknown'
      ? primaryRecord.environment
      : (jarMeta.environment || 'unknown');
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
      primary.size || 0,
      null,
      project.curseforgeId != null ? String(project.curseforgeId) : '',
      project.source || 'curseforge',
      project.edition || 'java',
      project.artifactType || 'mod',
      loader,
      JSON.stringify(primaryRecord.minecraftVersions || []),
      environment,
      json(jarMeta.dependencies || []),
      project.websiteUrl || '',
      jarMeta.license || '',
      jarMeta.sha256 || primary.sha256,
      JSON.stringify(metadata),
      warning
    );
    javaModFiles.persistFiles(result.lastInsertRowid, records);
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
    const unique = /UNIQUE constraint failed/i.test(String(err.message || ''));
    if (unique) {
      const javaModFiles = require('./javaModFiles');
      const existing = javaModFiles.findExistingLibraryMod(plan?.project || {});
      if (existing) {
        try {
          const records = stored.map((file) => javaModFiles.inspectPath(file.path, {
            name: file.name,
            size: file.size,
            sha256: file.sha256,
            loader: file.loader,
            minecraftVersions: file.minecraftVersions,
            environment: file.environment,
            curseforgeFileId: file.fileId || file.id,
            version: file.displayName || file.version,
          }));
          javaModFiles.appendFiles(existing, records);
          return {
            success: true,
            merged: true,
            modId: existing.id,
            name: existing.name,
            files: stored.map((file) => file.name),
          };
        } catch {
          /* fall through to cleanup */
        }
      }
    }
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
