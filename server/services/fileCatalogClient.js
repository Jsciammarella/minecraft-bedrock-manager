const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const settingsStore = require('./settingsStore');
const gitCatalog = require('./gitCatalogClient');
const modManager = require('./modManager');
const modArchives = require('./modArchives');
const logger = require('./logger');
const db = require('../db/connection');
const platform = require('./platform');
const packFiles = require('./packFiles');

const execFileAsync = promisify(execFile);
const DATA_DIR = path.join(__dirname, '../../data');
const MOUNT_ROOT = path.join(DATA_DIR, 'file-catalog-mounts');

function isDocker() {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

function defaultLocalCatalogDir() {
  const fromEnv = String(process.env.FILE_CATALOG_LOCAL_PATH || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  if (platform.isWindows) {
    const publicRoot = process.env.PUBLIC || 'C:\\Users\\Public';
    const documents = path.join(publicRoot, 'Documents');
    const base = fs.existsSync(documents) ? documents : publicRoot;
    return path.join(base, 'Minecraft Bedrock Manager', 'catalog');
  }
  if (isDocker()) return '/catalog';
  return path.join(DATA_DIR, 'catalog');
}

const LAYOUT_DIRS = ['addons', 'texture-packs', 'maps', 'skins', 'scripts'];
const CACHE_TTL_MS = 30 * 1000;

class FileCatalogClient {
  constructor() {
    this.entriesCache = null;
    this.entriesCachedAt = 0;
  }

  defaultLocalPath() {
    return defaultLocalCatalogDir();
  }

  getConfig() {
    return settingsStore.getFileCatalogConfig();
  }

  isConfigured() {
    return this.activeRoots().length > 0;
  }

  activeRoots() {
    const config = this.getConfig();
    if (!config.enabled) return [];
    const roots = [];
    if (config.local.enabled) {
      roots.push({ kind: 'local', path: config.local.path || this.defaultLocalPath() });
    }
    if (config.smb.enabled && config.smb.path) {
      roots.push({
        kind: 'smb',
        path: config.smb.path,
        username: config.smb.username,
        password: config.smb.password,
      });
    }
    if (config.nfs.enabled && config.nfs.path) {
      roots.push({ kind: 'nfs', path: config.nfs.path });
    }
    return roots;
  }

  ensureDefaultLayout(rootDir = this.defaultLocalPath()) {
    fs.mkdirSync(rootDir, { recursive: true });
    for (const name of LAYOUT_DIRS) {
      fs.mkdirSync(path.join(rootDir, name), { recursive: true });
    }
    return rootDir;
  }

  invalidate() {
    this.entriesCache = null;
    this.entriesCachedAt = 0;
  }

  async prepareRoots() {
    for (const root of this.activeRoots()) {
      if (root.kind === 'local') continue;
      try {
        await this.ensureAccessible(root);
      } catch (err) {
        logger.warn(`File catalog ${root.kind} is not reachable: ${err.message}`);
      }
    }
  }

  async searchMods(query = '', options = {}) {
    await this.prepareRoots();
    const {
      category = '',
      pageSize = 40,
      page = 1,
      sortBy = 'relevancy',
    } = options;
    const all = this.loadEntries()
      .filter((mod) => gitCatalog.matchesQuery(mod, query))
      .filter((mod) => gitCatalog.matchesCategory(mod, category));
    const sorted = gitCatalog.sortMods(all, sortBy, query);
    const start = Math.max(0, (page - 1) * pageSize);
    return {
      results: sorted.slice(start, start + pageSize),
      total: sorted.length,
      page,
    };
  }

  getDiscoveredCategories() {
    const tags = new Set();
    for (const mod of this.loadEntries()) {
      for (const tag of mod.categories || []) {
        if (tag) tags.add(String(tag));
      }
    }
    return [...tags].sort().map((id) => ({
      id: gitCatalog.slugify(id),
      name: gitCatalog.titleCase(id),
      description: 'From the file catalog',
      source: 'file',
    }));
  }

  getMod(slug, fileKind) {
    return this.loadEntries().find((mod) => (
      mod.slug === slug && (!fileKind || mod.fileKind === fileKind)
    )) || null;
  }

  getThumbnailPath(fileKind, slug) {
    const mod = this.getMod(slug, fileKind);
    if (!mod?.thumbnailPath || !fs.existsSync(mod.thumbnailPath)) return null;
    return mod.thumbnailPath;
  }

  loadEntries() {
    if (this.entriesCache && Date.now() - this.entriesCachedAt < CACHE_TTL_MS) {
      return this.entriesCache;
    }
    const entries = [];
    const seen = new Set();
    for (const root of this.activeRoots()) {
      let resolved;
      try {
        resolved = this.resolveRoot(root, { createLocal: root.kind === 'local' });
      } catch (err) {
        logger.warn(`File catalog ${root.kind} skipped: ${err.message}`);
        continue;
      }
      if (!resolved || !fs.existsSync(resolved)) continue;
      for (const entry of gitCatalog.parseCatalogFromDir(resolved)) {
        const mapped = this.toFileEntry(entry, root.kind);
        const key = `${mapped.fileKind}:${mapped.slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(mapped);
      }
    }
    this.entriesCache = entries;
    this.entriesCachedAt = Date.now();
    return entries;
  }

  toFileEntry(entry, fileKind) {
    const stamp = encodeURIComponent(entry.dateUpdated || '1');
    return {
      ...entry,
      id: `file:${fileKind}:${entry.slug}`,
      source: 'file',
      fileKind,
      thumbnail: entry.thumbnailPath
        ? `/api/mods/catalog/file/thumbnail/${encodeURIComponent(fileKind)}/${encodeURIComponent(entry.slug)}?v=${stamp}`
        : '',
    };
  }

  listDownloadFiles(slug, fileKind = '') {
    const mod = this.getMod(slug, fileKind);
    if (!mod) return [];
    return packFiles.fileChoices(this.availablePackPaths(mod));
  }

  availablePackPaths(mod) {
    return (mod.filePaths || []).filter((filePath) => filePath && fs.existsSync(filePath));
  }

  selectedPackPaths(mod, selectedFiles = []) {
    const packPaths = this.availablePackPaths(mod);
    if (!Array.isArray(selectedFiles) || !selectedFiles.length) return packPaths;
    const matched = packPaths.filter((filePath) => packFiles.matchesFileChoice(filePath, selectedFiles));
    if (!matched.length) throw new Error('Select at least one catalog file to download');
    return matched;
  }

  async downloadMod(slug, serverId = null, fileKind = '', selectedFiles = []) {
    if (!this.isConfigured()) {
      throw new Error('File catalog is not configured');
    }
    const mod = this.getMod(slug, fileKind);
    if (!mod) throw new Error('Mod not found in the file catalog');
    const packPaths = this.selectedPackPaths(mod, selectedFiles);
    if (!packPaths.length) {
      throw new Error('Catalog entry is missing its downloadable file');
    }

    const copied = packPaths.map((filePath) => {
      const filename = modManager.getAvailableFilename(
        modManager.sanitizeFilename(path.basename(filePath))
      );
      const destPath = path.join(__dirname, '../../data/mods', filename);
      fs.copyFileSync(filePath, destPath);
      return destPath;
    });

    let storedSlug = mod.slug;
    const taken = db.prepare('SELECT id, source FROM mods WHERE slug = ?').get(storedSlug);
    if (taken && taken.source !== 'file') {
      storedSlug = modManager.getAvailableSlug(`file-${mod.slug}`);
    }

    const existing = db.prepare('SELECT * FROM mods WHERE source = ? AND slug = ?').get('file', storedSlug)
      || db.prepare('SELECT * FROM mods WHERE source = ? AND slug = ?').get('file', mod.slug);
    const fileSize = copied.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0);
    const extraFiles = modArchives.serializeExtraFiles(modArchives.extraFilesFromPaths(copied, copied[0]));
    const thumbnail = mod.thumbnail || '';

    const unlinkOld = (row) => {
      for (const archive of modArchives.archiveList(row)) {
        if (archive.path && !copied.includes(archive.path) && fs.existsSync(archive.path)) {
          try { fs.unlinkSync(archive.path); } catch { /* ignore */ }
        }
      }
    };

    if (existing) {
      unlinkOld(existing);
      db.prepare(`
        UPDATE mods
        SET name = ?, type = ?, version = ?, description = ?, author = ?, thumbnail = ?,
            file_path = ?, file_size = ?, extra_files = ?, downloaded_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        mod.name, mod.type, mod.version || '1.0.0', mod.description || '',
        mod.author || 'Unknown', thumbnail, copied[0], fileSize, extraFiles, existing.id
      );
      if (serverId) await modManager.installModToServer(serverId, existing.id);
      logger.info(`Updated file catalog mod in library: ${mod.slug}`);
      return { success: true, modId: existing.id, name: mod.name };
    }

    const result = db.prepare(`
      INSERT INTO mods (name, slug, type, version, description, author, thumbnail, file_path, file_size, extra_files, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'file')
    `).run(
      mod.name,
      storedSlug,
      mod.type,
      mod.version || '1.0.0',
      mod.description || '',
      mod.author || 'Unknown',
      thumbnail,
      copied[0],
      fileSize,
      extraFiles
    );

    if (serverId) await modManager.installModToServer(serverId, result.lastInsertRowid);
    logger.info(`Downloaded mod from file catalog: ${mod.slug}`);
    return { success: true, modId: result.lastInsertRowid, name: mod.name };
  }

  async testConnection(body = {}) {
    const kind = String(body.kind || 'local').toLowerCase();
    const root = {
      kind,
      path: body.path,
      username: body.username,
      password: body.password,
    };
    const resolved = await this.ensureAccessible(root, { createLocal: kind === 'local' });
    const entries = gitCatalog.parseCatalogFromDir(resolved);
    return {
      ok: true,
      kind,
      path: resolved,
      modCount: entries.length,
    };
  }

  resolveRoot(root, options = {}) {
    if (root.kind === 'local') {
      const resolved = this.resolveLocalPath(root.path);
      if (options.createLocal) this.ensureDefaultLayout(resolved);
      return resolved;
    }
    if (root.kind === 'smb' || root.kind === 'nfs') {
      return this.resolveExistingPath(root);
    }
    throw new Error(`Unknown file catalog kind: ${root.kind}`);
  }

  async ensureAccessible(root, options = {}) {
    if (root.kind === 'local') {
      const resolved = this.resolveRoot(root, options);
      fs.accessSync(resolved, fs.constants.R_OK);
      return resolved;
    }
    if (root.kind === 'smb') {
      return this.ensureSmbPath(root);
    }
    if (root.kind === 'nfs') {
      return this.ensureNfsPath(root);
    }
    throw new Error(`Unknown file catalog kind: ${root.kind}`);
  }

  resolveLocalPath(raw) {
    const value = String(raw || '').trim() || this.defaultLocalPath();
    this.assertSafePath(value);
    if (this.isUncPath(value) || this.isNfsSpec(value)) {
      throw new Error('Use the SMB or NFS settings for network shares');
    }
    if (path.isAbsolute(value)) return path.resolve(value);
    return path.resolve(path.join(DATA_DIR, value));
  }

  resolveExistingPath(root) {
    const value = String(root.path || '').trim();
    if (!value) throw new Error('A path is required');
    this.assertSafePath(value);
    if (this.isNfsSpec(value)) {
      throw new Error('Mount the NFS export on the host, then enter the local mount path');
    }
    if (fs.existsSync(value)) return value;
    throw new Error(`Path is not reachable: ${value}`);
  }

  async ensureSmbPath(root) {
    const value = String(root.path || '').trim();
    if (!value) throw new Error('SMB path is required');
    this.assertSafePath(value);

    if (!this.isUncPath(value) && fs.existsSync(value)) return value;

    if (platform.isWindows) {
      const unc = this.toWindowsUnc(value);
      if (root.username || root.password) {
        await this.connectWindowsShare(unc, root.username, root.password);
      }
      if (!fs.existsSync(unc)) {
        throw new Error(`SMB path is not reachable: ${unc}`);
      }
      return unc;
    }

    if (!this.isUncPath(value) && !value.toLowerCase().startsWith('smb://')) {
      if (fs.existsSync(value)) return value;
      throw new Error(`SMB path is not reachable: ${value}. Bind-mount the share or enter a local mount path.`);
    }

    return this.mountCifs(value, root.username, root.password);
  }

  async ensureNfsPath(root) {
    const value = String(root.path || '').trim();
    if (!value) throw new Error('NFS path is required');
    this.assertSafePath(value);
    if (this.isNfsSpec(value)) {
      return this.mountNfs(value);
    }
    if (!fs.existsSync(value)) {
      throw new Error(`NFS path is not reachable: ${value}. Mount the export on the host, then enter that folder.`);
    }
    return value;
  }

  async connectWindowsShare(unc, username, password) {
    const args = ['use', unc];
    if (password) args.push(password);
    if (username) args.push(`/user:${username}`);
    try {
      await execFileAsync('net', args, { timeout: 20000, windowsHide: true });
    } catch (err) {
      const text = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n');
      if (/already|1202/i.test(text)) return;
      throw new Error(`Could not connect to SMB share: ${text.split('\n').filter(Boolean).slice(-1)[0] || err.message}`);
    }
  }

  async mountCifs(share, username, password) {
    const parsed = this.parseSmb(share);
    const mountPoint = path.join(MOUNT_ROOT, 'smb');
    fs.mkdirSync(mountPoint, { recursive: true });
    if (this.isMounted(mountPoint)) {
      return parsed.subPath ? path.join(mountPoint, parsed.subPath) : mountPoint;
    }
    const options = ['guest'];
    if (username) options[0] = `username=${username}`;
    if (password) options.push(`password=${password}`);
    options.push('vers=3.0', 'uid=0', 'gid=0');
    try {
      await execFileAsync('mount', ['-t', 'cifs', parsed.unc, mountPoint, '-o', options.join(',')], {
        timeout: 20000,
      });
    } catch (err) {
      const text = [err.stderr, err.stdout, err.message].filter(Boolean).join(' ');
      throw new Error(
        `Could not mount SMB share (${text.split('\n').filter(Boolean).slice(-1)[0] || err.message}). `
        + 'On Docker, bind-mount the share into the container and paste that local path instead.'
      );
    }
    const resolved = parsed.subPath ? path.join(mountPoint, parsed.subPath) : mountPoint;
    if (!fs.existsSync(resolved)) {
      throw new Error(`Mounted the SMB share, but ${parsed.subPath || '/'} does not exist on it`);
    }
    return resolved;
  }

  async mountNfs(spec) {
    const mountPoint = path.join(MOUNT_ROOT, 'nfs');
    fs.mkdirSync(mountPoint, { recursive: true });
    if (this.isMounted(mountPoint)) return mountPoint;
    try {
      await execFileAsync('mount', ['-t', 'nfs', spec, mountPoint], { timeout: 20000 });
    } catch (err) {
      const text = [err.stderr, err.stdout, err.message].filter(Boolean).join(' ');
      throw new Error(
        `Could not mount NFS export (${text.split('\n').filter(Boolean).slice(-1)[0] || err.message}). `
        + 'Mount it on the host and enter the local folder path instead.'
      );
    }
    return mountPoint;
  }

  isMounted(mountPoint) {
    try {
      const stat = fs.statSync(mountPoint);
      if (!stat.isDirectory()) return false;
      const entries = fs.readdirSync(mountPoint);
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  parseSmb(value) {
    let normalized = String(value || '').trim().replace(/^smb:/i, '');
    normalized = normalized.replace(/\\/g, '/');
    if (!normalized.startsWith('//')) normalized = `//${normalized.replace(/^\/+/, '')}`;
    const parts = normalized.replace(/^\/\//, '').split('/').filter(Boolean);
    if (parts.length < 2) throw new Error('SMB path must look like \\\\server\\share or //server/share');
    const host = parts[0];
    const share = parts[1];
    const subPath = parts.slice(2).join('/');
    return {
      unc: `//${host}/${share}`,
      subPath,
    };
  }

  toWindowsUnc(value) {
    if (/^[a-zA-Z]:[\\/]/.test(value)) return value;
    const parsed = this.parseSmb(value);
    const rest = parsed.subPath ? `\\${parsed.subPath.replace(/\//g, '\\')}` : '';
    return `\\\\${parsed.unc.replace(/^\/\//, '').replace(/\//g, '\\')}${rest}`;
  }

  isUncPath(value) {
    return /^(\\\\|\/\/|smb:\/\/)/i.test(String(value || '').trim());
  }

  isNfsSpec(value) {
    const text = String(value || '').trim();
    if (/^[a-zA-Z]:[\\/]/.test(text)) return false;
    return /^[A-Za-z0-9._-]+:\//.test(text);
  }

  assertSafePath(value) {
    if (/\0/.test(value)) throw new Error('Invalid path');
    const parts = String(value).split(/[\\/]/);
    if (parts.includes('..')) throw new Error('Catalog path cannot contain ".."');
  }
}

const fileCatalog = new FileCatalogClient();

module.exports = fileCatalog;
