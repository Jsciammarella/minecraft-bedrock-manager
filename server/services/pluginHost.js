const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const logger = require('./logger');
const platform = require('./platform');

const execFileAsync = promisify(execFile);

const BUNDLED_PLUGINS_DIR = path.join(__dirname, '../bundled-plugins');
const USER_PLUGINS_DIR = process.env.MC_MANAGER_USER_PLUGINS_DIR
  || path.join(__dirname, '../../data/plugins');
const PLUGIN_DATA_DIR = process.env.MC_MANAGER_PLUGIN_DATA_DIR
  || path.join(__dirname, '../../data/plugin-data');
const PLUGIN_STATE_PATH = process.env.MC_MANAGER_PLUGIN_STATE_PATH
  || path.join(__dirname, '../../data/plugin-state.json');
const EXAMPLE_PLUGINS_DIR = path.join(__dirname, '../../examples/plugins');
const INVALID_ARCHIVE_MESSAGE = 'The archive is an invalid plugin.';

const ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
const PAGE_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

const RESERVED_PLUGIN_IDS = new Set([
  'api',
  'assets',
  'bedrock-connect',
  'bedrockconnect',
  'catalog',
  'dashboard',
  'health',
  'library',
  'mods',
  'new',
  'players',
  'plugin',
  'plugins',
  'port',
  'ports',
  'properties',
  'sdk',
  'server',
  'servers',
  'settings',
  'static',
  'ui',
  'users',
]);

const CORE_MENU_PATHS = [
  '/',
  '/servers',
  '/servers/new',
  '/mods',
  '/mods/catalog',
  '/mods/catalog/settings',
  '/players',
  '/bedrock-connect',
  '/ports',
  '/plugins',
];

const ALLOWED_ICONS = new Set([
  'activity', 'archive', 'bell', 'box', 'boxes', 'calendar',
  'clock', 'cloud', 'code', 'compass', 'cpu', 'database', 'download',
  'file', 'file-text', 'folder', 'globe', 'hard-drive', 'hash', 'heart',
  'help-circle', 'home', 'info', 'layers', 'library', 'link', 'list',
  'lock', 'map', 'message-square', 'monitor', 'network', 'package',
  'play', 'plus', 'puzzle', 'radio', 'search', 'server', 'settings',
  'shield', 'sparkles', 'star', 'terminal', 'upload',
  'users', 'wrench', 'zap',
]);

const UI_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const CORE_API_ALLOWLIST = [
  /^\/api\/health$/,
  /^\/api\/v1(?:\/|$)/,
  /^\/api\/servers(?:\/|$)/,
  /^\/api\/mods(?:\/|$)/,
  /^\/api\/players(?:\/|$)/,
  /^\/api\/ports(?:\/|$)/,
  /^\/api\/bedrock-connect(?:\/|$)/,
];

let loaded = [];
let backendModules = [];
let lastDirs = null;

