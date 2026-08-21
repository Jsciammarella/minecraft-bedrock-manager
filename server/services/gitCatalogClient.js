const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const settingsStore = require('./settingsStore');
const modManager = require('./modManager');
const logger = require('./logger');
const db = require('../db/connection');
const packFiles = require('./packFiles');
const platform = require('./platform');
const modArchives = require('./modArchives');

const execFileAsync = promisify(execFile);

const CLONE_DIR = path.join(__dirname, '../../data/git-catalog/repo');
const PACK_EXTS = new Set(packFiles.IMPORT_EXTS);
const META_NAMES = new Set(['mod.json', 'addon.json']);
const TYPE_FROM_EXT = {
  '.mcworld': 'world',
  '.mcpack': 'texture_pack',
  '.mctemplate': 'template',
  '.mcstructure': 'structure',
  '.mcaddon': 'addon',
  '.zip': 'addon',
};
const TYPE_FROM_CLASS = {
  addons: 'addon',
  addon: 'addon',
  'texture-packs': 'texture_pack',
  'texture_pack': 'texture_pack',
  textures: 'texture_pack',
  maps: 'world',
  worlds: 'world',
  world: 'world',
  skins: 'skin',
  skin: 'skin',
  scripts: 'addon',
  templates: 'template',
  template: 'template',
  structures: 'structure',
  structure: 'structure',
};
const CLASS_FROM_TYPE = {
  addon: 'addons',
  texture_pack: 'texture-packs',
  resource_pack: 'texture-packs',
  world: 'maps',
  skin: 'skins',
  template: 'templates',
  structure: 'structures',
};
const CACHE_TTL_MS = 5 * 60 * 1000;
const GIT_FETCH_TIMEOUT_MS = 45 * 60 * 1000;
const GIT_LFS_PULL_TIMEOUT_MS = 45 * 60 * 1000;
const GIT_LFS_CHECKOUT_TIMEOUT_MS = 10 * 60 * 1000;
const SYNC_WAIT_MESSAGE = 'The Git catalog is still syncing. Wait for the sync icon to finish, then try again.';

class GitCatalogClient {
  constructor() {
    this.entriesCache = null;
    this.entriesCachedAt = 0;
    this.syncInFlight = null;
    this.syncStartedAt = null;
    this.syncError = '';
  }

  getConfig() {
    return settingsStore.getGitConfig();
  }

  isConfigured() {
    const config = this.getConfig();
    return Boolean(config.enabled && config.url);
  }

  canSync() {
    const config = this.getConfig();
    return Boolean(config.enabled && config.url && config.token);
  }

  getSyncStatus() {
    let modCount = 0;
    try {
      if (this.isConfigured() && fs.existsSync(CLONE_DIR)) {
        modCount = this.loadEntries().length;
      }
    } catch {
      modCount = 0;
    }
    return {
      running: Boolean(this.syncInFlight),
      startedAt: this.syncStartedAt,
      error: this.syncError || '',
      lastSync: this.getConfig().lastSync || '',
      modCount,
      canSync: this.canSync(),
    };
  }

  startSync(reason = 'manual') {
    if (this.syncInFlight) return this.syncInFlight;
    if (!this.isConfigured()) {
      const err = new Error('Git catalog is not enabled or is missing a repository URL');
      this.syncError = err.message;
      return Promise.reject(err);
    }

    this.syncStartedAt = new Date().toISOString();
    this.syncError = '';
    logger.info(`Git catalog sync starting (${reason})`);
    this.syncInFlight = this.sync()
      .then((result) => {
        this.syncError = '';
        return result;
      })
      .catch((err) => {
        this.syncError = err.message;
        logger.warn(`Git catalog ${reason} sync failed: ${err.message}`);
        throw err;
      })
      .finally(() => {
        this.syncInFlight = null;
        this.syncStartedAt = null;
      });
    return this.syncInFlight;
  }

  catalogRoot(config = this.getConfig()) {
    return this.resolveInside(CLONE_DIR, config.subdir || '.');
  }

  async searchMods(query = '', options = {}) {
    const {
      category = '',
      pageSize = 40,
      page = 1,
      sortBy = 'relevancy',
    } = options;

    if (!this.isConfigured() || !fs.existsSync(CLONE_DIR)) {
      return { results: [], total: 0, page };
    }

    let all;
    try {
      all = this.loadEntries()
        .filter(mod => this.matchesQuery(mod, query))
        .filter(mod => this.matchesCategory(mod, category));
    } catch (err) {
      logger.warn(`Git catalog search skipped while the repository is incomplete: ${err.message}`);
      return { results: [], total: 0, page };
    }

    const sorted = this.sortMods(all, sortBy, query);
    const start = Math.max(0, (page - 1) * pageSize);
    return {
      results: sorted.slice(start, start + pageSize),
      total: sorted.length,
      page,
    };
  }

