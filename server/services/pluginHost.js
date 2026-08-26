const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const logger = require('./logger');
const platform = require('./platform');
const pluginCapabilities = require('./pluginCapabilities');
const pluginAudit = require('./pluginAudit');

const execFileAsync = promisify(execFile);

const BUNDLED_PLUGINS_DIR = process.env.MC_MANAGER_BUNDLED_PLUGINS_DIR
  || path.join(__dirname, '../bundled-plugins');
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
const PERM_LOCAL_RE = /^[a-z][a-z0-9_-]{0,62}$/;

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
  'gateways',
  'gateway',
  'java',
]);

const CORE_MENU_PATHS = [
  '/',
  '/servers',
  '/servers/new',
  '/mods',
  '/mods/catalog',
  '/mods/catalog/settings',
  '/players',
  '/ports',
  '/plugins',
  '/gateways',
];

const ALLOWED_NATIVE_CORE_PATHS = new Set([
  '/bedrock-connect',
]);

const FIRST_PARTY_PERM_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const RISK_LEVELS = new Set(['read', 'normal', 'elevated', 'destructive', 'administrator-only']);
const CORE_PERM_PREFIXES = [
  'dashboard.',
  'servers.',
  'catalog.',
  'library.',
  'players.',
  'ports.',
  'plugins.',
  'users.',
  'groups.',
  'permissions.',
  'security.',
  'account.',
  'bedrock_connect.',
  'menu.',
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

function parsePages(rawPages, pluginId, pluginName, { source = 'user' } = {}) {
  if (Array.isArray(rawPages) && rawPages.length === 0) return { ok: true, pages: [] };
  const sourcePages = Array.isArray(rawPages) && rawPages.length
    ? rawPages
    : [{ id: 'home', title: pluginName, file: 'index.html' }];
  const pages = [];
  const seen = new Set();
  for (const [index, row] of sourcePages.entries()) {
    const id = slug(row && row.id, index === 0 ? 'home' : `page-${index + 1}`);
    if (!PAGE_ID_RE.test(id) || seen.has(id)) continue;
    const renderer = String((row && row.renderer) || '').trim().toLowerCase();
    if (renderer === 'native-settings') {
      if (source !== 'bundled') {
        return { ok: false, error: 'native-settings pages are limited to bundled first-party plugins' };
      }
      seen.add(id);
      pages.push({
        id,
        title: String((row && row.title) || pluginName).trim() || pluginName,
        renderer: 'native-settings',
        file: '',
      });
      continue;
    }
    if (renderer === 'native-core') {
      if (source !== 'bundled') {
        return { ok: false, error: 'native-core pages are limited to bundled first-party plugins' };
      }
      const corePath = String((row && row.path) || '').trim();
      if (!ALLOWED_NATIVE_CORE_PATHS.has(corePath)) {
        return { ok: false, error: `native-core path "${corePath}" is not allowed` };
      }
      seen.add(id);
      pages.push({
        id,
        title: String((row && row.title) || pluginName).trim() || pluginName,
        renderer: 'native-core',
        file: '',
        path: corePath,
      });
      continue;
    }
    if (renderer && renderer !== 'iframe') {
      return { ok: false, error: `unsupported page renderer "${renderer}"` };
    }
    const file = String((row && (row.file || row.entry)) || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!file || file.includes('..') || path.isAbsolute(file)) continue;
    seen.add(id);
    pages.push({
      id,
      title: String((row && row.title) || pluginName).trim() || pluginName,
      renderer: 'iframe',
      file,
    });
  }
  if (!pages.length) {
    pages.push({ id: 'home', title: pluginName, renderer: 'iframe', file: 'index.html' });
  }
  pages.forEach((page) => {
    if (page.path) return;
    page.path = page.renderer === 'native-settings'
      ? `/plugins/${pluginId}/${page.id}`
      : page.id === pages[0].id
        ? `/plugins/${pluginId}`
        : `/plugins/${pluginId}/${page.id}`;
  });
  return { ok: true, pages };
}

function parseMenus(rawManifest, pluginId, pluginName, pages) {
  if (!pages.length) return [];
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
    const permission = String((row && row.permission) || '').trim().toLowerCase();
    menus.push({
      id,
      label: String((row && row.label) || pluginName).trim() || pluginName,
      icon: normalizeIcon(row && row.icon),
      order: Number.isFinite(order) ? order : 100 + index,
      pageId: page.id,
      path: page.path,
      renderer: page.renderer || 'iframe',
      permission: permission || '',
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
      renderer: pages[0].renderer || 'iframe',
      permission: '',
    });
  }
  return menus;
}