function isInsideDir(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function slug(value, fallback) {
  const text = String(value || '').trim().toLowerCase();
  if (ID_RE.test(text)) return text;
  return fallback;
}

function normalizeIcon(value) {
  const icon = String(value || 'puzzle').trim().toLowerCase();
  return ALLOWED_ICONS.has(icon) ? icon : 'puzzle';
}

function parsePages(rawPages, pluginId, pluginName) {
  const source = Array.isArray(rawPages) && rawPages.length
    ? rawPages
    : [{ id: 'home', title: pluginName, file: 'index.html' }];
  const pages = [];
  const seen = new Set();
  source.forEach((row, index) => {
    const id = slug(row && row.id, index === 0 ? 'home' : `page-${index + 1}`);
    if (!PAGE_ID_RE.test(id) || seen.has(id)) return;
    const file = String((row && (row.file || row.entry)) || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!file || file.includes('..') || path.isAbsolute(file)) return;
    seen.add(id);
    pages.push({
      id,
      title: String((row && row.title) || pluginName).trim() || pluginName,
      file,
    });
  });
  if (!pages.length) {
    pages.push({ id: 'home', title: pluginName, file: 'index.html' });
  }
  pages.forEach((page) => {
    page.path = page.id === pages[0].id
      ? `/plugins/${pluginId}`
      : `/plugins/${pluginId}/${page.id}`;
  });
  return pages;
}

function parseMenus(rawManifest, pluginId, pluginName, pages) {
  const source = Array.isArray(rawManifest.menus) && rawManifest.menus.length
    ? rawManifest.menus
    : rawManifest.menu
      ? [rawManifest.menu]
      : [{ label: pluginName, page: pages[0].id }];
  const menus = [];
  const seen = new Set();
  source.forEach((row, index) => {
    const id = slug(row && row.id, index === 0 ? 'main' : `menu-${index + 1}`);
    if (!ID_RE.test(id) || seen.has(id)) return;
    const pageId = slug(row && row.page, pages[0].id);
    const page = pages.find((item) => item.id === pageId) || pages[0];
    const order = Number(row && row.order);
    seen.add(id);
    menus.push({
      id,
      label: String((row && row.label) || pluginName).trim() || pluginName,
      icon: normalizeIcon(row && row.icon),
      order: Number.isFinite(order) ? order : 100 + index,
      pageId: page.id,
      path: page.path,
    });
  });
  if (!menus.length) {
    menus.push({
      id: 'main',
      label: pluginName,
      icon: 'puzzle',
      order: 100,
      pageId: pages[0].id,
      path: pages[0].path,
    });
  }
  return menus;
}

function parseManifest(raw, folderName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'plugin.json must be an object' };
  }
  const id = slug(raw.id, folderName);
  if (!ID_RE.test(id)) {
    return { ok: false, error: 'plugin id must be a lowercase slug' };
  }
  if (id !== folderName) {
    return { ok: false, error: `plugin id "${id}" must match the folder name "${folderName}"` };
  }
  if (RESERVED_PLUGIN_IDS.has(id)) {
    return { ok: false, error: `plugin id "${id}" is reserved` };
  }
  const name = String(raw.name || folderName).trim() || folderName;
  const pages = parsePages(raw.pages, id, name);
  const menus = parseMenus(raw, id, name, pages);
  for (const menu of menus) {
    if (!menu.path.startsWith(`/plugins/${id}`)) {
      return { ok: false, error: 'plugin menu paths must stay under /plugins/<id>' };
    }
    if (CORE_MENU_PATHS.includes(menu.path)) {
      return { ok: false, error: 'plugin menus cannot replace core pages' };
    }
  }
  const enabled = raw.enabled === false ? false : true;
  const backend = raw.backend == null || raw.backend === false
    ? ''
    : String(raw.backend).replace(/\\/g, '/').replace(/^\/+/, '');
  if (backend && (backend.includes('..') || path.isAbsolute(backend))) {
    return { ok: false, error: 'backend path must be a file inside the plugin folder' };
  }
  return {
    ok: true,
    manifest: {
      id,
      name,
      version: String(raw.version || '0.0.0').trim() || '0.0.0',
      description: String(raw.description || '').trim(),
      author: String(raw.author || '').trim(),
      enabled,
      backend,
      pages,
      menus,
    },
  };
}