  getDiscoveredCategories() {
    if (!this.isConfigured() || !fs.existsSync(CLONE_DIR)) return [];
    try {
      const tags = new Set();
      for (const mod of this.loadEntries()) {
        for (const tag of mod.categories || []) {
          if (tag) tags.add(String(tag));
        }
      }
      return [...tags].sort().map(id => ({
        id: this.slugify(id),
        name: this.titleCase(id),
        description: 'From the Git catalog',
        source: 'git',
      }));
    } catch (err) {
      logger.warn(`Could not read Git catalog categories: ${err.message}`);
      return [];
    }
  }

  getMod(slug) {
    return this.loadEntries().find(mod => mod.slug === slug) || null;
  }

  getThumbnailPath(slug) {
    const mod = this.getMod(slug);
    if (!mod?.thumbnailPath) return null;
    const filePath = this.resolveInside(CLONE_DIR, path.relative(CLONE_DIR, mod.thumbnailPath));
    if (!fs.existsSync(filePath) || this.isGitLfsPointer(filePath)) return null;
    return filePath;
  }

  listDownloadFiles(slug) {
    const mod = this.getMod(slug);
    if (!mod) return [];
    return packFiles.fileChoices(this.availablePackPaths(mod));
  }

  availablePackPaths(mod) {
    return (mod.filePaths || (mod.filePath ? [mod.filePath] : []))
      .filter((filePath) => filePath && fs.existsSync(filePath));
  }

  selectedPackPaths(mod, selectedFiles = []) {
    const packPaths = this.availablePackPaths(mod);
    if (!Array.isArray(selectedFiles) || !selectedFiles.length) return packPaths;
    const matched = packPaths.filter((filePath) => packFiles.matchesFileChoice(filePath, selectedFiles));
    if (!matched.length) throw new Error('Select at least one catalog file to download');
    return matched;
  }

  async downloadMod(slug, serverId = null, selectedFiles = []) {
    if (!this.isConfigured()) {
      throw new Error('Git catalog is not configured');
    }
    if (this.syncInFlight) {
      throw new Error(SYNC_WAIT_MESSAGE);
    }
    if (!fs.existsSync(path.join(CLONE_DIR, '.git'))) {
      this.startSync('download').catch(() => {});
      throw new Error(SYNC_WAIT_MESSAGE);
    }
    const mod = this.getMod(slug);
    if (!mod) throw new Error('Mod not found in the Git catalog');
    const packPaths = this.selectedPackPaths(mod, selectedFiles);
    if (!packPaths.length) {
      throw new Error('Catalog entry is missing its downloadable file');
    }
    if (packPaths.some((filePath) => this.isGitLfsPointer(filePath))) {
      this.startSync('download-lfs').catch(() => {});
      throw new Error('This pack is stored in Git LFS and is still syncing. Wait for the catalog sync to finish, then try again.');
    }

    const copied = packPaths.map((filePath) => {
      const filename = modManager.getAvailableFilename(
        modManager.sanitizeFilename(path.basename(filePath))
      );
      const destPath = path.join(__dirname, '../../data/mods', filename);
      fs.copyFileSync(filePath, destPath);
      return destPath;
    });
    const destPath = copied[0];

    let storedSlug = mod.slug;
    const taken = db.prepare('SELECT id, source FROM mods WHERE slug = ?').get(storedSlug);
    if (taken && taken.source !== 'git') {
      storedSlug = modManager.getAvailableSlug(`git-${mod.slug}`);
    }

    const existing = db.prepare('SELECT * FROM mods WHERE source = ? AND slug = ?').get('git', storedSlug)
      || db.prepare('SELECT * FROM mods WHERE source = ? AND slug = ?').get('git', mod.slug);

    const fileSize = copied.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0);
    const extraFiles = modArchives.serializeExtraFiles(modArchives.extraFilesFromPaths(copied, destPath));
    const thumbnail = mod.thumbnail
      || (mod.slug ? `/api/mods/catalog/git/thumbnail/${encodeURIComponent(mod.slug)}` : '');

