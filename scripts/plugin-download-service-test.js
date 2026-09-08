const assert = require('assert');
const path = require('path');

const FABRIC_HOSTS = ['meta.fabricmc.net', 'maven.fabricmc.net'];
const NEOFORGE_HOSTS = ['maven.neoforged.net'];

function withStubbedDownload(overrides, fn) {
  const controlledDownload = require('../server/services/controlledDownload');
  const keys = Object.keys(overrides);
  const original = {};
  for (const key of keys) {
    original[key] = controlledDownload[key];
    controlledDownload[key] = overrides[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) controlledDownload[key] = original[key];
    });
}

async function runPluginDownloadServiceTests({ pluginHost }) {
  const fabricBackend = require('../server/bundled-plugins/java-loader-fabric/backend');
  const neoforgeBackend = require('../server/bundled-plugins/java-loader-neoforge/backend');
  const controlledDownload = require('../server/services/controlledDownload');

  pluginHost.resetForTests();
  pluginHost.loadPlugins([pluginHost.BUNDLED_PLUGINS_DIR]);

  const fabricPlugin = pluginHost.getPlugin('java-loader-fabric');
  const neoPlugin = pluginHost.getPlugin('java-loader-neoforge');
  const vanillaPlugin = pluginHost.getPlugin('java-loader-vanilla');
  const geyserPlugin = pluginHost.getPlugin('gateway-geyser');
  const cursePlugin = pluginHost.getPlugin('catalog-curseforge');
  const filterPlugin = pluginHost.getPlugin('catalog-java-server-compatibility');
  assert.ok(fabricPlugin, 'Fabric loader plugin should be bundled');
  assert.ok(neoPlugin, 'NeoForge loader plugin should be bundled');
  assert.ok(vanillaPlugin, 'Vanilla loader plugin should be bundled');
  assert.ok(geyserPlugin, 'Geyser gateway plugin should be bundled');
  assert.deepEqual(fabricPlugin.downloadHosts, FABRIC_HOSTS);
  assert.deepEqual(neoPlugin.downloadHosts, NEOFORGE_HOSTS);

  const uploaded = pluginHost.parseManifest({
    id: 'uploaded-downloader',
    name: 'Uploaded Downloader',
    capabilities: ['ui:pages', 'download:official-sources'],
    downloadHosts: ['evil.example'],
  }, 'uploaded-downloader', { source: 'user' });
  assert.equal(uploaded.ok, true);
  assert.deepEqual(uploaded.manifest.downloadHosts, []);
  assert.equal(uploaded.manifest.capabilities.includes('download:official-sources'), false);

  const captured = [];
  await withStubbedDownload({
    getJson: async (url, opts) => {
      captured.push({ method: 'getJson', url, opts: { ...opts } });
      return [{ version: '1.21.1', stable: true }];
    },
    getText: async (url, opts) => {
      captured.push({ method: 'getText', url, opts: { ...opts } });
      return '<metadata><version>21.1.1</version></metadata>';
    },
    downloadToFile: async (opts) => {
      captured.push({ method: 'downloadToFile', opts: { ...opts } });
      return { path: opts.destination, bytes: 1, sha256: 'abc' };
    },
  }, async () => {
    const fabricServices = pluginHost.createProviderServices(fabricPlugin);
    assert.deepEqual([...fabricServices.allowedHosts], FABRIC_HOSTS);
    fabricServices.allowedHosts = ['evil.example'];
    assert.deepEqual([...fabricPlugin.downloadHosts], FABRIC_HOSTS);

    const fabricProvider = fabricBackend.createProvider(fabricServices);
    await fabricProvider.listMinecraftVersions();
    const fabricJson = captured.find((item) => item.method === 'getJson');
    assert.ok(fabricJson, 'Fabric getJson should reach controlledDownload');
    assert.deepEqual(fabricJson.opts.allowHosts, FABRIC_HOSTS);
    assert.equal(fabricJson.opts.allowHttp, false);
    assert.equal(Object.prototype.hasOwnProperty.call(fabricJson.opts, 'fetcher'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(fabricJson.opts, 'allowedHosts'), false);

    captured.length = 0;
    await fabricServices.http.getJson('https://meta.fabricmc.net/v2/versions/game', {
      allowHosts: ['evil.example'],
      allowedHosts: ['evil.example'],
      allowHttp: true,
      fetcher: async () => ({ hijacked: true }),
      headers: { Authorization: 'secret' },
      maxRedirects: 99,
    });
    assert.deepEqual(captured[0].opts.allowHosts, FABRIC_HOSTS);
    assert.equal(captured[0].opts.allowHttp, false);
    assert.equal(captured[0].opts.fetcher, undefined);
    assert.equal(captured[0].opts.headers, undefined);
    assert.equal(captured[0].opts.maxRedirects, undefined);

    captured.length = 0;
    const neoServices = pluginHost.createProviderServices(neoPlugin);
    const neoProvider = neoforgeBackend.createProvider(neoServices);
    await neoProvider.listAllInstallerVersions();
    const neoText = captured.find((item) => item.method === 'getText');
    assert.ok(neoText, 'NeoForge getText should reach controlledDownload');
    assert.deepEqual(neoText.opts.allowHosts, NEOFORGE_HOSTS);
    assert.equal(neoText.opts.allowHttp, false);

    captured.length = 0;
    await fabricServices.download({
      url: 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar',
      destination: path.join('C:', 'temp', 'fabric.jar'),
      allowHosts: ['evil.example'],
      allowHttp: true,
      fetcher: async () => Buffer.from('nope'),
      sha256: 'abc',
      project: 'Fabric',
      version: '1.0.1',
    });
    assert.equal(captured[0].method, 'downloadToFile');
    assert.deepEqual(captured[0].opts.allowHosts, FABRIC_HOSTS);
    assert.equal(captured[0].opts.allowHttp, false);
    assert.equal(captured[0].opts.fetcher, undefined);
    assert.equal(captured[0].opts.project, 'Fabric');
    assert.equal(captured[0].opts.sha256, 'abc');
  });

  const fabricServices = pluginHost.createProviderServices(fabricPlugin);
  await assert.rejects(
    () => fabricServices.http.getJson('https://evil.example/v2/versions/game'),
    /approved download list/
  );
  await assert.rejects(
    () => fabricServices.http.getJson('http://meta.fabricmc.net/v2/versions/game'),
    /HTTPS/
  );
  await assert.rejects(
    () => fabricServices.http.getText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'),
    /approved download list/
  );
  assert.throws(
    () => controlledDownload.assertHttpsUrl('https://evil.example/next', fabricServices.allowedHosts),
    /approved download list/
  );
  assert.throws(
    () => controlledDownload.assertRedirectAllowed({ url: 'https://evil.example/next' }, [...fabricServices.allowedHosts]),
    /Redirect rejected/
  );
  assert.doesNotThrow(
    () => controlledDownload.assertHttpsUrl('https://meta.fabricmc.net/v2/versions/game', [...fabricServices.allowedHosts])
  );
  assert.doesNotThrow(
    () => controlledDownload.assertRedirectAllowed(
      { url: 'https://maven.fabricmc.net/net/fabricmc/yarn/maven-metadata.xml' },
      [...fabricServices.allowedHosts]
    )
  );

  const filterServices = pluginHost.createProviderServices(filterPlugin || cursePlugin);
  await assert.rejects(
    () => filterServices.http.getJson('https://api.curseforge.com/v1/mods'),
    /download:official-sources/
  );
  await assert.rejects(
    () => filterServices.download({ url: 'https://edge.forgecdn.net/file.jar', destination: 'mod.jar' }),
    /download:official-sources/
  );
  assert.ok(cursePlugin, 'CurseForge catalog plugin should remain loaded');
  const curseServices = pluginHost.createProviderServices(cursePlugin);
  assert.ok(curseServices.catalogHttp, 'CurseForge should keep specialized catalogHttp');
  await assert.rejects(
    () => curseServices.http.getJson('https://api.curseforge.com/v1/mods'),
    /download:official-sources/
  );

  const vanillaServices = pluginHost.createProviderServices(vanillaPlugin);
  assert.ok(vanillaPlugin.capabilities.includes('download:official-sources'));
  assert.ok(vanillaServices.allowedHosts.includes('piston-meta.mojang.com'));
  const geyserServices = pluginHost.createProviderServices(geyserPlugin);
  assert.ok(geyserServices.allowedHosts.includes('download.geysermc.org'));
  assert.ok(geyserServices.allowedHosts.includes('api.modrinth.com'));
  assert.ok(geyserServices.allowedHosts.includes('cdn.modrinth.com'));

  await pluginHost.setPluginEnabled('java-loader-fabric', false);
  await pluginHost.setPluginEnabled('java-loader-fabric', true);
  const reloaded = pluginHost.getPlugin('java-loader-fabric');
  assert.deepEqual(reloaded.downloadHosts, FABRIC_HOSTS);
  const reloadedServices = pluginHost.createProviderServices(reloaded);
  assert.deepEqual([...reloadedServices.allowedHosts], FABRIC_HOSTS);
  await withStubbedDownload({
    getJson: async (_url, opts) => {
      assert.deepEqual(opts.allowHosts, FABRIC_HOSTS);
      return [{ version: '1.21.1', stable: true }];
    },
  }, async () => {
    await fabricBackend.createProvider(reloadedServices).listMinecraftVersions();
  });

  pluginHost.resetForTests();
}

module.exports = { runPluginDownloadServiceTests };