function defaultPluginDirs() {
  const extras = String(process.env.MC_MANAGER_PLUGIN_DIRS || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const dirs = [...extras, BUNDLED_PLUGINS_DIR, USER_PLUGINS_DIR];
  if (process.env.MC_MANAGER_LOAD_EXAMPLE_PLUGINS === '1') {
    dirs.push(EXAMPLE_PLUGINS_DIR);
  }
  return dirs;
}

function listPluginFolders(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

function publicPlugin(plugin) {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    enabled: plugin.enabled,
    icon: plugin.menus?.[0]?.icon || 'puzzle',
    source: plugin.source,
    menus: plugin.enabled ? plugin.menus : [],
    pages: plugin.enabled ? plugin.pages.map((page) => ({
      id: page.id,
      title: page.title,
      path: page.path,
    })) : [],
    hasBackend: Boolean(plugin.router),
  };
}

function loadBackend(plugin) {
  if (!plugin.enabled || !plugin.backend) return;
  const backendPath = path.resolve(plugin.root, plugin.backend);
  if (!isInsideDir(plugin.root, backendPath) || !fs.existsSync(backendPath)) {
    logger.warn(`Plugin ${plugin.id} backend was not found inside the plugin folder`);
    return;
  }
  const dataDir = path.join(PLUGIN_DATA_DIR, plugin.id);
  fs.mkdirSync(dataDir, { recursive: true });
  const router = express.Router();
  try {
    const resolved = require.resolve(backendPath);
    delete require.cache[resolved];
    const exported = require(resolved);
    const register = typeof exported === 'function' ? exported : exported && exported.register;
    if (typeof register !== 'function') {
      logger.warn(`Plugin ${plugin.id} backend does not export register()`);
      return;
    }
    register({
      id: plugin.id,
      router,
      dataDir,
      logger,
    });
    plugin.router = router;
    backendModules.push(resolved);
  } catch (err) {
    logger.error(`Plugin ${plugin.id} backend failed to load: ${err.message}`);
  }
}

function loadPlugins(dirs = defaultPluginDirs()) {
  fs.mkdirSync(USER_PLUGINS_DIR, { recursive: true });
  fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
  const next = [];
  const seen = new Set();
  for (const dir of dirs) {
    for (const folder of listPluginFolders(dir)) {
      const folderName = path.basename(folder);
      const manifestPath = path.join(folder, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;
      let raw;
      try {
        raw = readJson(manifestPath);
      } catch (err) {
        logger.warn(`Skipping plugin in ${folderName}: invalid plugin.json (${err.message})`);
        continue;
      }
      const parsed = parseManifest(raw, folderName);
      if (!parsed.ok) {
        logger.warn(`Skipping plugin in ${folderName}: ${parsed.error}`);
        continue;
      }
      if (seen.has(parsed.manifest.id)) {
        logger.warn(`Skipping plugin ${parsed.manifest.id} from ${folder}: id already loaded`);
        continue;
      }
      seen.add(parsed.manifest.id);
      const plugin = {
        ...parsed.manifest,
        enabled: isPluginEnabled(parsed.manifest.id, parsed.manifest.enabled),
        root: folder,
        source: path.resolve(dir) === path.resolve(USER_PLUGINS_DIR) ? 'user' : 'bundled',
        router: null,
      };
      loadBackend(plugin);
      next.push(plugin);
      logger.info(`Loaded plugin ${plugin.id} (${plugin.enabled ? 'enabled' : 'disabled'})`);
    }
  }
  lastDirs = dirs;
  loaded = next;
  return getPlugins();
}

function unloadPlugins() {
  for (const file of backendModules) {
    delete require.cache[file];
  }
  backendModules = [];
  loaded = [];
}

function resetForTests() {
  unloadPlugins();
  lastDirs = null;
}

function reloadPlugins() {
  const dirs = lastDirs || defaultPluginDirs();
  unloadPlugins();
  return loadPlugins(dirs);
}

function readEnabledState() {
  try {
    const raw = JSON.parse(fs.readFileSync(PLUGIN_STATE_PATH, 'utf8'));
    return raw && raw.enabled && typeof raw.enabled === 'object' ? raw.enabled : {};
  } catch {
    return {};
  }
}

function writeEnabledState(enabledMap) {
  fs.mkdirSync(path.dirname(PLUGIN_STATE_PATH), { recursive: true });
  fs.writeFileSync(PLUGIN_STATE_PATH, `${JSON.stringify({ enabled: enabledMap }, null, 2)}\n`);
}

function isPluginEnabled(id, manifestEnabled) {
  const state = readEnabledState();
  if (Object.prototype.hasOwnProperty.call(state, id)) return Boolean(state[id]);
  return manifestEnabled !== false;
}

function setPluginEnabled(id, enabled) {
  if (!getPlugin(id)) {
    const err = new Error('Plugin not found');
    err.status = 404;
    throw err;
  }
  const state = readEnabledState();
  state[id] = Boolean(enabled);
  writeEnabledState(state);
  reloadPlugins();
  return publicPlugin(getPlugin(id));
}

function ignoredExtractName(name) {
  const base = String(name || '').trim();
  return !base || base === '__MACOSX' || base === '.DS_Store' || base === 'Thumbs.db' || base.startsWith('.');
}

function pluginRootFromTree(root, { allowRootFiles = false } = {}) {
  if (!root || !fs.existsSync(root)) {
    const err = new Error(INVALID_ARCHIVE_MESSAGE);
    err.status = 400;
    throw err;
  }
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => !ignoredExtractName(entry.name));
  const files = entries.filter((entry) => entry.isFile());
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (allowRootFiles && fs.existsSync(path.join(root, 'plugin.json'))) {
    return root;
  }
  if (files.length || dirs.length !== 1) {
    const err = new Error(INVALID_ARCHIVE_MESSAGE);
    err.status = 400;
    throw err;
  }
  return path.join(root, dirs[0].name);
}

function assertInstallablePlugin(folder) {
  const folderName = path.basename(folder);
  const manifestPath = path.join(folder, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    const err = new Error(INVALID_ARCHIVE_MESSAGE);
    err.status = 400;
    throw err;
  }
  let raw;
  try {
    raw = readJson(manifestPath);
  } catch (cause) {
    const err = new Error(INVALID_ARCHIVE_MESSAGE);
    err.status = 400;
    err.cause = cause;
    throw err;
  }
  const parsed = parseManifest(raw, folderName);
  if (!parsed.ok) {
    const err = new Error(parsed.error || INVALID_ARCHIVE_MESSAGE);
    err.status = 400;
    throw err;
  }
  return parsed.manifest;
}

async function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    await platform.unzipArchive(zipPath, destDir);
    return;
  }
  await execFileAsync('unzip', ['-o', '-qq', zipPath, '-d', destDir], { timeout: 120000 });
}