    if (existing) {
      for (const archive of modArchives.archiveList(existing)) {
        if (archive.path && !copied.includes(archive.path) && fs.existsSync(archive.path)) {
          try { fs.unlinkSync(archive.path); } catch { /* ignore */ }
        }
      }
      db.prepare(`
        UPDATE mods
        SET name = ?, type = ?, version = ?, description = ?, author = ?, thumbnail = ?,
            file_path = ?, file_size = ?, extra_files = ?, downloaded_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        mod.name, mod.type, mod.version || '1.0.0', mod.description || '',
        mod.author || 'Unknown', thumbnail, destPath, fileSize, extraFiles, existing.id
      );
      if (serverId) await modManager.installModToServer(serverId, existing.id);
      logger.info(`Updated Git catalog mod in library: ${mod.slug}`);
      return { success: true, modId: existing.id, name: mod.name };
    }

    const result = db.prepare(`
      INSERT INTO mods (name, slug, type, version, description, author, thumbnail, file_path, file_size, extra_files, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'git')
    `).run(
      mod.name,
      storedSlug,
      mod.type,
      mod.version || '1.0.0',
      mod.description || '',
      mod.author || 'Unknown',
      thumbnail,
      destPath,
      fileSize,
      extraFiles
    );

    if (serverId) await modManager.installModToServer(serverId, result.lastInsertRowid);
    logger.info(`Downloaded mod from Git catalog: ${mod.slug}`);
    return { success: true, modId: result.lastInsertRowid, name: mod.name };
  }

  async testConnection(overrides = {}) {
    const config = { ...this.getConfig(), ...overrides };
    if (!config.url) throw new Error('Repository URL is required');
    this.assertRemoteUrl(config.url);
    await this.assertGitAvailable();

    const remote = this.sshToHttps(config.url);
    const branch = config.branch || 'main';
    const probe = config.token
      ? this.authenticatedUrl(remote, config.username, config.token)
      : remote;
    try {
      const { stdout } = await this.runGit(
        ['ls-remote', '--heads', probe, branch],
        { timeout: 30000, remoteUrl: remote }
      );
      const matched = stdout.trim().length > 0;
      if (!matched) {
        throw new Error(`Branch "${branch}" was not found on the remote`);
      }
      return { success: true, branch, url: this.redactUrl(config.url) };
    } catch (err) {
      throw new Error(this.friendlyGitError(err));
    }
  }

  async ensureFresh(options = {}) {
    const { force = false } = options;
    if (!this.isConfigured()) return { synced: false };
    if (this.syncInFlight) return { synced: false, running: true };
    const cloned = fs.existsSync(path.join(CLONE_DIR, '.git'));
    if (!cloned || force) {
      this.startSync(force ? 'force' : 'ensure-fresh').catch(() => {});
      return { synced: false, running: true };
    }
    return { synced: false, cached: true };
  }

  async sync() {
    const config = this.getConfig();
    if (!config.enabled || !config.url) {
      throw new Error('Git catalog is not enabled or is missing a repository URL');
    }
    this.assertRemoteUrl(config.url);
    await this.assertGitAvailable();

    fs.mkdirSync(path.dirname(CLONE_DIR), { recursive: true });
    const remote = this.sshToHttps(config.url);
    const branch = config.branch || 'main';
    const gitAuth = { token: config.token, username: config.username, remoteUrl: remote };

    try {
      if (fs.existsSync(path.join(CLONE_DIR, '.git'))) {
        await this.runGit(['remote', 'set-url', 'origin', remote], { cwd: CLONE_DIR, ...gitAuth });
        await this.runGit(['fetch', '--depth', '1', 'origin', branch], {
          cwd: CLONE_DIR, timeout: GIT_FETCH_TIMEOUT_MS, ...gitAuth, skipLfsSmudge: true,
        });
        await this.runGit(['checkout', '-B', branch, `origin/${branch}`], {
          cwd: CLONE_DIR, ...gitAuth, skipLfsSmudge: true,
        });
        await this.runGit(['reset', '--hard', `origin/${branch}`], {
          cwd: CLONE_DIR, ...gitAuth, skipLfsSmudge: true,
        });
      } else {
        if (fs.existsSync(CLONE_DIR)) fs.rmSync(CLONE_DIR, { recursive: true, force: true });
        await this.runGit(
          ['clone', '--depth', '1', '--branch', branch, '--single-branch', remote, CLONE_DIR],
          { timeout: GIT_FETCH_TIMEOUT_MS, ...gitAuth, skipLfsSmudge: true }
        );
      }
      await this.pullLfs(gitAuth, remote);
    } catch (err) {
      throw new Error(this.friendlyGitError(err));
    }

    this.entriesCache = null;
    const syncedAt = new Date().toISOString();
    settingsStore.set(settingsStore.KEYS.GIT_LAST_SYNC, syncedAt);
    const entries = this.loadEntries();
    logger.info(`Git catalog synced (${entries.length} mods) from ${this.redactUrl(config.url)}`);
    return { success: true, lastSync: syncedAt, modCount: entries.length };
  }

  async pullLfs(gitAuth, cleanRemote) {
    const pointerCount = () => this.countPointerFiles();
    if (pointerCount() === 0) {
      logger.debug('Catalog repository has no Git LFS pointer files; skipping lfs pull');
      return;
    }

    try {
      await execFileAsync(platform.gitCommand(), ['lfs', 'version'], { timeout: 5000, windowsHide: true });
    } catch {
      throw new Error('This catalog uses Git LFS, but git-lfs is not available to the manager process.');
    }

    const authedRemote = gitAuth.token
      ? this.authenticatedUrl(cleanRemote, gitAuth.username, gitAuth.token)
      : cleanRemote;

    try {
      await this.runGit(['lfs', 'install', '--local'], { cwd: CLONE_DIR, timeout: 15000, ...gitAuth });
      if (authedRemote !== cleanRemote) {
        await this.runGit(['remote', 'set-url', 'origin', authedRemote], { cwd: CLONE_DIR });
      }
      // git-lfs uses its own HTTP client and often ignores http.extraHeader.
      // Pass credentials via origin URL (temporary) and lfs.url for the batch API.
      const lfsUrl = gitAuth.token
        ? `${authedRemote.replace(/\/+$/, '').replace(/\.git$/i, '')}.git/info/lfs`
        : undefined;
      // The authenticated URLs are the credential source for Git LFS. Adding the
      // same Basic header as well makes GitLab reject the request as malformed.
      await this.runGit(['lfs', 'pull'], { cwd: CLONE_DIR, timeout: GIT_LFS_PULL_TIMEOUT_MS, lfsUrl });
      await this.runGit(['lfs', 'checkout'], { cwd: CLONE_DIR, timeout: GIT_LFS_CHECKOUT_TIMEOUT_MS, lfsUrl });
    } catch (err) {
      throw new Error(this.friendlyGitError(err));
    } finally {
      try {
        await this.runGit(['remote', 'set-url', 'origin', cleanRemote], { cwd: CLONE_DIR });
      } catch {
        // Keep the clone usable even if rewriting the remote URL fails.
      }
    }

    const leftover = pointerCount();
    if (leftover > 0) {
      throw new Error(`Git LFS left ${leftover} pointer file(s) in the catalog. The token must be able to download LFS objects, not only Git refs.`);
    }
    logger.info('Git LFS objects downloaded for the catalog');
  }

  countPointerFiles() {
    if (!fs.existsSync(CLONE_DIR)) return 0;
    try {
      return this.walkFiles(CLONE_DIR).filter(file => this.isGitLfsPointer(file)).length;
    } catch {
      return 0;
    }
  }

  authenticatedUrl(url, username, token) {
    const normalized = this.sshToHttps(url);
    if (!token) return normalized;
    try {
      const parsed = new URL(normalized);
      parsed.username = username || 'oauth2';
      parsed.password = token;
      return parsed.toString();
    } catch {
      return normalized;
    }
  }

  // ========== PARSING ==========

  loadEntries() {
    if (this.entriesCache && Date.now() - this.entriesCachedAt < CACHE_TTL_MS) {
      return this.entriesCache;
    }
    if (!fs.existsSync(CLONE_DIR)) return [];
    const entries = this.parseCatalogFromDir(this.catalogRoot());
    this.entriesCache = entries;
    this.entriesCachedAt = Date.now();
    return entries;
  }

  parseCatalogFromDir(rootDir) {
    if (!rootDir || !fs.existsSync(rootDir)) return [];
    const bySlug = new Map();
    const claimedFiles = new Set();
    const claimedDirs = new Set();

    const addEntry = (entry) => {
      if (!entry) return;
      bySlug.set(entry.slug, entry);
      for (const filePath of entry.filePaths || (entry.filePath ? [entry.filePath] : [])) {
        claimedFiles.add(this.normPath(filePath));
      }
    };

    const indexPath = path.join(rootDir, 'catalog.json');
    if (fs.existsSync(indexPath)) {
      for (const entry of this.parseIndexFile(indexPath, rootDir)) {
        addEntry(entry);
      }
    }

    for (const file of this.walkFiles(rootDir)) {
      const name = path.basename(file).toLowerCase();
      if (META_NAMES.has(name) && path.dirname(file) !== rootDir) {
        const entry = this.parseModMetaFile(file, rootDir);
        if (entry) {
          if (!bySlug.has(entry.slug)) addEntry(entry);
          else {
            for (const filePath of entry.filePaths || []) claimedFiles.add(this.normPath(filePath));
          }
          claimedDirs.add(this.normPath(path.dirname(file)));
        }
      }
    }

    const remaining = [];
    for (const file of this.walkFiles(rootDir)) {
      if (!PACK_EXTS.has(path.extname(file).toLowerCase())) continue;
      if (claimedFiles.has(this.normPath(file))) continue;
      if (claimedDirs.has(this.normPath(path.dirname(file)))) continue;
      remaining.push(file);
    }

    const remainingByDir = new Map();
    for (const file of remaining) {
      const dir = path.dirname(file);
      if (!remainingByDir.has(dir)) remainingByDir.set(dir, []);
      remainingByDir.get(dir).push(file);
    }
    for (const [dir, files] of remainingByDir) {
      if (files.length > 1 && !this.isClassOrRootDir(dir, rootDir)) {
        const entry = this.entryFromPackFolder(dir, files, rootDir);
        if (entry && !bySlug.has(entry.slug)) addEntry(entry);
      } else {
        for (const file of files) {
          const entry = this.entryFromPackFile(file, rootDir);
          if (entry && !bySlug.has(entry.slug)) addEntry(entry);
        }
      }
    }

    return [...bySlug.values()];
  }

  parseIndexFile(indexPath, rootDir) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (err) {
      logger.warn(`Invalid catalog.json: ${err.message}`);
      return [];
    }
    const list = Array.isArray(parsed) ? parsed : parsed.mods || parsed.addons || [];
    return list
      .map(item => this.normalizeDeclaredMod(item, rootDir, path.dirname(indexPath)))
      .filter(Boolean);
  }

  parseModMetaFile(metaPath, rootDir) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return this.normalizeDeclaredMod(parsed, rootDir, path.dirname(metaPath));
    } catch (err) {
      logger.warn(`Invalid ${path.basename(metaPath)} at ${metaPath}: ${err.message}`);
      return null;
    }
  }

  collectDeclaredFiles(item) {
    const refs = [];
    const push = (value) => {
      if (value == null || value === '') return;
      if (Array.isArray(value)) {
        value.forEach(push);
        return;
      }
      if (typeof value === 'string' && value.trim()) refs.push(value.trim());
    };
    push(item.file);
    push(item.files);
    push(item.filename);
    push(item.path);
    return refs;
  }

  normalizeDeclaredMod(item, rootDir, baseDir) {
    if (!item || typeof item !== 'object') return null;
    const name = String(item.name || item.title || '').trim();
    const declaredFiles = this.collectDeclaredFiles(item);
    const packPaths = [];
    const seenPacks = new Set();
    for (const rel of declaredFiles) {
      const packPath = this.safeJoin(baseDir, rel) || this.safeJoin(rootDir, rel);
      if (!packPath || seenPacks.has(this.normPath(packPath))) continue;
      seenPacks.add(this.normPath(packPath));
      packPaths.push(packPath);
    }
    if (!packPaths.length) packPaths.push(...this.findPacksInDir(baseDir));
    const packPath = packPaths[0];
    if (!packPath) return null;

    const slug = this.slugify(item.slug || name || path.parse(packPath || '').name);
    if (!slug) return null;

    const projectClass = this.normalizeClass(item.projectClass || item.class || item.type || this.classFromPath(packPath || baseDir, rootDir));
    const type = TYPE_FROM_CLASS[item.type] || TYPE_FROM_CLASS[projectClass] || this.typeFromPath(packPath || baseDir, rootDir);
    const thumbnailRel = item.thumbnail || item.logo || item.image || '';
    const thumbnailPath = thumbnailRel
      ? this.safeJoin(baseDir, thumbnailRel) || this.safeJoin(rootDir, thumbnailRel)
      : this.findThumbnailInDir(baseDir);

    return this.toCatalogMod({
      slug,
      name: name || this.titleCase(slug),
      type,
      projectClass,
      version: String(item.version || '1.0.0'),
      description: String(item.description || item.summary || ''),
      author: String(item.author || item.authors?.[0]?.name || item.authors?.[0] || 'Unknown'),
      categories: this.normalizeCategories(item.categories || item.tags || [projectClass]),
      downloads: Number(item.downloads || 0) || 0,
      dateUpdated: item.updated || item.dateUpdated || this.mtimeIso(packPath || baseDir),
      filePath: packPath,
      filePaths: packPaths,
      thumbnailPath,
      websiteUrl: item.websiteUrl || item.url || '',
    });
  }

  entryFromPackFile(filePath, rootDir) {
    const slug = this.slugify(path.parse(filePath).name);
    if (!slug) return null;
    const projectClass = this.classFromPath(filePath, rootDir);
    const type = this.typeFromPath(filePath, rootDir);
    const folder = path.dirname(filePath);
    return this.toCatalogMod({
      slug,
      name: this.titleCase(path.parse(filePath).name),
      type,
      projectClass,
      version: '1.0.0',
      description: '',
      author: 'Unknown',
      categories: [projectClass],
      downloads: 0,
      dateUpdated: this.mtimeIso(filePath),
      filePath,
      filePaths: [filePath],
      thumbnailPath: this.findThumbnailInDir(folder),
      websiteUrl: '',
    });
  }

  entryFromPackFolder(dir, files, rootDir) {
    const slug = this.slugify(path.basename(dir));
    if (!slug) return null;
    const ordered = this.orderPackFiles(files);
    const packPath = ordered[0];
    const projectClass = this.classFromPath(dir, rootDir);
    const type = this.typeFromPath(packPath, rootDir);
    return this.toCatalogMod({
      slug,
      name: this.titleCase(path.basename(dir)),
      type,
      projectClass,
      version: '1.0.0',
      description: '',
      author: 'Unknown',
      categories: [projectClass],
      downloads: 0,
      dateUpdated: ordered.map((file) => this.mtimeIso(file)).sort().slice(-1)[0] || '',
      filePath: packPath,
      filePaths: ordered,
      thumbnailPath: this.findThumbnailInDir(dir),
      websiteUrl: '',
    });
  }

  toCatalogMod(entry) {
    return {
      id: `git:${entry.slug}`,
      source: 'git',
      name: entry.name,
      slug: entry.slug,
      description: entry.description,
      author: entry.author,
      thumbnail: entry.thumbnailPath
        ? `/api/mods/catalog/git/thumbnail/${encodeURIComponent(entry.slug)}?v=${encodeURIComponent(entry.dateUpdated || '1')}`
        : '',
      thumbnailPath: entry.thumbnailPath || null,
      downloads: entry.downloads,
      dateUpdated: entry.dateUpdated,
      type: entry.type || 'addon',
      categories: entry.categories || [],
      projectClass: entry.projectClass || CLASS_FROM_TYPE[entry.type] || 'addons',
      version: entry.version || '1.0.0',
      websiteUrl: entry.websiteUrl || '',
      filePath: entry.filePath || null,
      filePaths: entry.filePaths || (entry.filePath ? [entry.filePath] : []),
    };
  }

  matchesQuery(mod, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return [mod.name, mod.slug, mod.description, mod.author, ...(mod.categories || [])]
      .join(' ')
      .toLowerCase()
      .includes(q);
  }

  matchesCategory(mod, category) {
    if (!category) return true;
    const requested = String(category).toLowerCase();
    if (mod.projectClass === requested) return true;
    if (TYPE_FROM_CLASS[requested] && mod.type === TYPE_FROM_CLASS[requested]) return true;
    return (mod.categories || []).some((tag) => {
      const value = String(tag).toLowerCase();
      return value === requested || this.slugify(value) === requested;
    });
  }

  sortMods(mods, sortBy, query) {
    const copy = [...mods];
    const score = (mod) => {
      if (!query) return 0;
      const q = query.toLowerCase();
      const name = (mod.name || '').toLowerCase();
      if (name === q) return 100;
      if (name.startsWith(q)) return 80;
      if (name.includes(q)) return 60;
      if ((mod.slug || '').includes(q)) return 50;
      if ((mod.description || '').toLowerCase().includes(q)) return 30;
      if ((mod.author || '').toLowerCase().includes(q)) return 20;
      return 10;
    };

    switch (sortBy) {
      case 'popularity':
      case 'totalDownloads':
        return copy.sort((a, b) => (b.downloads || 0) - (a.downloads || 0) || a.name.localeCompare(b.name));
      case 'lastUpdated':
        return copy.sort((a, b) => new Date(b.dateUpdated || 0) - new Date(a.dateUpdated || 0));
      case 'relevancy':
      default:
        if (!query) return copy.sort((a, b) => a.name.localeCompare(b.name));
        return copy.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
    }
  }

  // ========== GIT HELPERS ==========

  async assertGitAvailable() {
    try {
      await execFileAsync(platform.gitCommand(), ['--version'], { timeout: 5000, windowsHide: true });
    } catch {
      throw new Error(platform.isWindows
        ? 'Git is not available. The Windows installer bundles MinGit under runtime\\git; restart the manager service after install.'
        : 'Git is not installed on this host. Install Git and restart the manager.');
    }
  }

  assertRemoteUrl(url) {
    if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(String(url || '').trim())) {
      throw new Error('Repository URL must be HTTPS or SSH (for example https://gitlab.example.com/group/mod-catalog.git)');
    }
  }

  sshToHttps(url) {
    const ssh = String(url || '').trim().match(/^git@([^:]+):(.+)$/);
    if (ssh) {
      const repo = ssh[2].replace(/\.git$/, '');
      return `https://${ssh[1]}/${repo}.git`;
    }
    const sshUrl = String(url || '').trim().match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
    if (sshUrl) {
      const repo = sshUrl[2].replace(/\.git$/, '');
      return `https://${sshUrl[1]}/${repo}.git`;
    }
    return url;
  }

