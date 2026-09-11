const router = require('express').Router();
const javaLoaderRegistry = require('../services/javaLoaderRegistry');
const pluginAudit = require('../services/pluginAudit');
const minecraftVersions = require('../services/minecraftVersions');
const { requirePermission } = require('../middleware/auth');
const security = require('../security');

function errorBody(err) {
  const body = { error: err.message };
  if (err.code) body.code = err.code;
  if (err.minecraftVersion) body.minecraftVersion = err.minecraftVersion;
  if (err.loaderVersion) body.loaderVersion = err.loaderVersion;
  if (err.loader) body.loader = err.loader;
  return body;
}

router.get('/providers', requirePermission('servers.view_details'), (req, res) => {
  res.json({ providers: javaLoaderRegistry.list() });
});

router.get('/providers/:providerId/versions', requirePermission('servers.view_details'), async (req, res) => {
  try {
    const entry = javaLoaderRegistry.requireLoader(req.params.providerId);
    const versions = await entry.provider.listMinecraftVersions();
    res.json({
      providerId: entry.id,
      loader: entry.id,
      versions: versions.filter((item) => !minecraftVersions.isFabricatedMinecraftVersion(item)),
    });
  } catch (err) {
    res.status(err.status || 400).json(errorBody(err));
  }
});

router.get('/providers/:providerId/loader-versions', requirePermission('servers.view_details'), async (req, res) => {
  try {
    const entry = javaLoaderRegistry.requireLoader(req.params.providerId);
    const minecraftVersion = req.query.minecraftVersion || req.query.version;
    const versions = await entry.provider.listLoaderVersions(minecraftVersion);
    res.json({
      providerId: entry.id,
      loader: entry.id,
      minecraftVersion: minecraftVersion || null,
      versions,
    });
  } catch (err) {
    res.status(err.status || 400).json(errorBody(err));
  }
});

router.post('/providers/:providerId/validate', requirePermission('servers.create_java'), async (req, res) => {
  try {
    require('../services/javaHostingPolicy').assertServerEditionAvailable('java', 'validate');
    const entry = javaLoaderRegistry.requireLoader(req.params.providerId);
    const resolved = await entry.provider.resolveInstallation(req.body || {});
    pluginAudit.record('java.validate', {
      actor: security.actorName(req.principal || req.user),
      targetType: 'java-loader',
      targetId: entry.id,
      detail: resolved,
    });
    res.json({
      ok: true,
      resolved: {
        loader: resolved.loader || entry.id,
        minecraftVersion: resolved.minecraftVersion,
        loaderVersion: resolved.loaderVersion,
        loaderChannel: resolved.loaderChannel,
        javaMajor: resolved.javaMajor,
        ...resolved,
      },
      notices: entry.provider.getMetadata()?.notices || [],
    });
  } catch (err) {
    res.status(err.status || 400).json(errorBody(err));
  }
});

module.exports = router;