function copyPluginIntoPlace(sourceFolder, manifest) {
  const dest = path.join(USER_PLUGINS_DIR, manifest.id);
  fs.mkdirSync(USER_PLUGINS_DIR, { recursive: true });
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(sourceFolder, dest, { recursive: true });
  lastDirs = defaultPluginDirs();
  reloadPlugins();
  const loadedPlugin = getPlugin(manifest.id);
  if (!loadedPlugin) {
    const err = new Error('Plugin uploaded but could not be loaded');
    err.status = 400;
    throw err;
  }
  return publicPlugin(loadedPlugin);
}

async function installPluginFromZip(zipPath, { deleteZip = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbm-plugin-'));
  try {
    await extractZip(zipPath, temp);
    const source = pluginRootFromTree(temp, { allowRootFiles: false });
    const manifest = assertInstallablePlugin(source);
    return copyPluginIntoPlace(source, manifest);
  } catch (err) {
    if (!err.status) err.status = 400;
    throw err;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    if (deleteZip) fs.rmSync(zipPath, { force: true });
  }
}

function safeUploadRelPath(originalName) {
  const rel = String(originalName || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return '';
  return rel;
}

function installPluginFromFiles(files) {
  const incoming = (Array.isArray(files) ? files : []).filter(Boolean);
  if (!incoming.length) {
    const err = new Error('No plugin files uploaded');
    err.status = 400;
    throw err;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbm-plugin-'));
  try {
    for (const file of incoming) {
      const rel = safeUploadRelPath(file.originalname);
      if (!rel) continue;
      const dest = path.join(temp, rel);
      if (!isInsideDir(temp, dest) && path.resolve(dest) !== path.resolve(temp)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file.path, dest);
    }
    const source = pluginRootFromTree(temp, { allowRootFiles: true });
    const manifest = assertInstallablePlugin(source);
    return copyPluginIntoPlace(source, manifest);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    for (const file of incoming) {
      try { fs.rmSync(file.path, { force: true }); } catch { /* ignore */ }
    }
  }
}

function getPlugins() {
  return loaded.map(publicPlugin);
}

function getPlugin(id) {
  return loaded.find((plugin) => plugin.id === id) || null;
}

function getMenuItems() {
  return loaded
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.menus.map((menu) => ({
      pluginId: plugin.id,
      ...menu,
    })))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });
}

