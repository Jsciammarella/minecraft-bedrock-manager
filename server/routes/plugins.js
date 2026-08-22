const pluginHost = require('../services/pluginHost');

const router = require('express').Router();
const sdkPath = require('path').join(__dirname, '../static/plugin-sdk.js');
const fs = require('fs');

router.get('/', (req, res) => {
  res.json({
    plugins: pluginHost.getPlugins(),
    menus: pluginHost.getMenuItems(),
    installDir: 'data/plugins',
  });
});

router.get('/sdk.js', (req, res) => {
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(sdkPath);
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
