const router = require('express').Router();
const javaLoaderRegistry = require('../services/javaLoaderRegistry');
const pluginAudit = require('../services/pluginAudit');

router.get('/providers', (req, res) => {
  res.json({ providers: javaLoaderRegistry.list() });
});

router.get('/providers/:providerId/versions', async (req, res) => {
  try {
    const entry = javaLoaderRegistry.requireLoader(req.params.providerId);
    const versions = await entry.provider.listMinecraftVersions();
    res.json({ providerId: entry.id, versions });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/providers/:providerId/loader-versions', async (req, res) => {
  try {
    const entry = javaLoaderRegistry.requireLoader(req.params.providerId);
    const minecraftVersion = req.query.minecraftVersion || req.query.version;
    const versions = await entry.provider.listLoaderVersions(minecraftVersion);
    res.json({ providerId: entry.id, minecraftVersion, versions });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/providers/:providerId/validate', async (req, res) => {
  try {
    const entry = javaLoaderRegistry.requireLoader(req.params.providerId);
    const resolved = await entry.provider.resolveInstallation(req.body || {});
    pluginAudit.record('java.validate', { targetType: 'java-loader', targetId: entry.id, detail: resolved });
    res.json({ ok: true, resolved, notices: entry.provider.getMetadata()?.notices || [] });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