function resolveUiFile(plugin, requestPath) {
  if (!plugin || !plugin.enabled) return null;
  const uiRoot = path.resolve(plugin.root, 'ui');
  const rel = decodeURIComponent(String(requestPath || '').replace(/^\/+/, ''));
  if (rel.includes('\0') || rel.includes('..')) return null;
  let target = path.resolve(uiRoot, rel || 'index.html');
  if (!isInsideDir(uiRoot, target) && path.resolve(target) !== uiRoot) return null;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, 'index.html');
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  if (!isInsideDir(uiRoot, target)) return null;
  const ext = path.extname(target).toLowerCase();
  if (!UI_MIME[ext]) return null;
  return { filePath: target, mime: UI_MIME[ext], ext };
}

function injectHtmlSdk(html) {
  const source = String(html);
  if (source.includes('/api/plugins/sdk.js')) return source;
  const tag = '<script src="/api/plugins/sdk.js"></script>\n';
  if (/<head[^>]*>/i.test(source)) {
    return source.replace(/<head[^>]*>/i, (open) => `${open}\n${tag}`);
  }
  return `${tag}${source}`;
}

function isAllowedPluginApiPath(pluginId, requestPath) {
  const raw = String(requestPath || '').split('?')[0];
  if (!raw.startsWith('/api/')) return false;
  if (raw.includes('\\') || raw.includes('\0')) return false;
  let pathname;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    return false;
  }
  if (pathname.includes('..')) return false;
  if (pathname === '/api/plugins/upload' || pathname.startsWith('/api/plugins/upload/')) return false;
  const ownPrefix = `/api/plugins/${pluginId}`;
  if (pathname === ownPrefix || pathname.startsWith(`${ownPrefix}/`)) {
    if (pathname === `${ownPrefix}/ui` || pathname.startsWith(`${ownPrefix}/ui/`)) return false;
    if (pathname === `${ownPrefix}/meta` || pathname === `${ownPrefix}/sdk.js`) return false;
    if (pathname === `${ownPrefix}/enabled`) return false;
    return ID_RE.test(pluginId) && !RESERVED_PLUGIN_IDS.has(pluginId);
  }
  if (pathname === '/api/plugins' || pathname === '/api/plugins/') return true;
  return CORE_API_ALLOWLIST.some((re) => re.test(pathname));
}

function isAllowedPluginNavigatePath(pluginId, requestPath) {
  const raw = String(requestPath || '').split('?')[0];
  if (!raw.startsWith(`/plugins/${pluginId}`)) return false;
  if (raw.includes('..') || raw.includes('\\') || raw.includes('\0')) return false;
  return raw === `/plugins/${pluginId}` || raw.startsWith(`/plugins/${pluginId}/`);
}

module.exports = {
  ALLOWED_ICONS,
  BUNDLED_PLUGINS_DIR,
  CORE_MENU_PATHS,
  EXAMPLE_PLUGINS_DIR,
  INVALID_ARCHIVE_MESSAGE,
  PLUGIN_DATA_DIR,
  PLUGIN_STATE_PATH,
  RESERVED_PLUGIN_IDS,
  USER_PLUGINS_DIR,
  defaultPluginDirs,
  getMenuItems,
  getPlugin,
  getPlugins,
  injectHtmlSdk,
  installPluginFromFiles,
  installPluginFromZip,
  isAllowedPluginApiPath,
  isAllowedPluginNavigatePath,
  loadPlugins,
  parseManifest,
  publicPlugin,
  reloadPlugins,
  resetForTests,
  resolveUiFile,
  setPluginEnabled,
};
