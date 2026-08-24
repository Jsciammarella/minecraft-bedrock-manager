const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const db = require('../db/connection');
const logger = require('./logger');
const serverManager = require('./serverManager');
const packInstaller = require('./packInstaller');
const packFiles = require('./packFiles');
const execAsync = promisify(exec);
const modArchives = require('./modArchives');
const minecraftVersions = require('./minecraftVersions');

const MODS_DIR = path.join(__dirname, '../../data/mods');
const THUMBS_DIR = path.join(MODS_DIR, 'thumbs');

function parseJavaUploadHints(raw) {
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => ({
    name: item?.name || item?.fileName || '',
    loader: item?.loader || '',
    minecraftVersions: minecraftVersions.parseVersionList(item?.minecraftVersions || item?.versions || item?.minecraft_versions),
    environment: item?.environment || 'unknown',
  }));
}

class ModManager {
  constructor() {
    fs.mkdirSync(MODS_DIR, { recursive: true });
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
  }

  // ========== MOD LIBRARY ==========

  storeUploadedFile(file) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!packFiles.isImportExt(ext)) {
      throw new Error(packFiles.unsupportedMessage(ext));
    }

    const safeName = this.getAvailableFilename(this.sanitizeFilename(file.originalname));
    const filePath = path.join(MODS_DIR, safeName);

    // Disk-backed uploads avoid holding large Bedrock worlds and packs in memory.
    if (file.path) {
      try {
        fs.renameSync(file.path, filePath);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        fs.copyFileSync(file.path, filePath);
        fs.unlinkSync(file.path);
      }
    } else if (file.buffer) {
      fs.writeFileSync(filePath, file.buffer);
    } else {
      throw new Error('Uploaded file data was not available');
    }

    return filePath;
  }

  async uploadMod(fileOrFiles, metadata = {}) {
    const incoming = (Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles]).filter(Boolean);
    if (!incoming.length) throw new Error('No file uploaded');

    const ordered = modArchives.orderArchivePaths(
      incoming.map((file) => ({ file, path: file.originalname }))
    ).map((item) => item.file);
    const unique = [];
    const seen = new Set();
    for (const file of ordered) {
      const key = String(file.originalname || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(file);
    }

    const stored = [];
    try {
      for (const file of unique) {
        const destPath = this.storeUploadedFile(file);
        const ext = path.extname(file.originalname).toLowerCase();
        try {
          if (ext === '.jar') {
            require('./zipGuard').assertSafeZipNames(
              require('./zipGuard').listStoredZipEntries(destPath, { limitEntries: false }),
              { limitEntries: false }
            );
          } else {
            await packInstaller.verifyArchive(destPath);
          }
        } catch (err) {
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          throw err;
        }
        stored.push({
          path: destPath,
          kind: packFiles.typeFromExt(file.originalname, 'addon'),
          size: fs.statSync(destPath).size,
          name: path.basename(destPath),
        });
      }
    } catch (err) {
      for (const item of stored) {
        if (item.path && fs.existsSync(item.path)) {
          try { fs.unlinkSync(item.path); } catch { /* ignore */ }
        }
      }
      throw err;
    }

    const primary = stored[0];
        const extraFiles = stored.length > 1 ? modArchives.serializeExtraFiles(stored.slice(1)) : null;
    const fileSize = stored.reduce((sum, file) => sum + (file.size || 0), 0);
    const edition = String(metadata.edition || '').toLowerCase() === 'java' ? 'java' : (path.extname(primary.path).toLowerCase() === '.jar' ? 'java' : 'bedrock');
    const isJava = edition === 'java';
    const javaModFiles = require('./javaModFiles');
    const javaHints = parseJavaUploadHints(metadata.javaFiles || metadata.filesMeta);
    let javaMeta = {};
    let javaRecords = [];
    if (isJava) {
      javaRecords = stored.map((item, index) => {
        const original = unique[index]?.originalname || item.name;
        const hint = javaHints.find((entry) => String(entry.name || '').toLowerCase() === String(original).toLowerCase())
          || javaHints[index]
          || {};
        const record = javaModFiles.inspectPath(item.path, {
          name: item.name,
          size: item.size,
          loader: hint.loader || metadata.loader,
          minecraftVersions: hint.minecraftVersions,
          environment: hint.environment,
        });
        if ((!record.loader || record.loader === 'unknown' || record.loader === 'any') && hint.loader) {
          record.loader = require('./catalogModMeta').normalizeLoader(hint.loader, 'java') || record.loader;
        }
        if ((!record.minecraftVersions || !record.minecraftVersions.length) && hint.minecraftVersions?.length) {
          record.minecraftVersions = hint.minecraftVersions;
        }
        return record;
      });
      const incomplete = javaRecords.find((record) => (
        !record.loader || record.loader === 'unknown' || record.loader === 'any'
        || !(record.minecraftVersions || []).length
      ));
      if (incomplete) {
        for (const item of stored) {
          if (item.path && fs.existsSync(item.path)) {
            try { fs.unlinkSync(item.path); } catch { /* ignore */ }
          }
        }
        throw Object.assign(new Error('Each Java jar needs a launcher and Minecraft version. Enter that metadata or use a catalog file so it can be parsed.'), { status: 400 });
      }
      try { javaMeta = require('./javaModMetadata').inspectJar(primary.path); } catch {
        javaMeta = { edition: 'java', warning: 'Java mods are executable code. Only install mods you trust.' };
      }
    }
    const type = metadata.type || javaMeta.artifactType || primary.kind || (isJava ? 'mod' : 'addon');
    const displayName = metadata.name || javaMeta.name || path.parse(unique[0].originalname).name || primary.name;

    const insert = db.prepare(`
      INSERT INTO mods (name, slug, type, description, file_path, file_size, extra_files, source,
        edition, artifact_type, loader, minecraft_versions, environment, dependencies, license, sha256, warning, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const slug = this.getAvailableSlug(displayName);
    let result;
    try {
      result = insert.run(
        displayName,
        slug,
        type,
        metadata.description || '',
        primary.path,
        fileSize,
        extraFiles,
        isJava ? 'java' : (javaMeta.edition || 'bedrock'),
        javaMeta.artifactType || type,
        javaRecords[0]?.loader || metadata.loader || javaMeta.loader || 'any',
        JSON.stringify(javaRecords[0]?.minecraftVersions || javaMeta.minecraftVersions || []),
        javaRecords[0]?.environment || javaMeta.environment || 'unknown',
        JSON.stringify(javaMeta.dependencies || []),
        javaMeta.license || '',
        javaMeta.sha256 || javaRecords[0]?.sha256 || '',
        javaMeta.warning || '',
        JSON.stringify(javaMeta.metadata || {})
      );
      if (isJava && javaRecords.length) {
        javaModFiles.persistFiles(result.lastInsertRowid, javaRecords, { jarEnvironment: true });
      }
    } catch (err) {
      for (const item of stored) {
        if (item.path && fs.existsSync(item.path)) {
          try { fs.unlinkSync(item.path); } catch { /* ignore */ }
        }
      }
      throw err;
    }

    await this.attachArchiveThumbnail(result.lastInsertRowid, primary.path);

    logger.info(`Uploaded mod: ${displayName} (${type}, ${stored.length} archive${stored.length === 1 ? '' : 's'})`);
    return { id: result.lastInsertRowid, name: displayName, type, filePath: primary.path };
  }

  async installModToServer(serverId, modId, options = {}) {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) throw new Error('Server not found');
    if (server.kind === 'bedrock_connect' || server.kind === 'remote') {
      throw new Error(server.kind === 'remote'
        ? 'Remote servers do not support mods'
        : 'Bedrock Connect does not support mods');
    }
    if (server.kind === 'java') {
      const result = require('./javaModInstall').install(server, modId, {
        fileSha256: options.fileSha256,
        override: Boolean(options.override),
      });
      if (result.restartRequired) serverManager.markRestartRequired(serverId, 'Java mods changed');
      return { success: true, ...result };
    }

    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
    if (!mod) throw new Error('Mod not found');

    // Check if already installed
    const existing = db.prepare('SELECT * FROM server_mods WHERE server_id = ? AND mod_id = ?').get(serverId, modId);
    if (existing) throw new Error('Mod already installed on this server');

    const archives = modArchives.existingArchives(mod);
    if (!archives.length) throw new Error('Mod archive is missing from the library');
    for (const archive of archives) {
      if (packFiles.isArchiveExt(path.extname(archive.path))) {
        await packInstaller.verifyArchive(archive.path);
      }
    }

    const destDir = this.getModDestDir(server.data_path, mod.type);
    fs.mkdirSync(destDir, { recursive: true });

    let installManifest = [];
    installManifest = await packInstaller.installModToServer(server, mod);

    if (!mod.thumbnail) {
      await this.attachArchiveThumbnail(modId, archives[0].path);
    }

    db.prepare(`
      INSERT INTO server_mods (server_id, mod_id, install_manifest)
      VALUES (?, ?, ?)
    `).run(serverId, modId, JSON.stringify(installManifest));
    packInstaller.syncWorldPackLists(server);
    serverManager.markRestartRequired(serverId, 'Mods installed');

    logger.info(`Installed mod ${mod.name} to server ${server.name}`);
    return { success: true };
  }

  async uninstallModFromServer(serverId, modId) {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) throw new Error('Server not found');
    if (server.kind === 'bedrock_connect' || server.kind === 'remote') {
      throw new Error(server.kind === 'remote'
        ? 'Remote servers do not support mods'
        : 'Bedrock Connect does not support mods');
    }
    if (server.kind === 'java') {
      const row = db.prepare('SELECT id FROM server_mods WHERE server_id = ? AND mod_id = ?').get(serverId, modId);
      if (!row) throw new Error('Mod is not installed on this server');
      const result = require('./javaModInstall').remove(server, row.id);
      if (result.restartRequired) serverManager.markRestartRequired(serverId, 'Java mods changed');
      return { success: true, ...result };
    }

    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
    if (!mod) throw new Error('Mod not found');

    const installation = db.prepare(
      'SELECT install_manifest FROM server_mods WHERE server_id = ? AND mod_id = ?'
    ).get(serverId, modId);
    db.prepare('DELETE FROM server_mods WHERE server_id = ? AND mod_id = ?').run(serverId, modId);
    packInstaller.uninstallModFromServer(server, mod, installation?.install_manifest);
    packInstaller.syncWorldPackLists(server);
    serverManager.markRestartRequired(serverId, 'Mods removed');

    logger.info(`Uninstalled mod ${mod.name} from server ${server.name}`);
    return { success: true };
  }

  async getInstalledMods(serverId) {
    const rows = db.prepare(`
      SELECT m.*, sm.installed_at, sm.installed_file as installedFile,
        sm.compatibility_override as compatibilityOverride
      FROM mods m
      JOIN server_mods sm ON m.id = sm.mod_id
      WHERE sm.server_id = ?
      ORDER BY sm.installed_at DESC
    `).all(serverId);
    return require('./javaModFiles').decorateMany(rows).map((mod) => ({
      ...mod,
      compatibilityOverride: Boolean(mod.compatibilityOverride),
    }));
  }

  async getAvailableMods(serverId) {
    const mods = db.prepare(`
      SELECT m.*
      FROM mods m
      WHERE m.id NOT IN (
        SELECT mod_id FROM server_mods WHERE server_id = ?
      )
      ORDER BY m.downloaded_at DESC
    `).all(serverId);
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    const modCompatibility = require('./modCompatibility');
    return require('./javaModFiles').decorateMany(mods).filter((mod) => modCompatibility.compatibleWithServer(mod, server));
  }

  async getAllMods() {
    return require('./javaModFiles').decorateMany(
      db.prepare('SELECT * FROM mods ORDER BY downloaded_at DESC').all()
    );
  }

  async getModById(modId) {
    const row = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
    return row ? require('./javaModFiles').decorateMany([row])[0] : row;
  }

  async addFilesToMod(modId, fileOrFiles, metadata = {}) {
    const javaModFiles = require('./javaModFiles');
    const catalogModMeta = require('./catalogModMeta');
    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
    if (!mod) throw new Error('Mod not found');
    if (!catalogModMeta.isJavaMod(mod)) {
      throw Object.assign(new Error('Additional jars can only be added to Java mods'), { status: 400 });
    }
    const incoming = (Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles]).filter(Boolean);
    if (!incoming.length) throw new Error('No file uploaded');
    const stored = [];
    try {
      for (const file of incoming) {
        const destPath = this.storeUploadedFile(file);
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.jar' || ext === '.zip') {
          require('./zipGuard').assertSafeZipNames(
            require('./zipGuard').listStoredZipEntries(destPath, { limitEntries: false }),
            { limitEntries: false }
          );
        } else {
          throw new Error('Java mods only accept JAR or ZIP files');
        }
        stored.push({
          path: destPath,
          size: fs.statSync(destPath).size,
          name: path.basename(destPath),
          originalname: file.originalname,
        });
      }
    } catch (err) {
      for (const item of stored) {
        if (item.path && fs.existsSync(item.path)) {
          try { fs.unlinkSync(item.path); } catch { /* ignore */ }
        }
      }
      throw err;
    }
    const hints = parseJavaUploadHints(metadata.javaFiles || metadata.filesMeta);
    const records = stored.map((item, index) => {
      const hint = hints.find((entry) => String(entry.name || '').toLowerCase() === String(item.originalname || '').toLowerCase())
        || hints[index]
        || {};
      const record = javaModFiles.inspectPath(item.path, {
        name: item.name,
        size: item.size,
        loader: hint.loader,
        minecraftVersions: hint.minecraftVersions,
        environment: hint.environment,
      });
      if ((!record.loader || record.loader === 'unknown' || record.loader === 'any') && hint.loader) {
        record.loader = catalogModMeta.normalizeLoader(hint.loader, 'java') || record.loader;
      }
      if ((!record.minecraftVersions || !record.minecraftVersions.length) && hint.minecraftVersions?.length) {
        record.minecraftVersions = hint.minecraftVersions;
      }
      return record;
    });
    const incomplete = records.find((record) => (
      !record.loader || record.loader === 'unknown' || record.loader === 'any'
      || !(record.minecraftVersions || []).length
    ));
    if (incomplete) {
      for (const item of stored) {
        if (item.path && fs.existsSync(item.path)) {
          try { fs.unlinkSync(item.path); } catch { /* ignore */ }
        }
      }
      throw Object.assign(new Error('Each Java jar needs a launcher and Minecraft version.'), { status: 400 });
    }
    javaModFiles.appendFiles(mod, records);
    logger.info(`Added ${records.length} jar(s) to library mod ${mod.name}`);
    return javaModFiles.decorateMany([db.prepare('SELECT * FROM mods WHERE id = ?').get(modId)])[0];
  }

  async deleteModFile(modId, { sha256, name, uninstallFromServers = false } = {}) {
    const javaModFiles = require('./javaModFiles');
    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
    if (!mod) throw new Error('Mod not found');
    const files = javaModFiles.listFiles(mod);
    const target = files.find((file) => (
      (sha256 && file.sha256 === sha256)
      || (name && (file.name === name || path.basename(file.path) === name))
    ));
    if (!target) throw Object.assign(new Error('File not found in this mod'), { status: 404 });
    const usage = javaModFiles.usageForFile(modId, target);
    if (usage.length && !uninstallFromServers) {
      const err = new Error('This file is in use on one or more servers');
      err.status = 409;
      err.code = 'IN_USE';
      err.servers = usage;
      throw err;
    }
    if (usage.length) {
      for (const server of usage) {
        await this.uninstallModFromServer(server.id, modId);
      }
    }
    if (files.length <= 1) {
      return this.deleteMod(modId, { uninstallFromServers: true });
    }
    if (target.path && fs.existsSync(target.path)) {
      try { fs.unlinkSync(target.path); } catch { /* ignore */ }
    }
    const remaining = files.filter((file) => path.resolve(file.path) !== path.resolve(target.path));
    javaModFiles.persistFiles(modId, remaining);
    logger.info(`Removed ${target.name} from library mod ${mod.name}`);
    return javaModFiles.decorateMany([db.prepare('SELECT * FROM mods WHERE id = ?').get(modId)])[0];
  }

  async updateMod(modId, metadata = {}, thumbnailFile = null) {
    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
    if (!mod) throw new Error('Mod not found');

    let thumbnail = mod.thumbnail || '';
    if (metadata.clearThumbnail) {
      this.removeLocalThumbnail(thumbnail);
      thumbnail = '';
    }
    if (thumbnailFile) {
      const ext = path.extname(thumbnailFile.originalname || thumbnailFile.filename || '').toLowerCase() || '.png';
      const destName = this.getAvailableThumbName(modId, ext);
      const destPath = path.join(THUMBS_DIR, destName);
      if (thumbnailFile.path) {
        try {
          fs.renameSync(thumbnailFile.path, destPath);
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          fs.copyFileSync(thumbnailFile.path, destPath);
          fs.unlinkSync(thumbnailFile.path);
        }
      } else if (thumbnailFile.buffer) {
        fs.writeFileSync(destPath, thumbnailFile.buffer);
      } else {
        throw new Error('Thumbnail image data was not available');
      }
      this.removeLocalThumbnail(mod.thumbnail);
      thumbnail = destPath;
    }

    const description = metadata.description != null ? String(metadata.description) : (mod.description || '');
    const catalogModMeta = require('./catalogModMeta');
    let loader = mod.loader || 'any';
    if (metadata.loader != null && catalogModMeta.isJavaMod(mod)) {
      loader = catalogModMeta.normalizeLoader(metadata.loader, 'java');
    }
    db.prepare(`
      UPDATE mods SET description = ?, thumbnail = ?, loader = ? WHERE id = ?
    `).run(description, thumbnail, loader, modId);

    logger.info(`Updated library mod ${mod.name}`);
    return db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
  }

  getThumbnailFilePath(modId) {
    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
    if (!mod || !this.isLocalThumbnail(mod.thumbnail)) return null;
    if (!fs.existsSync(mod.thumbnail)) return null;
    return mod.thumbnail;
  }

  isLocalThumbnail(value) {
    if (!value) return false;
    const text = String(value);
    if (/^https?:\/\//i.test(text) || text.startsWith('/api/')) return false;
    try {
      const resolved = path.resolve(text);
      const rel = path.relative(path.resolve(THUMBS_DIR), resolved);
      return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
    } catch {
      return false;
    }
  }

  removeLocalThumbnail(value) {
    if (!this.isLocalThumbnail(value)) return;
    try {
      if (fs.existsSync(value)) fs.unlinkSync(value);
    } catch {
      // ignore cleanup failures
    }
  }

  async attachArchiveThumbnail(modId, archivePath) {
    if (!archivePath || !fs.existsSync(archivePath)) return null;
    try {
      const destPath = await packInstaller.extractPackIconFromArchive(
        archivePath,
        THUMBS_DIR,
        `packicon-${modId}`
      );
      if (!destPath) return null;
      db.prepare('UPDATE mods SET thumbnail = ? WHERE id = ?').run(destPath, modId);
      logger.info(`Attached pack icon for library mod ${modId}`);
      return destPath;
    } catch (err) {
      logger.warn(`Could not extract pack icon for mod ${modId}: ${err.message}`);
      return null;
    }
  }

  getAvailableThumbName(modId, ext) {
    const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) ? ext : '.png';
    let candidate = `${modId}${safeExt}`;
    let suffix = 2;
    while (fs.existsSync(path.join(THUMBS_DIR, candidate))) {
      candidate = `${modId}-${suffix}${safeExt}`;
      suffix += 1;
    }
    return candidate;
  }

  async deleteMod(modId, { uninstallFromServers = false } = {}) {
    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
    if (!mod) throw new Error('Mod not found');

    const installations = db.prepare(`
      SELECT s.id, s.name
      FROM server_mods sm
      JOIN servers s ON s.id = sm.server_id
      WHERE sm.mod_id = ?
      ORDER BY s.name COLLATE NOCASE
    `).all(modId);

    if (installations.length > 0) {
      if (!uninstallFromServers) {
        throw new Error(
          `Cannot delete mod that is installed on ${installations.length} server${installations.length === 1 ? '' : 's'}`
        );
      }
      for (const server of installations) {
        await this.uninstallModFromServer(server.id, modId);
      }
    }

    // Delete file
    for (const archive of modArchives.archiveList(mod)) {
      if (archive.path && fs.existsSync(archive.path)) {
        try { fs.unlinkSync(archive.path); } catch { /* ignore */ }
      }
    }
    this.removeLocalThumbnail(mod.thumbnail);

    // Remove from database
    db.prepare('DELETE FROM mods WHERE id = ?').run(modId);

    logger.info(`Deleted mod: ${mod.name}`);
    return { success: true };
  }

  // ========== HELPERS ==========

  getModDestDir(serverPath, type) {
    switch (type) {
      case 'addon':
      case 'behavior_pack':
        return path.join(serverPath, 'behavior_packs');
      case 'resource_pack':
      case 'texture_pack':
        return path.join(serverPath, 'resource_packs');
      case 'world':
      case 'map':
        return path.join(serverPath, 'worlds');
      case 'template':
        return path.join(serverPath, 'worlds');
      case 'structure':
        return path.join(serverPath, 'worlds');
      default:
        return path.join(serverPath, 'behavior_packs');
    }
  }

  sanitizeFilename(filename) {
    return path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  getAvailableFilename(filename) {
    const parsed = path.parse(filename);
    let candidate = filename;
    let suffix = 2;
    while (fs.existsSync(path.join(MODS_DIR, candidate))) {
      candidate = `${parsed.name}-${suffix}${parsed.ext}`;
      suffix += 1;
    }
    return candidate;
  }

  getAvailableSlug(name) {
    const base = this.generateSlug(name) || 'uploaded-mod';
    let candidate = base;
    let suffix = 2;
    while (db.prepare('SELECT 1 FROM mods WHERE slug = ?').get(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  getInstalledModIdsByServer() {
    const rows = db.prepare('SELECT server_id, mod_id FROM server_mods').all();
    const byServer = {};
    for (const row of rows) {
      const serverId = String(row.server_id);
      if (!byServer[serverId]) byServer[serverId] = [];
      byServer[serverId].push(row.mod_id);
    }
    return byServer;
  }

  generateSlug(name) {
    return name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 100);
  }
}

module.exports = new ModManager();