function knownCategoryIds(pluginCategories) {
  const ids = new Set(['plugin']);
  try {
    const catalog = require('./permissionCatalog');
    for (const item of catalog.CATEGORIES || []) ids.add(item.id);
  } catch {
    /* catalog optional during parse */
  }
  for (const item of pluginCategories || []) {
    const id = String(item?.id || item || '').trim();
    if (id) ids.add(id);
  }
  return ids;
}

function pluginOwnsDeclaredKey(pluginId, key, pluginSource) {
  try {
    const catalog = require('./permissionCatalog');
    if (typeof catalog.pluginOwnsKey === 'function') return catalog.pluginOwnsKey(pluginId, key);
    return catalog.permissionByKey(key)?.pluginId === pluginId;
  } catch {
    return pluginSource === 'bundled' && String(key).startsWith('bedrock_connect.');
  }
}

function isCoreNamespaceKey(key) {
  return CORE_PERM_PREFIXES.some((prefix) => String(key).startsWith(prefix));
}

function normalizePluginPermission(row, pluginId, pluginName, pluginSource, categoryIds, seen) {
  let local = String(row.key || '').trim().toLowerCase();
  const prefix = `plugin.${pluginId}.`;
  if (local.startsWith(prefix)) local = local.slice(prefix.length);
  const ownedFirstParty = pluginSource === 'bundled'
    && FIRST_PARTY_PERM_RE.test(local)
    && local.includes('.')
    && pluginOwnsDeclaredKey(pluginId, local, pluginSource);
  if (!ownedFirstParty && (local.includes('.') || isCoreNamespaceKey(local) || isCoreNamespaceKey(`${prefix}${local}`))) {
    if (pluginSource === 'bundled' && isCoreNamespaceKey(local)) {
      return { ok: false, error: `plugin ${pluginId} cannot impersonate core permission "${local}"` };
    }
    logger.warn(`Plugin ${pluginId} skipped permission "${row.key || ''}": plugin permissions cannot override platform permissions`);
    return { ok: true, permission: null };
  }
  const description = String(row.description || '').trim();
  if (!description) {
    return { ok: false, error: `permission "${row.key || ''}" is missing a description` };
  }
  const riskLevel = String(row.riskLevel || row.risk || 'normal').trim() || 'normal';
  if (!RISK_LEVELS.has(riskLevel)) {
    return { ok: false, error: `permission "${row.key || ''}" has an invalid risk level` };
  }
  if (riskLevel === 'administrator-only' && pluginSource !== 'bundled') {
    return { ok: false, error: 'untrusted plugins cannot declare administrator-only permissions' };
  }
  const displayName = String(row.displayName || row.name || local).trim() || local;
  const primaryCategory = String(row.primaryCategory || row.category || 'plugin').trim() || 'plugin';
  if (!categoryIds.has(primaryCategory)) {
    return { ok: false, error: `permission "${row.key || ''}" uses unknown category "${primaryCategory}"` };
  }
  const subcategory = row.subcategory ? String(row.subcategory).trim() : null;
  const assignableToUsers = riskLevel === 'administrator-only' ? false : row.assignableToUsers !== false;
  const assignableToGroups = riskLevel === 'administrator-only' ? false : row.assignableToGroups !== false;
  if (ownedFirstParty) {
    if (seen.has(local)) return { ok: false, error: `duplicate permission key "${local}"` };
    seen.add(local);
    return {
      ok: true,
      permission: {
        key: local,
        localKey: local,
        name: displayName,
        displayName,
        description,
        category: primaryCategory,
        primaryCategory,
        subcategory,
        riskLevel,
        assignableToUsers,
        assignableToGroups,
        pluginId,
        source: 'first-party-plugin',
      },
    };
  }
  if (!local || !PERM_LOCAL_RE.test(local)) return { ok: true, permission: null };
  if (seen.has(local) || seen.has(`${prefix}${local}`)) {
    return { ok: false, error: `duplicate permission key "${local}"` };
  }
  seen.add(local);
  return {
    ok: true,
    permission: {
      key: `${prefix}${local}`,
      localKey: local,
      name: displayName,
      displayName,
      description,
      category: 'plugin',
      primaryCategory: 'plugin',
      subcategory,
      riskLevel,
      assignableToUsers,
      assignableToGroups,
      pluginId,
      source: pluginSource === 'bundled' ? 'first-party-plugin' : 'third-party-plugin',
    },
  };
}