  redactUrl(url) {
    try {
      const parsed = new URL(this.sshToHttps(url));
      if (parsed.password) parsed.password = '***';
      return parsed.toString();
    } catch {
      return url;
    }
  }

  async runGit(args, options = {}) {
    const { cwd, timeout = 60000, token, username, skipLfsSmudge = false, lfsUrl, remoteUrl } = options;
    const gitArgs = [
      '-c', 'credential.helper=',
      '-c', 'credential.interactive=never',
    ];
    if (token) {
      const basic = Buffer.from(`${username || 'oauth2'}:${token}`, 'utf8').toString('base64');
      const header = `Authorization: Basic ${basic}`;
      try {
        const origin = new URL(this.sshToHttps(remoteUrl || this.getConfig().url || 'https://example.com')).origin;
        gitArgs.push('-c', `http.${origin}/.extraHeader=${header}`);
      } catch {
        gitArgs.push('-c', `http.extraHeader=${header}`);
      }
    }
    if (lfsUrl) {
      gitArgs.push('-c', `lfs.url=${lfsUrl}`);
    }
    gitArgs.push(...args);

    const redactedArgs = gitArgs.map((arg) => {
      let value = String(arg);
      if (value.includes('extraHeader=Authorization:')) {
        value = value.replace(/Authorization: Basic .+$/, 'Authorization: Basic ***');
      }
      return value.replace(/https?:\/\/[^/\s]+@/gi, 'https://***@');
    });
    logger.debug(`git ${redactedArgs.join(' ')}`);

    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_LFS_SKIP_SMUDGE: skipLfsSmudge ? '1' : '0',
    };
    delete env.GIT_ASKPASS;
    delete env.SSH_ASKPASS;

