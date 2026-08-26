const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pluginHost = require('../services/pluginHost');
const { requirePermission, assertPermission } = require('../middleware/auth');

const router = require('express').Router();
const sdkPath = path.join(__dirname, '../static/plugin-sdk.js');
const uploadsDir = path.join(__dirname, '../../data/uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeName}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 400 },
});

function sendPluginState(res, extra = {}) {
  res.json({
    plugins: pluginHost.getPlugins(),
    menus: pluginHost.getMenuItems(),
    installDir: 'data/plugins',
    ...extra,
  });
}

function can(req, key) {
  const current = req.principal || req.user;
  if (!current) return false;
  try {
    return require('../security').authorize(current, key);
  } catch {
    return false;
  }
}

router.get('/', (req, res) => {
  if (can(req, 'plugins.view')) {
    return sendPluginState(res);
  }
  res.json({
    plugins: [],
    menus: pluginHost.getMenuItems(),
  });
});

function setPluginAssetHeaders(res) {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
}

router.get('/sdk.js', (req, res) => {
  setPluginAssetHeaders(res);
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.sendFile(sdkPath);
});

router.get('/ui.css', (req, res) => {
  setPluginAssetHeaders(res);
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.sendFile(path.join(__dirname, '../static/plugin-ui.css'));
});

function sendSettingsError(res, err) {
  return res.status(err.status || 400).json({
    error: err.message,
    code: err.code,
  });
}

router.get('/:pluginId/settings', requirePermission('plugins.configure'), (req, res) => {
  const plugin = pluginHost.getPlugin(req.params.pluginId);
  if (!plugin || !plugin.enabled) return res.status(404).json({ error: 'Plugin not found' });
  try {
    const pluginSettings = require('../services/pluginSettings');
    pluginSettings.assertSameOrigin(req);
    res.json(pluginSettings.publicPage(plugin.id, { actor: req.user?.username || 'local', user: req.user }));
  } catch (err) {
    return sendSettingsError(res, err);
  }
});

router.post('/:pluginId/settings/actions/:actionId', async (req, res) => {
  const plugin = pluginHost.getPlugin(req.params.pluginId);
  if (!plugin || !plugin.enabled) return res.status(404).json({ error: 'Plugin not found' });
  try {
    const pluginSettings = require('../services/pluginSettings');
    pluginSettings.assertSameOrigin(req);
    const result = await pluginSettings.invokeAction(
      plugin.id,
      req.params.actionId,
      req.body || {},
      { actor: req.user?.username || 'local', user: req.user }
    );
    if (result && result.download && Buffer.isBuffer(result.buffer)) {
      const filename = String(result.filename || 'download.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(result.buffer);
    }
    res.json(result);
  } catch (err) {
    return sendSettingsError(res, err);
  }
});

router.get('/:pluginId/settings/download/:actionId', async (req, res) => {
  const plugin = pluginHost.getPlugin(req.params.pluginId);
  if (!plugin || !plugin.enabled) return res.status(404).json({ error: 'Plugin not found' });
  try {
    const result = await require('../services/pluginSettings').invokeAction(
      plugin.id,
      req.params.actionId,
      {},
      { actor: req.user?.username || 'local', user: req.user }
    );
    if (!result || !result.download || !Buffer.isBuffer(result.buffer)) {
      return res.status(400).json({ error: 'That action does not provide a download' });
    }
    const filename = String(result.filename || 'download.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(result.buffer);
  } catch (err) {
    return sendSettingsError(res, err);
  }
});

router.post('/upload', requirePermission('plugins.install'), (req, res) => {

  upload.fields([
    { name: 'archive', maxCount: 1 },
    { name: 'files', maxCount: 400 },
  ])(req, res, async (uploadError) => {
    if (uploadError) {
      return res.status(400).json({ error: uploadError.message });
    }
    const archive = req.files?.archive?.[0];
    const files = req.files?.files || [];
    try {
      const plugin = archive
        ? await pluginHost.installPluginFromZip(archive.path, { deleteZip: true })
        : pluginHost.installPluginFromFiles(files);
      sendPluginState(res, { plugin });
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message || pluginHost.INVALID_ARCHIVE_MESSAGE });
    }
  });
});