function parsePermissions(rawPermissions, pluginId, pluginName, { source: pluginSource = 'user', categories = [] } = {}) {
  const source = Array.isArray(rawPermissions) ? rawPermissions : [];
  const permissions = [];
  const seen = new Set();
  const categoryIds = knownCategoryIds(categories);
  for (const row of source) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const parsed = normalizePluginPermission(row, pluginId, pluginName, pluginSource, categoryIds, seen);
    if (!parsed.ok) return parsed;
    if (parsed.permission) permissions.push(parsed.permission);
  }
  return { ok: true, permissions };
}

function attachOwnedCatalogPermissions(permissions) {
  return permissions;
}

function parseManifest(raw, folderName, { source = 'user' } = {}) {
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
  const parsedPages = parsePages(raw.pages, id, name, { source });
  if (!parsedPages.ok) return parsedPages;
  const pages = parsedPages.pages;
  const menus = parseMenus(raw, id, name, pages);
  const parsedPerms = parsePermissions(raw.permissions, id, name, {
    source,
    categories: raw.categories || raw.permissionCategories || [],
  });
  if (!parsedPerms.ok) return parsedPerms;
  const permissions = attachOwnedCatalogPermissions(parsedPerms.permissions, id, source);
  for (const menu of menus) {
    const page = pages.find((item) => item.id === menu.pageId);
    if (page && page.renderer === 'native-core') {
      if (!ALLOWED_NATIVE_CORE_PATHS.has(menu.path)) {
        return { ok: false, error: 'native-core menus must use an allowed core path' };
      }
      continue;
    }
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
  const caps = pluginCapabilities.parseCapabilities(raw.capabilities, source);
  if (!caps.ok) return caps;
  const downloadHosts = source === 'bundled' && Array.isArray(raw.downloadHosts)
    ? raw.downloadHosts.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
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
      permissions,
      capabilities: caps.capabilities,
      rejectedPrivileged: caps.rejectedPrivileged,
      downloadHosts,
      providers: Array.isArray(raw.providers) ? raw.providers : [],
      permissionCategories: Array.isArray(raw.permissionCategories || raw.categories)
        ? (raw.permissionCategories || raw.categories)
        : [],
      permissionSubcategories: Array.isArray(raw.permissionSubcategories || raw.subcategories)
        ? (raw.permissionSubcategories || raw.subcategories)
        : [],
      fieldMappings: raw.fieldMappings && typeof raw.fieldMappings === 'object' && !Array.isArray(raw.fieldMappings)
        ? raw.fieldMappings
        : {},
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
  const backendDeclared = Boolean(plugin.backend);
  const backendEnabled = Boolean(plugin.backendEnabled);
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    enabled: plugin.enabled,
    icon: plugin.menus?.[0]?.icon || 'puzzle',
    source: plugin.source,
    trustLevel: plugin.trustLevel,
    capabilities: plugin.capabilities || [],
    backendDeclared,
    backendEnabled,
    notices: plugin.notices || [],
    removable: plugin.source !== 'bundled',
    menus: plugin.enabled ? plugin.menus : [],
    pages: plugin.enabled ? plugin.pages.map((page) => ({
      id: page.id,
      title: page.title,
      path: page.path,
      file: page.file || '',
      renderer: page.renderer || 'iframe',
    })) : [],
    hasBackend: Boolean(plugin.router),
  };
}

