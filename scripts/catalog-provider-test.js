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

function catalogProviderFixture(overrides = {}) {
  const editions = Object.prototype.hasOwnProperty.call(overrides, 'editions')
    ? overrides.editions
    : ['java'];
  const id = overrides.id || 'fixture-catalog';
  return {
    getMetadata: () => ({
      id,
      name: 'Fixture Catalog',
      source: 'fixture',
      editions,
      downloadHosts: ['example.test'],
    }),
    isAvailable: () => true,
    getCategories: async () => [{ id: `${id}:mods`, name: 'Mods' }],
    search: async () => ({ results: [], total: 0, page: 1 }),
    getDetails: async () => null,
    listDownloadFiles: async () => [],
    download: async () => ({ plan: true, project: {}, files: [] }),
  };
}

async function runCatalogProviderTests({ pluginHost, testRoot }) {
  const pluginCapabilities = require('../server/services/pluginCapabilities');
  const catalogProviderRegistry = require('../server/services/catalogProviderRegistry');
  const catalogEditions = require('../server/services/catalogEditions');
  const catalogDownloadPolicy = require('../server/services/catalogDownloadPolicy');
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
  assert.deepEqual(catalogProviderRegistry.get('fixture-catalog') && catalogProviderRegistry.list().find((item) => item.id === 'fixture-catalog').editions, ['java']);
  assert.equal(typeof catalogProviderRegistry.list().find((item) => item.id === 'fixture-catalog').search, 'undefined');

  assert.throws(
    () => catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture({ id: 'bad-empty', editions: [] })),
    /at least one edition/
  );
  assert.throws(
    () => catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture({ id: 'bad-missing', editions: undefined })),
    /at least one edition/
  );
  assert.throws(
    () => catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture({ id: 'bad-all', editions: ['all'] })),
    /cannot declare edition "all"/
  );
  assert.throws(
    () => catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture({ id: 'bad-unknown', editions: ['unknown'] })),
    /not allowed/
  );
  assert.throws(
    () => catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture({ id: 'bad-html', editions: ['custom-html'] })),
    /not allowed/
  );
  assert.throws(
    () => catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture({ id: 'bad-js', editions: ['javascript:alert(1)'] })),
    /not allowed/
  );
  assert.throws(
    () => catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture({ id: 'bad-label', editions: ['Java Edition'] })),
    /not allowed/
  );
  assert.throws(
    () => catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture({ id: 'bad-type', editions: [1] })),
    /must be strings/
  );

  catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture({ id: 'fixture-bedrock', editions: ['bedrock'] }));
  catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture({ id: 'fixture-java-dup', editions: ['Java', 'java'] }));
  const dupMeta = catalogProviderRegistry.list().find((item) => item.id === 'fixture-java-dup');
  assert.deepEqual(dupMeta.editions, ['java']);
  assert.deepEqual(catalogProviderRegistry.availableEditions(), ['bedrock', 'java']);
  assert.equal(catalogProviderRegistry.availableEditions().filter((item) => item === 'java').length, 1);

  catalogProviderRegistry.unregisterPlugins(['ok-catalog']);
  catalogService.ensureProviders();
  assert.deepEqual(catalogProviderRegistry.availableEditions(), ['bedrock']);
  assert.equal(catalogProviderRegistry.availableEditions().includes('java'), false);

  catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture({ id: 'java-one', editions: ['java'] }));
  catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture({ id: 'java-two', editions: ['java'] }));
  assert.ok(catalogProviderRegistry.availableEditions().includes('java'));
  catalogProviderRegistry.unregisterPlugins(['ok-catalog']);
  catalogService.ensureProviders();
  catalogProviderRegistry.register({ id: 'java-one-plugin', source: 'bundled', capabilities: ['provider:catalog-source'] }, catalogProviderFixture({ id: 'java-one', editions: ['java'] }));
  catalogProviderRegistry.register({ id: 'java-two-plugin', source: 'bundled', capabilities: ['provider:catalog-source'] }, catalogProviderFixture({ id: 'java-two', editions: ['java'] }));
  catalogProviderRegistry.unregisterPlugins(['java-one-plugin']);
  assert.ok(catalogProviderRegistry.availableEditions().includes('java'));
  catalogProviderRegistry.unregisterPlugins(['java-two-plugin']);
  assert.equal(catalogProviderRegistry.availableEditions().includes('java'), false);

  const reset = catalogEditions.reconcileCatalogFilters({
    providers: catalogProviderRegistry.list(),
    source: 'curseforge-java',
    edition: 'java',
    category: 'curseforge-java:mc-mods',
  });
  assert.equal(reset.source, 'all');
  assert.equal(reset.edition, 'all');
  assert.equal(reset.category, '');
  assert.equal(reset.page, 1);

  catalogProviderRegistry.register(bundledPlugin, catalogProviderFixture());
  const keepJava = catalogEditions.reconcileCatalogFilters({
    providers: [
      ...catalogProviderRegistry.list(),
      { id: 'java-one', editions: ['java'] },
      { id: 'java-two', editions: ['java'] },
    ],
    source: 'all',
    edition: 'java',
    category: '',
  });
  assert.equal(keepJava.changed, false);
  assert.equal(keepJava.edition, 'java');

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
  catalogDownloadPolicy.setCachedAvailability('curseforge-java', '99', {
    files: [{ id: '1', name: 'a.jar', extension: '.jar', environment: 'client' }],
    availability: { downloadState: 'blocked', blockedReason: 'client-only' },
  });
  assert.ok(catalogDownloadPolicy.getCachedAvailability('curseforge-java', '99'));
  pluginHost.setPluginEnabled('catalog-curseforge-java', false);
  assert.equal(catalogProviderRegistry.get('curseforge-java'), null);
  assert.equal(catalogDownloadPolicy.getCachedAvailability('curseforge-java', '99'), null);
  pluginHost.setPluginEnabled('catalog-curseforge-java', true);
  assert.ok(catalogProviderRegistry.get('curseforge-java'));
  pluginHost.resetForTests();
  catalogProviderRegistry.clear();
  catalogService.ensureProviders();

  const gitOnly = await catalogService.searchMods('anything', { source: 'git', edition: 'java', pageSize: 5 });
  assert.notEqual(gitOnly.emptyReason, 'unsupported-combination');
  assert.ok((gitOnly.results || []).every((item) => !item.edition || item.edition === 'java'));

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
        if (url.includes('/files/12/download-url')) {
          return { data: { data: 'https://edge.forgecdn.net/files/sodium-neo.jar' } };
        }
        if (url.endsWith('/v1/mods/77')) {
          return {
            data: {
              data: {
                id: 77,
                name: 'Iris',
                slug: 'iris',
                classId: 6,
                latestFiles: [{ gameVersions: ['1.21.1', 'Fabric', 'Client'] }],
              },
            },
          };
        }
        if (url.includes('/mods/77/files')) {
          return {
            data: {
              data: [
                {
                  id: 21,
                  fileName: 'iris-client.jar',
                  fileDate: '2026-01-02T00:00:00Z',
                  gameVersions: ['1.21.1', 'Fabric', 'Client'],
                },
                {
                  id: 22,
                  fileName: 'iris-client-2.jar',
                  fileDate: '2026-01-01T00:00:00Z',
                  gameVersions: ['1.21.1', 'Fabric', 'Client'],
                },
              ],
              pagination: { totalCount: 2 },
            },
          };
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
  const minecraftVersions = require('../server/services/minecraftVersions');
  assert.deepEqual(
    minecraftVersions.parseRequestedGameVersions('1.21.1:java,1.26.1:bedrock'),
    [{ version: '1.21.1', edition: 'java' }, { version: '1.26.1', edition: 'bedrock' }]
  );
  assert.deepEqual(minecraftVersions.providerGameVersions(['java'], [
    { version: '1.21.1', edition: 'java' },
    { version: '1.26.1', edition: 'bedrock' },
  ]), ['1.21.1']);
  assert.equal(minecraftVersions.matchesCatalogGameVersions(
    { minecraftVersions: ['1.21.1'] },
    ['1.26.1']
  ), false);
  assert.equal(minecraftVersions.matchesCatalogGameVersions(
    { minecraftVersions: ['1.21.1'] },
    ['1.21.1']
  ), true);
  const neoParsed = javaProvider.parseGameVersions(['1.21.1', 'NeoForge', 'Server']);
  assert.equal(neoParsed.loader, 'neoforge');
  const unknownParsed = javaProvider.parseGameVersions(['1.21.1']);
  assert.equal(unknownParsed.loader, 'unknown');
  assert.equal(unknownParsed.environment, 'unknown');
  assert.equal(javaProvider.parseGameVersions(['1.21.1', 'Fabric', 'Client', 'Server']).environment, 'both');
  assert.equal(javaProvider.parseGameVersions(['1.21.1', 'ClientOnly', 'Dedicated']).environment, 'unknown');
  assert.equal(javaProvider.parseGameVersions(['Client', 'client']).environment, 'client');

  let capturedSearch = null;
  const loaderSearchProvider = javaCatalog.createProvider({
    catalogHttp: {
      isConfigured: () => true,
      request: async ({ url, params }) => {
        if (url.endsWith('/v1/categories')) {
          return { data: { data: [{ id: 6, slug: 'mc-mods', name: 'Mods', isClass: true }] } };
        }
        capturedSearch = params;
        return { data: { data: [], pagination: { totalCount: 0 } } };
      },
    },
  });
  await loaderSearchProvider.search('owo', { loader: 'neoforge' });
  assert.equal(capturedSearch.modLoaderType, 6);

  assert.equal(catalogDownloadPolicy.normalizeEnvironment('client'), 'client');
  assert.equal(catalogDownloadPolicy.normalizeEnvironment('SERVER'), 'server');
  assert.equal(catalogDownloadPolicy.normalizeEnvironment('both'), 'both');
  assert.equal(catalogDownloadPolicy.normalizeEnvironment(''), 'unknown');
  assert.equal(catalogDownloadPolicy.normalizeEnvironment('client-only'), 'unknown');
  assert.equal(catalogDownloadPolicy.annotateFile({ environment: 'client-only' }).environment, 'unknown');
  assert.equal(catalogDownloadPolicy.annotateFile({ environment: 'client-only' }).downloadable, true);
  assert.equal(catalogDownloadPolicy.annotateFile({ environment: 'client', downloadable: true }).downloadable, false);
  assert.equal(catalogDownloadPolicy.annotateFile({}).environment, 'unknown');
  assert.equal(catalogDownloadPolicy.annotateFile({}).downloadable, true);

  const clientJar = (id, env = 'client') => ({
    id: String(id),
    name: `${id}.jar`,
    fileName: `${id}.jar`,
    extension: '.jar',
    environment: env,
  });
  assert.equal(catalogDownloadPolicy.projectAvailability([clientJar(1), clientJar(2)]).downloadState, 'blocked');
  assert.equal(catalogDownloadPolicy.projectAvailability([clientJar(1), clientJar(2)]).blockedReason, 'client-only');
  assert.equal(catalogDownloadPolicy.projectAvailability([clientJar(1), clientJar(2, 'server')]).downloadState, 'requires-selection');
  assert.equal(catalogDownloadPolicy.projectAvailability([clientJar(1), clientJar(2, 'both')]).blockedReason, undefined);
  assert.notEqual(catalogDownloadPolicy.projectAvailability([clientJar(1), clientJar(2, 'both')]).downloadState, 'blocked');
  assert.notEqual(catalogDownloadPolicy.projectAvailability([clientJar(1), clientJar(2, 'unknown')]).downloadState, 'blocked');
  assert.notEqual(catalogDownloadPolicy.projectAvailability([]).downloadState, 'blocked');
  assert.equal(catalogDownloadPolicy.projectAvailability([]).downloadState, 'unknown');
  assert.notEqual(catalogDownloadPolicy.projectAvailability([
    { id: '1', name: 'pack.mcaddon', extension: '.mcaddon', environment: 'client' },
  ]).downloadState, 'blocked');
  assert.equal(catalogDownloadPolicy.projectAvailability([clientJar(1, 'server'), clientJar(2, 'server')]).downloadState, 'allowed');
  assert.equal(catalogDownloadPolicy.projectAvailability([clientJar(1)], { complete: false }).downloadState, 'unknown');

  const search = await javaProvider.search('optimization', { page: 1, pageSize: 10, category: 'curseforge-java:mc-mods' });
  assert.equal(search.results[0].edition, 'java');
  assert.equal(search.results[0].providerId, 'curseforge-java');
  assert.equal(search.results[0].loader, 'fabric');
  assert.equal(search.results[0].downloadState, 'unknown');

  const files = await javaProvider.listDownloadFiles(99);
  assert.equal(files[0].neoforge, true);
  assert.equal(files[0].edition, 'java');
  assert.equal(files.some((item) => item.fabric), true);
  const auto = await javaProvider.download(99, []);
  assert.equal(auto.needsSelection, true);
  const picked = files.find((item) => item.environment === 'client');
  assert.ok(picked.warning);
  await assert.rejects(
    () => javaProvider.download(99, ['11']),
    (err) => err.code === 'CLIENT_ONLY_FILE'
  );
  const serverPlan = await javaProvider.download(99, ['12']);
  assert.equal(serverPlan.plan, true);
  assert.equal(serverPlan.files.length, 1);
  assert.equal(serverPlan.files[0].environment, 'server');
  await assert.rejects(
    () => javaProvider.download(99, ['11', '12']),
    (err) => err.code === 'CLIENT_ONLY_FILE'
  );
  await assert.rejects(
    () => javaProvider.download(99, ['missing-id']),
    (err) => err.code === 'UNKNOWN_FILE_ID'
  );
  await assert.rejects(
    () => javaProvider.download(77, []),
    (err) => err.code === 'CLIENT_ONLY_FILE'
  );

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
      environment: '*',
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

    await assert.rejects(
      () => catalogLibrary.importDownloadPlan({
        project: { name: 'Sodium', slug: 'sodium-client', edition: 'java', source: 'curseforge', providerId: 'curseforge-java' },
        files: [{
          url: 'https://edge.forgecdn.net/files/sodium.jar',
          fileName: 'sodium-fabric.jar',
          environment: 'client',
        }],
      }, { allowHosts: ['edge.forgecdn.net'], providerId: 'curseforge-java' }),
      (err) => err.code === 'CLIENT_ONLY_FILE' && err.message.includes('Client-only')
    );
    assert.doesNotThrow(() => catalogDownloadPolicy.assertPlanNotClientOnly({
      project: { edition: 'bedrock', providerId: 'curseforge-bedrock' },
      files: [{ id: '1', fileName: 'pack.mcaddon', url: 'https://edge.forgecdn.net/pack.mcaddon' }],
    }));

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
        environment: 'both',
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
    assert.ok(fs.existsSync(row.file_path));
    assert.equal(JSON.parse(row.metadata_json).providerId, 'curseforge-java');

    const originalRename = fs.renameSync;
    fs.renameSync = () => {
      const err = new Error('EXDEV: cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    };
    try {
      const importedExdev = await catalogLibrary.importDownloadPlan({
        project: {
          name: 'Electroenergetics',
          slug: 'electroenergetics',
          edition: 'java',
          source: 'curseforge',
          providerId: 'curseforge-java',
          curseforgeId: 101,
          author: 'Create',
          websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/electroenergetics',
          artifactType: 'mod',
        },
        files: [{
          url: 'https://edge.forgecdn.net/files/electroenergetics.jar',
          fileName: 'electroenergetics-1.21.1-1.1.1.jar',
          fileId: 22,
          loader: 'neoforge',
          minecraftVersions: ['1.21.1'],
          environment: 'both',
          displayName: '1.1.1',
        }],
      }, { allowHosts: ['edge.forgecdn.net'], providerId: 'curseforge-java' });
      assert.equal(importedExdev.success, true);
      const exdevRow = db.prepare('SELECT * FROM mods WHERE id = ?').get(importedExdev.modId);
      assert.ok(fs.existsSync(exdevRow.file_path), 'catalog import should copy across filesystems on EXDEV');
      assert.match(exdevRow.file_path, /electroenergetics-1\.21\.1-1\.1\.1\.jar$/);
    } finally {
      fs.renameSync = originalRename;
    }
  } finally {
    controlledDownload.downloadToFile = originalDownload;
  }

  catalogDownloadPolicy.clearAvailabilityCache();
  catalogProviderRegistry.clear();
  catalogService.ensureProviders();
  let listCalls = 0;
  let downloadCalls = 0;
  let currentFiles = [];
  catalogProviderRegistry.register({
    id: 'catalog-curseforge-java',
    source: 'bundled',
    capabilities: ['provider:catalog-source'],
  }, {
    getMetadata: () => ({
      id: 'curseforge-java',
      name: 'CurseForge Java',
      source: 'curseforge',
      editions: ['java'],
      downloadHosts: ['edge.forgecdn.net'],
    }),
    isAvailable: () => true,
    getCategories: async () => [],
    search: async () => ({
      results: [{
        id: 99,
        providerId: 'curseforge-java',
        edition: 'java',
        curseforgeId: 99,
        slug: 'sodium',
        name: 'Sodium',
        downloadState: 'blocked',
        blockedReason: 'client-only',
      }],
      total: 1,
      page: 1,
    }),
    getDetails: async () => ({
      id: 99,
      providerId: 'curseforge-java',
      edition: 'java',
      curseforgeId: 99,
      slug: 'sodium',
    }),
    listDownloadFiles: async () => {
      listCalls += 1;
      return currentFiles;
    },
    download: async (projectId, selection) => {
      downloadCalls += 1;
      const selected = (selection || []).map(String);
      if (selected.some((id) => ['11', '21', '22'].includes(id))) {
        const err = new Error('Client-only files cannot be downloaded for a dedicated server.');
        err.code = 'CLIENT_ONLY_FILE';
        err.status = 400;
        throw err;
      }
      const wanted = currentFiles.filter((file) => selected.includes(String(file.id)));
      return { success: true, name: 'ok', files: wanted.map((file) => file.name), projectId };
    },
  });

  currentFiles = [
    { id: '21', name: 'a.jar', fileName: 'a.jar', extension: '.jar', environment: 'client', loader: 'fabric' },
    { id: '22', name: 'b.jar', fileName: 'b.jar', extension: '.jar', environment: 'client', loader: 'fabric' },
  ];
  const blocked = await catalogService.downloadMod('iris', { provider: 'curseforge-java', curseforgeId: 77, edition: 'java' });
  assert.equal(blocked.downloadState, 'blocked');
  assert.equal(blocked.blockedReason, 'client-only');
  assert.equal(blocked.selectableFileCount, 0);
  assert.equal(downloadCalls, 0);
  await assert.rejects(
    () => catalogService.downloadMod('iris', { provider: 'curseforge-java', curseforgeId: 77, edition: 'java', files: ['21'] }),
    (err) => err.code === 'CLIENT_ONLY_FILE'
  );

  currentFiles = [
    { id: '11', name: 'client.jar', fileName: 'client.jar', extension: '.jar', environment: 'client', loader: 'fabric' },
    { id: '12', name: 'server.jar', fileName: 'server.jar', extension: '.jar', environment: 'server', loader: 'neoforge' },
  ];
  catalogDownloadPolicy.clearAvailabilityCache();
  await assert.rejects(
    () => catalogService.downloadMod('sodium', { provider: 'curseforge-java', curseforgeId: 99, edition: 'java', files: ['11'] }),
    (err) => err.code === 'CLIENT_ONLY_FILE'
  );
  await assert.rejects(
    () => catalogService.downloadMod('sodium', { provider: 'curseforge-java', curseforgeId: 99, edition: 'java', files: ['11', '12'] }),
    (err) => err.code === 'CLIENT_ONLY_FILE'
  );
  await assert.rejects(
    () => catalogService.downloadMod('sodium', { provider: 'curseforge-java', curseforgeId: 99, edition: 'java', files: ['999'], loader: 'fabric' }),
    (err) => err.code === 'UNKNOWN_FILE_ID'
  );
  const picker = await catalogService.downloadMod('sodium', { provider: 'curseforge-java', curseforgeId: 99, edition: 'java' });
  assert.equal(picker.needsSelection, true);
  assert.equal(picker.downloadState, 'requires-selection');
  assert.equal(picker.files.find((item) => item.id === '11').downloadable, false);
  assert.equal(picker.files.find((item) => item.id === '12').downloadable, true);

  currentFiles = [
    { id: '41', name: 'srv.jar', fileName: 'srv.jar', extension: '.jar', environment: 'server', loader: 'fabric' },
  ];
  catalogDownloadPolicy.clearAvailabilityCache();
  const javaSinglePicker = await catalogService.downloadMod('server-mod', {
    provider: 'curseforge-java',
    curseforgeId: 41,
    edition: 'java',
  });
  assert.equal(javaSinglePicker.needsSelection, true, 'Java downloads should ask for files and a launcher');
  await assert.rejects(
    () => catalogService.downloadMod('server-mod', {
      provider: 'curseforge-java',
      curseforgeId: 41,
      edition: 'java',
      files: ['41'],
    }),
    (err) => err.code === 'LOADER_REQUIRED'
  );
  const serverResult = await catalogService.downloadMod('server-mod', {
    provider: 'curseforge-java',
    curseforgeId: 41,
    edition: 'java',
    files: ['41'],
    loader: 'fabric',
  });
  assert.equal(serverResult.success, true);

  currentFiles = [
    { id: '31', name: 'both.jar', fileName: 'both.jar', extension: '.jar', environment: 'both', loader: 'fabric' },
  ];
  catalogDownloadPolicy.clearAvailabilityCache();
  const bothResult = await catalogService.downloadMod('both-mod', {
    provider: 'curseforge-java',
    curseforgeId: 31,
    edition: 'java',
    files: ['31'],
    loader: 'fabric',
  });
  assert.equal(bothResult.success, true);

  currentFiles = [
    { id: '11', name: 'client.jar', fileName: 'client.jar', extension: '.jar', environment: 'client', loader: 'fabric' },
    { id: '12', name: 'server.jar', fileName: 'server.jar', extension: '.jar', environment: 'server', loader: 'neoforge' },
  ];
  catalogDownloadPolicy.clearAvailabilityCache();
  listCalls = 0;
  await catalogService.listDownloadFiles('sodium', { provider: 'curseforge-java', curseforgeId: 99, edition: 'java' });
  await catalogService.listDownloadFiles('sodium', { provider: 'curseforge-java', curseforgeId: 99, edition: 'java' });
  assert.equal(listCalls, 1);
  const cached = catalogDownloadPolicy.getCachedAvailability('curseforge-java', 99);
  assert.ok(cached);
  assert.equal(JSON.stringify(cached).includes('cf-test-secret'), false);
  assert.equal(JSON.stringify(cached).toLowerCase().includes('x-api-key'), false);
  assert.equal(cached.files.some((file) => file.url || file.headers || file.apiKey), false);
  catalogDownloadPolicy.setCachedAvailability('curseforge-java', 99, {
    files: currentFiles,
    availability: { downloadState: 'requires-selection' },
  }, { at: Date.now() - catalogDownloadPolicy.CACHE_TTL_MS - 25 });
  assert.equal(catalogDownloadPolicy.getCachedAvailability('curseforge-java', 99), null);

  catalogDownloadPolicy.clearAvailabilityCache();
  const searchSanitized = await catalogService.searchMods('x', { provider: 'curseforge-java', edition: 'java' });
  assert.equal(searchSanitized.results[0].downloadState, 'unknown');
  assert.equal(searchSanitized.results[0].blockedReason, undefined);

  const frontendSource = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/ModCatalog.jsx'), 'utf8');
  assert.match(frontendSource, /Client Side Only/);
  assert.match(frontendSource, /btn-client-only/);
  assert.match(frontendSource, /isClientOnlyProject/);
  assert.match(frontendSource, /All available Java files are marked client-only/);
  assert.match(frontendSource, /downloadable === false/);
  assert.match(frontendSource, /setDownloadModal\(null\)/);
  assert.match(frontendSource, /onClick=\{\(\) => \{ if \(!downloading\) setDownloadModal\(null\); \}\}/);
  assert.doesNotMatch(frontendSource, /dangerouslySetInnerHTML/);
  const uiClientOnly = { downloadState: 'blocked', blockedReason: 'client-only' };
  const uiMixed = { downloadState: 'requires-selection' };
  const uiUnknown = { downloadState: 'unknown' };
  assert.equal(uiClientOnly.downloadState === 'blocked' && uiClientOnly.blockedReason === 'client-only', true);
  assert.equal(uiMixed.downloadState === 'blocked', false);
  assert.equal(uiUnknown.downloadState === 'blocked', false);
  assert.deepEqual(
    [{ id: '1', downloadable: false }, { id: '2' }].filter((file) => file.downloadable !== false).map((file) => file.id),
    ['2']
  );
  assert.deepEqual(
    [{ id: 'pack', extension: '.mcaddon' }].filter((file) => file.downloadable !== false).map((file) => file.id),
    ['pack']
  );

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
