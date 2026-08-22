const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localFile = Buffer.concat([local, nameBuf, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(localFile);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localFile.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(locals.length, 8);
  end.writeUInt16LE(locals.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, end]);
}

function catalogProviderFixture() {
  return {
    getMetadata: () => ({
      id: 'fixture-catalog',
      name: 'Fixture Catalog',
      source: 'fixture',
      editions: ['java'],
      downloadHosts: ['example.test'],
    }),
    isAvailable: () => true,
    getCategories: async () => [{ id: 'fixture-catalog:mods', name: 'Mods' }],
    search: async () => ({ results: [], total: 0, page: 1 }),
    getDetails: async () => null,
    listDownloadFiles: async () => [],
    download: async () => ({ plan: true, project: {}, files: [] }),
  };
}

async function runCatalogProviderTests({ pluginHost, testRoot }) {
  const pluginCapabilities = require('../server/services/pluginCapabilities');
  const catalogProviderRegistry = require('../server/services/catalogProviderRegistry');
  const catalogHttp = require('../server/services/catalogHttp');
  const catalogService = require('../server/services/catalogService');
  const catalogLibrary = require('../server/services/catalogLibrary');
  const controlledDownload = require('../server/services/controlledDownload');
  const zipGuard = require('../server/services/zipGuard');
  const settingsStore = require('../server/services/settingsStore');
  const javaCatalog = require('../server/bundled-plugins/catalog-curseforge-java/backend');

  const uploadedCaps = pluginCapabilities.parseCapabilities(['provider:catalog-source', 'ui:pages'], 'user');
  assert.deepEqual(uploadedCaps.capabilities, ['ui:pages']);
  assert.deepEqual(uploadedCaps.rejectedPrivileged, ['provider:catalog-source']);
  assert.equal(pluginCapabilities.parseCapabilities(['not-a-cap'], 'bundled').ok, false);

  catalogProviderRegistry.clear();
  catalogService.ensureProviders();
  fs.mkdirSync(process.env.MC_MANAGER_MODS_DIR || path.join(testRoot, 'mods'), { recursive: true });
  const bundledPlugin = {
    id: 'ok-catalog',
    source: 'bundled',
    capabilities: ['provider:catalog-source'],
  };
  catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture());
  assert.equal(catalogProviderRegistry.list().some((item) => item.id === 'fixture-catalog'), true);
  assert.equal(typeof catalogProviderRegistry.list()[0].search, 'undefined');

  assert.throws(
    () => catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture()),
    /already registered/
  );

  catalogProviderRegistry.unregisterPlugins(['ok-catalog']);
  assert.equal(catalogProviderRegistry.get('fixture-catalog'), null);
  catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture());
  assert.ok(catalogProviderRegistry.get('fixture-catalog'));

  assert.throws(
    () => catalogProviderRegistry.register({
      id: 'evil',
      source: 'user',
      capabilities: ['provider:catalog-source'],
    }, catalogProviderFixture()),
    /bundled/
  );

  await assert.rejects(
    async () => {
      const zipPath = path.join(testRoot, 'evil-catalog.zip');
      fs.writeFileSync(zipPath, zipStore({
        'evil-catalog/plugin.json': JSON.stringify({
          id: 'evil-catalog',
          name: 'Evil',
          capabilities: ['provider:catalog-source'],
          pages: [{ id: 'home', title: 'x', file: 'index.html' }],
        }),
        'evil-catalog/ui/index.html': '<html></html>',
      }));
      await pluginHost.installPluginFromZip(zipPath);
    },
    /system-provider capabilities/i
  );

  const prevKey = settingsStore.get(settingsStore.KEYS.CURSEFORGE_API_KEY);
  settingsStore.remove(settingsStore.KEYS.CURSEFORGE_API_KEY);
  assert.equal(catalogHttp.isConfigured('curseforge'), false);
  await assert.rejects(
    () => catalogHttp.request({
      credentialProfile: 'curseforge',
      url: 'https://api.curseforge.com/v1/mods/search',
    }),
    /API key/
  );
  settingsStore.set(settingsStore.KEYS.CURSEFORGE_API_KEY, 'cf-test-secret-key-value');
  assert.equal(catalogHttp.isConfigured('curseforge'), true);
  const broker = catalogHttp.forPlugin();
  assert.equal(Object.values(broker).some((value) => String(value).includes('cf-test-secret')), false);
  await assert.rejects(
    () => catalogHttp.request({
      credentialProfile: 'curseforge',
      url: 'https://evil.example/v1/mods',
    }),
    /approved download list|official CurseForge API host/
  );
  await assert.rejects(
    () => catalogHttp.request({
      credentialProfile: 'curseforge',
      url: 'http://api.curseforge.com/v1/mods/search',
    }),
    /HTTPS/
  );
  const publicSettings = settingsStore.publicCatalogSettings();
  assert.equal(publicSettings.curseforge.configured, true);
  assert.equal(JSON.stringify(publicSettings).includes('cf-test-secret'), false);
  if (prevKey) settingsStore.set(settingsStore.KEYS.CURSEFORGE_API_KEY, prevKey);
  else settingsStore.remove(settingsStore.KEYS.CURSEFORGE_API_KEY);

  catalogProviderRegistry.clear();
  catalogService.ensureProviders();
  const listed = catalogService.listProviders();
  assert.ok(listed.providers.some((item) => item.id === 'curseforge-bedrock'));
  assert.ok(listed.providers.some((item) => item.id === 'git'));
  assert.ok(listed.providers.some((item) => item.id === 'file'));
  assert.equal(listed.providers.some((item) => item.id === 'curseforge-java'), false);

  pluginHost.resetForTests();
  pluginHost.loadPlugins([pluginHost.BUNDLED_PLUGINS_DIR]);
  assert.ok(catalogProviderRegistry.get('curseforge-java'), 'bundled CurseForge Java plugin should register');
  pluginHost.setPluginEnabled('catalog-curseforge-java', false);
  assert.equal(catalogProviderRegistry.get('curseforge-java'), null);
  pluginHost.setPluginEnabled('catalog-curseforge-java', true);
  assert.ok(catalogProviderRegistry.get('curseforge-java'));
  pluginHost.resetForTests();
  catalogProviderRegistry.clear();
  catalogService.ensureProviders();

  const gitOnly = await catalogService.searchMods('anything', { source: 'git', edition: 'java', pageSize: 5 });
  assert.equal(gitOnly.results.length, 0);
  assert.match(String(gitOnly.warning || ''), /does not include java/i);

  const javaProvider = javaCatalog.createProvider({
    catalogHttp: {
      isConfigured: () => true,
      request: async ({ url, params }) => {
        if (url.endsWith('/v1/categories')) {
          return { data: { data: [{ id: 6, slug: 'mc-mods', name: 'Mods', isClass: true }] } };
        }
        if (url.endsWith('/v1/mods/search')) {
          assert.equal(params.gameId, 432);
          return {
            data: {
              data: [{
                id: 99,
                name: 'Sodium',
                slug: 'sodium',
                summary: 'Optimization',
                authors: [{ name: 'JellySquid' }],
                logo: { thumbnailUrl: 'https://example.test/sodium.png' },
                downloadCount: 10,
                dateModified: '2026-01-01T00:00:00Z',
                links: { websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/sodium' },
                classId: 6,
                latestFiles: [{ gameVersions: ['1.21.1', 'Fabric', 'Client'] }],
              }],
              pagination: { totalCount: 1 },
            },
          };
        }
        if (url.endsWith('/v1/mods/99')) {
          return {
            data: {
              data: {
                id: 99,
                name: 'Sodium',
                slug: 'sodium',
                summary: 'Optimization',
                authors: [{ name: 'JellySquid' }],
                classId: 6,
                latestFiles: [{ gameVersions: ['1.21.1', 'Fabric'] }],
              },
            },
          };
        }
        if (url.includes('/files/11/download-url')) {
          return { data: { data: 'https://edge.forgecdn.net/files/sodium.jar' } };
        }
        if (url.endsWith('/files')) {
          return {
            data: {
              data: [
                {
                  id: 11,
                  fileName: 'sodium-fabric.jar',
                  displayName: '0.6.0',
                  fileDate: '2026-01-02T00:00:00Z',
                  fileLength: 12,
                  releaseType: 1,
                  gameVersions: ['1.21.1', 'Fabric', 'Client'],
                  hashes: [{ algo: 1, value: 'abc' }],
                },
                {
                  id: 12,
                  fileName: 'sodium-neoforge.jar',
                  displayName: '0.6.0-neo',
                  fileDate: '2026-01-03T00:00:00Z',
                  fileLength: 12,
                  releaseType: 1,
                  gameVersions: ['1.21.1', 'NeoForge', 'Server'],
                },
              ],
              pagination: { totalCount: 2 },
            },
          };
        }
        throw new Error(`unexpected ${url}`);
      },
    },
  });

  const fabricParsed = javaProvider.parseGameVersions(['1.21.1', 'Fabric', 'Client']);
  assert.equal(fabricParsed.loader, 'fabric');
  assert.equal(fabricParsed.environment, 'client');
  assert.deepEqual(fabricParsed.minecraftVersions, ['1.21.1']);
  const neoParsed = javaProvider.parseGameVersions(['1.21.1', 'NeoForge', 'Server']);
  assert.equal(neoParsed.loader, 'neoforge');
  const unknownParsed = javaProvider.parseGameVersions(['1.21.1']);
  assert.equal(unknownParsed.loader, 'unknown');
  assert.equal(unknownParsed.environment, 'unknown');

  const search = await javaProvider.search('optimization', { page: 1, pageSize: 10, category: 'curseforge-java:mc-mods' });
  assert.equal(search.results[0].edition, 'java');
  assert.equal(search.results[0].providerId, 'curseforge-java');
  assert.equal(search.results[0].loader, 'fabric');

  const files = await javaProvider.listDownloadFiles(99);
  assert.equal(files[0].neoforge, true);
  assert.equal(files.some((item) => item.fabric), true);
  const auto = await javaProvider.download(99, []);
  assert.equal(auto.needsSelection, true);
  const picked = files.find((item) => item.environment === 'client');
  assert.ok(picked.warning);

  const jarPath = path.join(testRoot, 'invalid.txt');
  fs.writeFileSync(jarPath, 'not a zip');
  assert.throws(() => zipGuard.listStoredZipEntries(jarPath), /Not a zip archive/);

  const tmpRoot = path.join(testRoot, 'catalog-dl');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const goodJar = zipStore({
    'fabric.mod.json': JSON.stringify({
      id: 'sodium',
      name: 'Sodium',
      version: '0.6.0',
      environment: 'client',
      depends: { minecraft: '1.21.1' },
    }),
  });
  const originalDownload = controlledDownload.downloadToFile;
  fs.mkdirSync(process.env.MC_MANAGER_MODS_DIR || path.join(testRoot, 'mods'), { recursive: true });
  controlledDownload.downloadToFile = async ({ url, destination, allowHosts, maximumBytes }) => {
    if (String(url).startsWith('http:')) throw new Error('Downloads must use HTTPS');
    if (!String(url).includes('forgecdn.net') && !(allowHosts || []).some((host) => String(url).includes(host))) {
      throw new Error(`Host is not on the approved download list`);
    }
    if (maximumBytes != null && goodJar.length > maximumBytes) {
      throw new Error(`Download exceeded the ${maximumBytes} byte limit`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, goodJar);
    return { path: destination, bytes: goodJar.length, sha256: crypto.createHash('sha256').update(goodJar).digest('hex') };
  };
  try {
    await assert.rejects(
      () => catalogLibrary.importDownloadPlan({
        project: { name: 'Bad', slug: 'bad', edition: 'java', source: 'curseforge', providerId: 'curseforge-java' },
        files: [{ url: 'https://evil.example/mod.jar', fileName: 'mod.jar' }],
      }, { allowHosts: ['edge.forgecdn.net'], providerId: 'curseforge-java' }),
      /approved download list/
    );
    await assert.rejects(
      () => catalogLibrary.importDownloadPlan({
        project: { name: 'Huge', slug: 'huge', edition: 'java', source: 'curseforge' },
        files: [{ url: 'https://edge.forgecdn.net/files/huge.jar', fileName: 'huge.jar', maximumBytes: 4 }],
      }, { allowHosts: ['edge.forgecdn.net'], providerId: 'curseforge-java' }),
      /byte limit/
    );

    const imported = await catalogLibrary.importDownloadPlan({
      project: {
        name: 'Sodium',
        slug: 'sodium-catalog',
        edition: 'java',
        source: 'curseforge',
        providerId: 'curseforge-java',
        curseforgeId: 99,
        author: 'JellySquid',
        websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/sodium',
        artifactType: 'mod',
      },
      files: [{
        url: 'https://edge.forgecdn.net/files/sodium.jar',
        fileName: 'sodium-fabric.jar',
        fileId: 11,
        loader: 'fabric',
        minecraftVersions: ['1.21.1'],
        environment: 'client',
        displayName: '0.6.0',
      }],
    }, { allowHosts: ['edge.forgecdn.net'], providerId: 'curseforge-java' });
    assert.equal(imported.success, true);
    const db = require('../server/db/connection');
    const row = db.prepare('SELECT * FROM mods WHERE id = ?').get(imported.modId);
    assert.equal(row.edition, 'java');
    assert.equal(row.loader, 'fabric');
    assert.ok(row.sha256);
    assert.match(row.file_path, /[/\\]mods[/\\]/);
    assert.equal(JSON.parse(row.metadata_json).providerId, 'curseforge-java');
  } finally {
    controlledDownload.downloadToFile = originalDownload;
  }

  const missingKeyProvider = javaCatalog.createProvider({
    catalogHttp: {
      isConfigured: () => false,
      request: async () => { throw new Error('should not be called'); },
    },
  });
  assert.equal(missingKeyProvider.isAvailable(), false);
  await assert.rejects(() => missingKeyProvider.search('x'), /API key/);

  catalogProviderRegistry.clear();
}

module.exports = { runCatalogProviderTests };