function createProviderServices(plugin) {
  const dataDir = path.join(PLUGIN_DATA_DIR, plugin.id);
  fs.mkdirSync(dataDir, { recursive: true });
  const controlledDownload = require('./controlledDownload');
  const controlledFs = require('./controlledFs');
  const javaRuntime = require('./javaRuntime');
  const gateways = (plugin.capabilities || []).includes('provider:gateway')
    ? require('./pluginGatewayService').scopedGatewayService(plugin)
    : undefined;
  return {
    dataDir,
    allowedHosts: plugin.downloadHosts || [],
    http: {
      getJson: (url, opts = {}) => controlledDownload.getJson(url, {
        allowedHosts: plugin.downloadHosts || [],
        ...opts,
      }),
      getText: (url, opts = {}) => controlledDownload.getText(url, {
        allowedHosts: plugin.downloadHosts || [],
        ...opts,
      }),
    },
    download: (opts) => controlledDownload.downloadToFile({
      allowedHosts: plugin.downloadHosts || [],
      ...opts,
    }),
    fs: {
      pluginData: controlledFs.scoped(dataDir),
      scoped: (root) => controlledFs.scoped(root),
    },
    java: {
      ensureJava: (req) => javaRuntime.ensureJava(req),
    },
    catalogHttp: (plugin.capabilities || []).includes('provider:catalog-source')
      ? require('./catalogHttp').forPlugin()
      : undefined,
    gitCatalog: plugin.id === 'catalog-git' ? require('./gitCatalogService').forPlugin(plugin) : undefined,
    fileCatalog: plugin.id === 'catalog-file' ? require('./fileCatalogService').forPlugin(plugin) : undefined,
    catalogConfig: plugin.id === 'catalog-curseforge' ? require('./catalogPluginConfig') : undefined,
    gateways,
    audit: pluginAudit,
    logger,
  };
}

function loadBackend(plugin) {
  if (!plugin.enabled || !plugin.backend) return;
  if (plugin.source === 'user' && !plugin.backendEnabled) {
    logger.info(`Plugin ${plugin.id} backend is declared but disabled until an administrator enables uploaded backend execution`);
    return;
  }
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
    const javaLoaderRegistry = require('./javaLoaderRegistry');
    const gatewayRegistry = require('./gatewayRegistry');
    const catalogProviderRegistry = require('./catalogProviderRegistry');
    const serverEditionRegistry = require('./serverEditionRegistry');
    const pluginActions = require('./pluginActions');
    const services = plugin.source === 'bundled' ? createProviderServices(plugin) : { dataDir, logger };
    register({
      id: plugin.id,
      router,
      dataDir,
      logger,
      can: (req, localKey) => {
        const security = require('../security');
        return security.authorize(req.principal || req.user, `plugin.${plugin.id}.${localKey}`);
      },
      permissionKey: (localKey) => `plugin.${plugin.id}.${localKey}`,
      trustLevel: plugin.trustLevel,
      capabilities: plugin.capabilities || [],
      services,
      registerJavaLoader: (provider) => javaLoaderRegistry.register(plugin, provider),
      registerGateway: (provider) => gatewayRegistry.register(plugin, provider),
      registerServerEdition: plugin.source === 'bundled'
        ? (provider) => serverEditionRegistry.register(plugin, provider)
        : undefined,
      registerCatalogSource: plugin.source === 'bundled'
        ? (provider) => catalogProviderRegistry.register(plugin, provider)
        : undefined,
      unregisterCatalogSource: plugin.source === 'bundled'
        ? (providerId) => catalogProviderRegistry.unregister(plugin, providerId)
        : undefined,
      registerPluginAction: plugin.source === 'bundled'
        ? (spec) => pluginActions.register(plugin.id, spec)
        : undefined,
      registerPluginSettings: plugin.source === 'bundled'
        ? (spec) => require('./pluginSettings').register(plugin, spec)
        : undefined,    });
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
      const source = pluginCapabilities.sourceFromDir(dir, BUNDLED_PLUGINS_DIR, USER_PLUGINS_DIR);
      const parsed = parseManifest(raw, folderName, { source });
      if (!parsed.ok) {
        logger.warn(`Skipping plugin in ${folderName}: ${parsed.error}`);
        continue;
      }
      if (seen.has(parsed.manifest.id)) {
        logger.warn(`Skipping plugin ${parsed.manifest.id} from ${folder}: id already loaded`);
        continue;
      }
      seen.add(parsed.manifest.id);
      const claimed = new Set(next.flatMap((item) => (item.permissions || []).map((perm) => perm.key)));
      const duplicate = (parsed.manifest.permissions || []).find((perm) => claimed.has(perm.key));
      if (duplicate) {
        logger.warn(`Skipping plugin ${parsed.manifest.id}: duplicate permission key "${duplicate.key}"`);
        continue;
      }
      const backendEnabled = isBackendEnabled(parsed.manifest.id, source, Boolean(parsed.manifest.backend));
      const trustLevel = pluginCapabilities.trustLevelFor(source, parsed.manifest.capabilities, {
        backendDeclared: Boolean(parsed.manifest.backend),
        backendEnabled,
      });
      const notices = [];
      if (source === 'user' && parsed.manifest.backend) {
        notices.push('Uploaded backend plugins run in the manager process. Enable backend execution only for code you trust.');
      }
      if (parsed.manifest.rejectedPrivileged?.length) {
        notices.push('Privileged provider capabilities were ignored because this plugin is not bundled.');
      }
      const plugin = {
        ...parsed.manifest,
        enabled: isPluginEnabled(parsed.manifest.id, parsed.manifest.enabled),
        backendEnabled,
        trustLevel,
        notices,
        root: folder,
        source,
        router: null,
      };
      loadBackend(plugin);
      next.push(plugin);
      logger.info(`Loaded plugin ${plugin.id} (${plugin.enabled ? 'enabled' : 'disabled'}, ${plugin.source})`);
    }
  }
  lastDirs = dirs;
  loaded = next;
  syncAuthCatalog();
  try { require('./serverPluginAttachments').migrateGateways(); } catch { /* ignore until schema is ready */ }  return getPlugins();
}

