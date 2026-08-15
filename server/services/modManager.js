const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const db = require('../db/connection');
const logger = require('./logger');
const serverManager = require('./serverManager');
const execAsync = promisify(exec);

const MODS_DIR = path.join(__dirname, '../../data/mods');
const THUMBS_DIR = path.join(MODS_DIR, 'thumbs');

class ModManager {
  constructor() {
    fs.mkdirSync(MODS_DIR, { recursive: true });
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
  }

  // ========== MOD LIBRARY ==========

  async uploadMod(file, metadata = {}) {
    const ext = path.extname(file.originalname).toLowerCase();
    const validExts = ['.mcpack', '.mcaddon', '.mcworld', '.zip', '.mctemplate'];
    
    if (!validExts.includes(ext)) {
      throw new Error(`Invalid file type: ${ext}. Allowed: ${validExts.join(', ')}`);
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

    const fileSize = fs.statSync(filePath).size;

    // Determine type from extension
    let type = 'addon';
    if (ext === '.mcworld') type = 'world';
    else if (ext === '.mcpack') type = 'resource_pack';
    else if (ext === '.mctemplate') type = 'template';
    else if (metadata.type) type = metadata.type;

    // Insert into database
    const insert = db.prepare(`
      INSERT INTO mods (name, slug, type, description, file_path, file_size, source)
      VALUES (?, ?, ?, ?, ?, ?, 'upload')
    `);

    const slug = this.getAvailableSlug(metadata.name || safeName);
    let result;
    try {
      result = insert.run(
        metadata.name || safeName,
        slug,
        type,
        metadata.description || '',
        filePath,
        fileSize
      );
    } catch (err) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      throw err;
    }

    logger.info(`Uploaded mod: ${safeName} (${type})`);
    return { id: result.lastInsertRowid, name: metadata.name || safeName, type, filePath };
  }

  async installModToServer(serverId, modId) {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) throw new Error('Server not found');
    if (server.kind === 'bedrock_connect') {
      throw new Error('Bedrock Connect does not support mods');
    }

    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
    if (!mod) throw new Error('Mod not found');

    // Check if already installed
    const existing = db.prepare('SELECT * FROM server_mods WHERE server_id = ? AND mod_id = ?').get(serverId, modId);
    if (existing) throw new Error('Mod already installed on this server');

    // Copy mod to server directory
    const destDir = this.getModDestDir(server.data_path, mod.type);
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, path.basename(mod.file_path));
    fs.copyFileSync(mod.file_path, destPath);

    // Record installation
    db.prepare('INSERT INTO server_mods (server_id, mod_id) VALUES (?, ?)').run(serverId, modId);
    serverManager.markRestartRequired(serverId, 'Mods installed');

    logger.info(`Installed mod ${mod.name} to server ${server.name}`);
    return { success: true };
  }

  async uninstallModFromServer(serverId, modId) {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) throw new Error('Server not found');
    if (server.kind === 'bedrock_connect') {
      throw new Error('Bedrock Connect does not support mods');
    }

    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
    if (!mod) throw new Error('Mod not found');

    // Remove from server directory
    const destDir = this.getModDestDir(server.data_path, mod.type);
    const destPath = path.join(destDir, path.basename(mod.file_path));
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }

    // Remove from database
    db.prepare('DELETE FROM server_mods WHERE server_id = ? AND mod_id = ?').run(serverId, modId);
    serverManager.markRestartRequired(serverId, 'Mods removed');

    logger.info(`Uninstalled mod ${mod.name} from server ${server.name}`);
    return { success: true };
  }

  async getInstalledMods(serverId) {
    return db.prepare(`
      SELECT m.*, sm.installed_at
      FROM mods m
      JOIN server_mods sm ON m.id = sm.mod_id
      WHERE sm.server_id = ?
      ORDER BY sm.installed_at DESC
    `).all(serverId);
  }

  async getAvailableMods(serverId) {
    // Get mods NOT installed on this server
    return db.prepare(`
      SELECT m.*
      FROM mods m
      WHERE m.id NOT IN (
        SELECT mod_id FROM server_mods WHERE server_id = ?
      )
      ORDER BY m.downloaded_at DESC
    `).all(serverId);
  }

  async getAllMods() {
    return db.prepare('SELECT * FROM mods ORDER BY downloaded_at DESC').all();
  }

  async getModById(modId) {
    return db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
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
    db.prepare(`
      UPDATE mods SET description = ?, thumbnail = ? WHERE id = ?
    `).run(description, thumbnail, modId);

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

  async deleteMod(modId) {
    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
    if (!mod) throw new Error('Mod not found');

    // Check if installed on any server
    const installations = db.prepare('SELECT COUNT(*) as count FROM server_mods WHERE mod_id = ?').get(modId);
    if (installations.count > 0) {
      throw new Error('Cannot delete mod that is installed on servers');
    }

    // Delete file
    if (fs.existsSync(mod.file_path)) {
      fs.unlinkSync(mod.file_path);
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
        return path.join(serverPath, 'texture_packs');
      case 'world':
      case 'map':
        return path.join(serverPath, 'worlds');
      case 'template':
        return path.join(serverPath, 'resource_packs');
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

  generateSlug(name) {
    return name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 100);
  }
}

module.exports = new ModManager();