router.put('/:pluginId/backend-enabled', requirePermission('plugins.enable_backend'), (req, res) => {
  const value = req.body?.enabled ?? req.body?.backendEnabled;
  let enabled;
  if (value === true || value === 'true' || value === 1 || value === '1') enabled = true;
  else if (value === false || value === 'false' || value === 0 || value === '0') enabled = false;
  else return res.status(400).json({ error: 'enabled must be true or false' });
  try {
    const plugin = pluginHost.setPluginBackendEnabled(req.params.pluginId, enabled);
    sendPluginState(res, { plugin });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
});

router.put('/:pluginId/enabled', async (req, res) => {

  const value = req.body?.enabled;
  let enabled;
  if (value === true || value === 'true' || value === 1 || value === '1') enabled = true;
  else if (value === false || value === 'false' || value === 0 || value === '0') enabled = false;
  else return res.status(400).json({ error: 'enabled must be true or false' });
  try {
    assertPermission(req, enabled ? 'plugins.enable' : 'plugins.disable');
    const confirm = req.body?.confirm === true || req.body?.confirm === 'true' || req.body?.confirm === 1 || req.body?.confirm === '1';
    const plugin = await pluginHost.setPluginEnabled(req.params.pluginId, enabled, { confirm });
    sendPluginState(res, { plugin });
  } catch (err) {
    return res.status(err.status || 400).json({
      error: err.message,
      code: err.code,
      message: err.message,
      impact: err.impact,
      failures: err.failures,
    });
  }
});

router.get('/:pluginId/disable-impact', requirePermission('plugins.view_details'), (req, res) => {
  const plugin = pluginHost.getPlugin(req.params.pluginId);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
  if (!(plugin.capabilities || []).includes('provider:server-edition')) {
    return res.json({ required: false, pluginId: plugin.id });
  }
  if (plugin.id === 'server-edition-bedrock-connect') {
    const impact = require('../services/bedrockConnectPolicy').disableImpact();
    return res.json({ required: true, ...impact });
  }
  const impact = require('../services/javaHostingPolicy').disableImpact();
  res.json({ required: true, ...impact });
});

router.get('/:pluginId/meta', (req, res) => {
  const plugin = pluginHost.getPlugin(req.params.pluginId);
  if (!plugin || !plugin.enabled) {
    return res.status(404).json({ error: 'Plugin not found' });
  }
  res.json(pluginHost.publicPlugin(plugin));
});

router.use('/:pluginId/ui', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const plugin = pluginHost.getPlugin(req.params.pluginId);
  const prefix = `/${req.params.pluginId}/ui`;
  let rel = String(req.path || '/');
  if (rel.startsWith(prefix)) rel = rel.slice(prefix.length);
  rel = rel.replace(/^\/+/, '') || 'index.html';
  const file = pluginHost.resolveUiFile(plugin, rel);
  if (!file) {
    return res.status(404).json({ error: 'Plugin page not found' });
  }
  setPluginAssetHeaders(res);
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  if (file.ext === '.html' || file.ext === '.htm') {
    const html = fs.readFileSync(file.filePath, 'utf8');
    return res.send(pluginHost.injectHtmlSdk(html, plugin));
  }
  return res.sendFile(file.filePath);
});

function gatewayPermissionsFor(req) {
  const routePath = String(req.url || '').split('?')[0];
  if (req.method === 'GET') {
    if (/\/logs$/.test(routePath)) return ['servers.console.view'];
    if (/\/floodgate\/key$/.test(routePath)) return ['plugins.configure'];
    return ['servers.view_details'];
  }
  if (req.method === 'DELETE') return ['servers.delete'];
  if (/\/start$/.test(routePath)) return ['servers.start_java'];
  if (/\/stop$/.test(routePath)) return ['servers.stop_java'];
  if (/\/restart$/.test(routePath)) return ['servers.restart'];
  if (req.method === 'POST' && /^\/gateways\/?$/.test(routePath)) return ['servers.create_java'];
  return ['plugins.configure'];
}
router.use('/:pluginId', (req, res, next) => {
  const plugin = pluginHost.getPlugin(req.params.pluginId);
  if (!plugin || !plugin.enabled || !plugin.router) {
    return res.status(404).json({ error: 'Plugin API not found' });
  }
  if (plugin.id === 'gateway-geyser') {
    try {
      for (const key of gatewayPermissionsFor(req)) assertPermission(req, key);
    } catch (err) {
      return res.status(err.status || 403).json({ error: err.message });
    }
  }
  return plugin.router(req, res, next);
});

module.exports = router;