function unloadPlugins() {
  const ids = loaded.map((plugin) => plugin.id);
  for (const file of backendModules) {
    delete require.cache[file];
  }
  backendModules = [];
  loaded = [];
  try { require('./pluginActions').clear(); } catch { /* ignore */ }
  try { require('./pluginSettings').clear(); } catch { /* ignore */ }
  try { require('./javaLoaderRegistry').unregisterPlugins(ids); } catch { /* ignore */ }
  try { require('./gatewayRegistry').unregisterPlugins(ids); } catch { /* ignore */ }
  try { require('./catalogProviderRegistry').unregisterPlugins(ids); } catch { /* ignore */ }
  try { require('./serverEditionRegistry').unregisterPlugins(ids); } catch { /* ignore */ }
}

function resetForTests() {
  unloadPlugins();
  lastDirs = null;
  try { require('./javaHostingPolicy').resetForTests(); } catch { /* ignore */ }
  try { require('./bedrockConnectPolicy').resetForTests(); } catch { /* ignore */ }
  try { require('./serverEditionRegistry').clear(); } catch { /* ignore */ }
}

function reloadPlugins() {
  const dirs = lastDirs || defaultPluginDirs();
  unloadPlugins();
  return loadPlugins(dirs);
}

function readPluginState() {
  try {
    const raw = JSON.parse(fs.readFileSync(PLUGIN_STATE_PATH, 'utf8'));
    return {
      enabled: raw && raw.enabled && typeof raw.enabled === 'object' ? raw.enabled : {},
      backendEnabled: raw && raw.backendEnabled && typeof raw.backendEnabled === 'object' ? raw.backendEnabled : {},
    };
  } catch {
    return { enabled: {}, backendEnabled: {} };
  }
}

function writePluginState(state) {
  fs.mkdirSync(path.dirname(PLUGIN_STATE_PATH), { recursive: true });
  fs.writeFileSync(PLUGIN_STATE_PATH, `${JSON.stringify({
    enabled: state.enabled || {},
    backendEnabled: state.backendEnabled || {},
  }, null, 2)}\n`);
}

function readEnabledState() {
  return readPluginState().enabled;
}

function writeEnabledState(enabledMap) {
  const state = readPluginState();
  state.enabled = enabledMap;
  writePluginState(state);
}

function isPluginEnabled(id, manifestEnabled) {
  const state = readPluginState();
  if (Object.prototype.hasOwnProperty.call(state.enabled, id)) return Boolean(state.enabled[id]);
  return manifestEnabled !== false;
}