    try {
      return await execFileAsync(platform.gitCommand(), gitArgs, {
        cwd,
        timeout,
        windowsHide: true,
        env,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      const message = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n');
      const wrapped = new Error(message);
      wrapped.killed = err.killed;
      wrapped.code = err.code;
      throw wrapped;
    }
  }

  friendlyGitError(err) {
    const raw = String(err.message || err);
    const text = raw.replace(/https?:\/\/[^/\s]+@/gi, 'https://***@');
    if (/You are not allowed to download code/i.test(text)) {
      return 'GitLab denied code download. Create a personal, project, or deploy token with the read_repository scope. A token that only has read_user cannot clone a private catalog.';
    }
    if (/could not read Username|terminal prompts disabled/i.test(text)) {
      return 'Git could not authenticate without prompting. Paste the access token (or save settings first) and try Test Connection again.';
    }
    if (/HTTP Basic: Access denied|Authentication failed|AUTH_FAILED|invalid credentials|401 Unauthorized/i.test(text)) {
      return 'Git authentication failed. Check the access token, username, and repository URL.';
    }
    if (/not found|Repository not found|404/i.test(text)) {
      return 'Repository not found. Check the URL, branch, and whether the token can see the project.';
    }
    if (err.killed || /ETIMEDOUT|timed out/i.test(text)) {
      return 'Git catalog sync timed out before the repository finished downloading. Use Sync Now and wait for the spinner to stop; large catalogs can take a long time.';
    }
    if (/Could not resolve host|ENOTFOUND|ECONNREFUSED/i.test(text)) {
      return 'Could not reach the Git host. Check the repository URL and network access.';
    }
    if (/\b403\b/.test(text)) {
      return 'The Git host refused access (HTTP 403). For GitLab, the token needs the read_repository scope on this project.';
    }
    if (/This catalog uses Git LFS|Git LFS left|stored in Git LFS/i.test(text)) {
      return text.split('\n').filter(Boolean)[0];
    }
    return text.split('\n').filter(Boolean).slice(-1)[0] || 'Git catalog sync failed';
  }

  // ========== FS HELPERS ==========

  walkFiles(dir, collected = []) {
    if (!fs.existsSync(dir)) return collected;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return collected;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) this.walkFiles(full, collected);
      else collected.push(full);
    }
    return collected;
  }

  findPackInDir(dir) {
    return this.findPacksInDir(dir)[0] || null;
  }

  findPacksInDir(dir) {
    if (!dir || !fs.existsSync(dir)) return [];
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .map((name) => path.join(dir, name))
      .filter((file) => {
        try {
          return fs.statSync(file).isFile() && PACK_EXTS.has(path.extname(file).toLowerCase());
        } catch {
          return false;
        }
      });
  }

  orderPackFiles(files) {
    const rank = { '.mcaddon': 0, '.zip': 1, '.mcpack': 2, '.mcworld': 3, '.mctemplate': 4, '.mcstructure': 5 };
    return [...files].sort((a, b) => {
      const aRank = rank[path.extname(a).toLowerCase()] ?? 9;
      const bRank = rank[path.extname(b).toLowerCase()] ?? 9;
      return aRank - bRank || path.basename(a).localeCompare(path.basename(b));
    });
  }

  isClassOrRootDir(dir, rootDir) {
    const rel = path.relative(rootDir, dir);
    if (!rel || rel === '.') return true;
    const parts = rel.split(path.sep).filter(Boolean);
    return parts.length === 1 && Boolean(TYPE_FROM_CLASS[parts[0].toLowerCase()]);
  }

  findThumbnailInDir(dir) {
    if (!dir || !fs.existsSync(dir)) return null;
    const preferred = ['thumbnail.png', 'thumbnail.jpg', 'thumbnail.jpeg', 'thumbnail.webp', 'logo.png', 'icon.png', 'pack_icon.png'];
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const byLower = new Map(names.map(name => [name.toLowerCase(), name]));
    for (const name of preferred) {
      const actual = byLower.get(name);
      if (!actual) continue;
      const candidate = path.join(dir, actual);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      if (this.isGitLfsPointer(candidate)) continue;
      return candidate;
    }
    return null;
  }

  isGitLfsPointer(filePath) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(64);
      const bytes = fs.readSync(fd, buf, 0, 64, 0);
      fs.closeSync(fd);
      return buf.slice(0, bytes).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1');
    } catch {
      return false;
    }
  }

  normPath(value) {
    return path.resolve(value).replace(/\\/g, '/').toLowerCase();
  }

  classFromPath(targetPath, rootDir) {
    const rel = path.relative(rootDir, targetPath).split(path.sep).map(part => part.toLowerCase());
    for (const part of rel) {
      if (TYPE_FROM_CLASS[part]) return this.normalizeClass(part);
    }
    return CLASS_FROM_TYPE[this.typeFromExt(targetPath)] || 'addons';
  }

  typeFromPath(targetPath, rootDir) {
    const rel = path.relative(rootDir, targetPath).split(path.sep).map(part => part.toLowerCase());
    for (const part of rel) {
      if (TYPE_FROM_CLASS[part]) return TYPE_FROM_CLASS[part];
    }
    return this.typeFromExt(targetPath);
  }

  typeFromExt(filePath) {
    return TYPE_FROM_EXT[path.extname(filePath || '').toLowerCase()] || 'addon';
  }

  normalizeClass(value) {
    const slug = this.slugify(value || '');
    if (TYPE_FROM_CLASS[slug]) {
      const type = TYPE_FROM_CLASS[slug];
      return CLASS_FROM_TYPE[type] || slug;
    }
    return slug || 'addons';
  }

  normalizeCategories(value) {
    const list = Array.isArray(value) ? value : [value];
    return [...new Set(list.map(item => this.slugify(item)).filter(Boolean))];
  }

  slugify(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 100);
  }

  titleCase(value) {
    return String(value || '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase())
      .trim();
  }

  mtimeIso(filePath) {
    try {
      return fs.statSync(filePath).mtime.toISOString();
    } catch {
      return '';
    }
  }

  resolveInside(root, relative) {
    const resolved = path.resolve(root, relative || '.');
    const rel = path.relative(path.resolve(root), resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Invalid catalog path');
    }
    return resolved;
  }

  safeJoin(base, relative) {
    if (!relative) return null;
    try {
      const resolved = this.resolveInside(base, relative);
      return fs.existsSync(resolved) ? resolved : null;
    } catch {
      return null;
    }
  }
}

module.exports = new GitCatalogClient();
