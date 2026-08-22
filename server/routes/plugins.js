const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pluginHost = require('../services/pluginHost');

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

router.get('/', (req, res) => {
  sendPluginState(res);
});

router.get('/sdk.js', (req, res) => {
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(sdkPath);
});

router.post('/upload', (req, res) => {
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

router.put('/:pluginId/enabled', (req, res) => {
  const value = req.body?.enabled;
  let enabled;
  if (value === true || value === 'true' || value === 1 || value === '1') enabled = true;
  else if (value === false || value === 'false' || value === 0 || value === '0') enabled = false;
  else return res.status(400).json({ error: 'enabled must be true or false' });
  try {
    const plugin = pluginHost.setPluginEnabled(req.params.pluginId, enabled);
    sendPluginState(res, { plugin });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
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
  const rel = String(req.path || '/').replace(/^\/+/, '');
  const file = pluginHost.resolveUiFile(plugin, rel);
  if (!file) {
    return res.status(404).json({ error: 'Plugin page not found' });
  }
  res.setHeader('Content-Type', file.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  if (file.ext === '.html' || file.ext === '.htm') {
    const html = fs.readFileSync(file.filePath, 'utf8');
    return res.send(pluginHost.injectHtmlSdk(html));
  }
  return res.sendFile(file.filePath);
});

router.use('/:pluginId', (req, res, next) => {
  const plugin = pluginHost.getPlugin(req.params.pluginId);
  if (!plugin || !plugin.enabled || !plugin.router) {
    return res.status(404).json({ error: 'Plugin API not found' });
  }
  return plugin.router(req, res, next);
});

module.exports = router;