function isBackendEnabled(id, source, backendDeclared) {
  if (!backendDeclared) return false;
  if (source === 'bundled' || source === 'external') return true;
  const state = readPluginState();
  return Boolean(state.backendEnabled[id]);
}

async function setPluginEnabled(id, enabled, options = {}) {
  const plugin = getPlugin(id);
  if (!plugin) {
    const err = new Error('Plugin not found');
    err.status = 404;
    throw err;
  }
  const javaHostingPolicy = require('./javaHostingPolicy');
  const bedrockConnectPolicy = require('./bedrockConnectPolicy');
  const isServerEdition = (plugin.capabilities || []).includes('provider:server-edition');
  const editionPolicy = plugin.id === 'server-edition-java'
    ? javaHostingPolicy
    : plugin.id === 'server-edition-bedrock-connect'
      ? bedrockConnectPolicy
      : null;
  if (!enabled && isServerEdition) {
    const confirm = options.confirm === true || options.confirm === 'true' || options.confirm === 1 || options.confirm === '1';
    if (!editionPolicy) {
      const err = new Error('This server-edition plugin cannot be disabled');
      err.status = 400;
      throw err;
    }
    if (!confirm) {
      throw editionPolicy.confirmError(editionPolicy.disableImpact());
    }
    await editionPolicy.performDisable();
  }
  if (!enabled && (plugin.capabilities || []).includes('provider:gateway')) {
    const gatewayManager = require('./gatewayManager');
    try { require('./pluginDashboard').snapshotPlugin(plugin.id); } catch { /* ignore */ }
    try { require('./pluginContributions').persistEnabledContributions(plugin.id); } catch { /* ignore */ }
    for (const row of gatewayManager.runningForPlugin(plugin.id)) {
      try { gatewayManager.stop(row.id); } catch { /* ignore */ }
    }
  }
  if (!enabled && plugin.backend) {
    try {
      const exported = require(path.resolve(plugin.root, plugin.backend));
      if (typeof exported.onDisable === 'function') await exported.onDisable();
    } catch {
      /* optional hook */
    }
  }
  const state = readPluginState();
  state.enabled[id] = Boolean(enabled);
  writePluginState(state);
  pluginAudit.record('plugin.enabled', { targetType: 'plugin', targetId: id, detail: { enabled: Boolean(enabled) } });
  try { require('./pluginEvents').emit(enabled ? 'plugin.enabled' : 'plugin.disabled', { pluginId: id }); } catch { /* ignore */ }
  reloadPlugins();
  if (!enabled && editionPolicy) editionPolicy.completeDisable();
  if (enabled && plugin.backend) {
    try {
      const enabledPlugin = getPlugin(id);
      if (enabledPlugin?.backend) {
        const exported = require(path.resolve(enabledPlugin.root, enabledPlugin.backend));
        if (typeof exported.onEnable === 'function') await exported.onEnable();
      }
    } catch {
      /* optional hook */
    }
  }
  return publicPlugin(getPlugin(id));
}

function setPluginBackendEnabled(id, enabled) {
  const plugin = getPlugin(id);
  if (!plugin) {
    const err = new Error('Plugin not found');
    err.status = 404;
    throw err;
  }
  if (plugin.source !== 'user') {
    const err = new Error('Only uploaded plugins have a backend execution toggle');
    err.status = 400;
    throw err;
  }
  if (!plugin.backend) {
    const err = new Error('This plugin does not declare a backend');
    err.status = 400;
    throw err;
  }
  const state = readPluginState();
  state.backendEnabled[id] = Boolean(enabled);
  writePluginState(state);
  pluginAudit.record('plugin.backend', { targetType: 'plugin', targetId: id, detail: { backendEnabled: Boolean(enabled) } });
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
  const parsed = parseManifest(raw, folderName, { source: 'user' });
  if (!parsed.ok) {
    const err = new Error(parsed.error || INVALID_ARCHIVE_MESSAGE);
    err.status = 400;
    throw err;
  }
  const requested = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  if (requested.some((item) => pluginCapabilities.isPrivilegedCapability(item))) {
    const err = new Error('Uploaded plugins cannot declare system-provider capabilities');
    err.status = 400;
    throw err;
  }
  pluginAudit.record('plugin.install.check', { targetType: 'plugin', targetId: parsed.manifest.id });
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
      permissionKey: menu.permission || `menu.view.plugin.${plugin.id}.${menu.id}`,
    })))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });
}

function getDynamicPermissions() {
  const catalog = require('./permissionCatalog');
  const permissions = [];
  const seen = new Set();
  for (const plugin of loaded) {
    for (const perm of plugin.permissions || []) {
      if (!perm?.key || seen.has(perm.key)) continue;
      const coreHit = [...(catalog.CORE_PERMISSIONS || []), ...(catalog.DEPRECATED_PERMISSIONS || [])]
        .some((item) => item.key === perm.key);
      if (coreHit && !catalog.pluginOwnsKey(plugin.id, perm.key)) continue;
      seen.add(perm.key);
      permissions.push({
        key: perm.key,
        name: perm.displayName || perm.name,
        displayName: perm.displayName || perm.name,
        description: perm.description,
        category: perm.primaryCategory || perm.category || 'plugin',
        primaryCategory: perm.primaryCategory || perm.category || 'plugin',
        subcategory: perm.subcategory || null,
        riskLevel: perm.riskLevel || 'normal',
        assignableToUsers: perm.assignableToUsers !== false,
        assignableToGroups: perm.assignableToGroups !== false,
        pluginId: perm.pluginId || plugin.id,
        source: perm.source || (plugin.source === 'bundled' ? 'first-party-plugin' : 'third-party-plugin'),
        active: plugin.enabled !== false,
      });
    }
    for (const menu of plugin.menus || []) {
      if (menu.permission) continue;
      const key = `menu.view.plugin.${plugin.id}.${menu.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      permissions.push({
        key,
        name: `View ${menu.label}`,
        displayName: `View ${menu.label}`,
        description: `Show "${menu.label}" in the left-hand menu`,
        category: 'plugin',
        primaryCategory: 'plugin',
        riskLevel: 'read',
        assignableToUsers: true,
        assignableToGroups: true,
        pluginId: plugin.id,
        source: plugin.source === 'bundled' ? 'first-party-plugin' : 'third-party-plugin',
        active: plugin.enabled !== false,
      });
    }
  }
  return permissions;
}

function syncAuthCatalog() {
  try {
    require('../security').syncDynamicPermissions();
  } catch (err) {
    logger.warn(`Could not sync plugin permissions: ${err.message}`);
  }
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

const PLUGIN_SDK_PATH = path.join(__dirname, '../static/plugin-sdk.js');
const PLUGIN_UI_FONTS = [
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">',
].join('\n');
const PLUGIN_UI_CHROME_CSS = [
  'html,body{margin:0;min-height:100%;background:#1a1a2e;color:#e2e8f0;color-scheme:dark;',
  "font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
  'button,input,select,textarea{font:inherit}',
].join('');

function htmlAttr(tag, name) {
  const quoted = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  if (quoted) return quoted[1].trim();
  const bare = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, 'i'));
  return bare ? bare[1].trim() : '';
}

function isExternalAssetUrl(url) {
  return /^(https?:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:');
}

function isPluginSdkSrc(src) {
  const pathOnly = String(src || '').split('?')[0];
  return pathOnly === '/api/plugins/sdk.js' || pathOnly.endsWith('/plugins/sdk.js');
}

function escapeInline(source, closer) {
  const re = closer === 'script' ? /<\/script/gi : /<\/style/gi;
  return String(source).replace(re, closer === 'script' ? '<\\/script' : '<\\/style');
}

function pluginSdkSource() {
  return `/* mc-manager-plugin-sdk */\n${fs.readFileSync(PLUGIN_SDK_PATH, 'utf8')}`;
}

function pluginSdkPresent(html) {
  return html.includes('mc-manager-plugin-sdk') || html.includes("source: 'mbm-host'");
}

function inlinePluginPageAssets(plugin, html) {
  let source = String(html);
  source = source.replace(/<link\b[^>]*>/gi, (tag) => {
    if (htmlAttr(tag, 'rel').toLowerCase() !== 'stylesheet') return tag;
    const href = htmlAttr(tag, 'href');
    if (!href || isExternalAssetUrl(href) || href.startsWith('/') || !plugin) return tag;
    const file = resolveUiFile(plugin, href);
    if (!file || file.ext !== '.css') return tag;
    const css = escapeInline(fs.readFileSync(file.filePath, 'utf8'), 'style');
    return `<style data-mbm-plugin-asset>\n${css}\n</style>`;
  });
  source = source.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs) => {
    const src = htmlAttr(`<script ${attrs}>`, 'src');
    if (!src) return full;
    const type = htmlAttr(`<script ${attrs}>`, 'type');
    const typeAttr = type ? ` type="${type.replace(/"/g, '')}"` : '';
    if (isPluginSdkSrc(src)) {
      return `<script${typeAttr}>\n${escapeInline(pluginSdkSource(), 'script')}\n</script>`;
    }
    if (isExternalAssetUrl(src) || src.startsWith('/') || !plugin) return full;
    const file = resolveUiFile(plugin, src);
    if (!file || (file.ext !== '.js' && file.ext !== '.mjs')) return full;
    const js = escapeInline(fs.readFileSync(file.filePath, 'utf8'), 'script');
    return `<script${typeAttr} data-mbm-plugin-asset>\n${js}\n</script>`;
  });
  return source;
}

function injectHtmlSdk(html, plugin = null) {
  let source = inlinePluginPageAssets(plugin, html);
  const headBits = [];
  if (!/fonts\.googleapis\.com/.test(source)) headBits.push(PLUGIN_UI_FONTS);
  if (!source.includes('data-mbm-plugin-ui')) {
    const uiCssPath = path.join(__dirname, '../static/plugin-ui.css');
    if (fs.existsSync(uiCssPath)) {
      headBits.push(`<style data-mbm-plugin-ui>${escapeInline(fs.readFileSync(uiCssPath, 'utf8'), 'style')}</style>`);
    }
  }
  if (!source.includes('data-mbm-plugin-chrome')) {
    headBits.push(`<style data-mbm-plugin-chrome>${PLUGIN_UI_CHROME_CSS}</style>`);
  }
  if (!pluginSdkPresent(source)) {
    headBits.push(`<script>\n${escapeInline(pluginSdkSource(), 'script')}\n</script>`);
  }
  if (!headBits.length) return source;
  const tag = `${headBits.join('\n')}\n`;
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

function getPermissionCategories() {
  const out = [];
  const seen = new Set();
  for (const plugin of loaded) {
    if (plugin.enabled === false) continue;
    for (const item of plugin.permissionCategories || []) {
      const id = String(item?.id || item || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        label: String(item.label || item.name || id),
        source: plugin.source === 'bundled' ? 'first-party-plugin' : 'third-party-plugin',
        pluginId: plugin.id,
      });
    }
  }
  return out;
}

function getPermissionSubcategories() {
  const out = [];
  const seen = new Set();
  for (const plugin of loaded) {
    if (plugin.enabled === false) continue;
    for (const item of plugin.permissionSubcategories || []) {
      const id = String(item?.id || '').trim();
      const category = String(item?.category || item?.primaryCategory || '').trim();
      if (!id || !category) continue;
      const key = `${category}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id,
        category,
        label: String(item.label || id),
        pluginId: plugin.id,
      });
    }
  }
  return out;
}

function getFieldMappings(pluginId) {
  const map = {};
  for (const plugin of loaded) {
    if (pluginId && plugin.id !== pluginId) continue;
    Object.assign(map, plugin.fieldMappings || {});
  }
  return map;
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
  ALLOWED_NATIVE_CORE_PATHS,
  EXAMPLE_PLUGINS_DIR,
  INVALID_ARCHIVE_MESSAGE,
  PLUGIN_DATA_DIR,
  PLUGIN_STATE_PATH,
  RESERVED_PLUGIN_IDS,
  USER_PLUGINS_DIR,
  defaultPluginDirs,
  getMenuItems,
  getDynamicPermissions,
  getPermissionCategories,
  getPermissionSubcategories,
  getFieldMappings,
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
  readPluginState,
  reloadPlugins,
  resetForTests,
  resolveUiFile,
  setPluginBackendEnabled,
  setPluginEnabled,
};
