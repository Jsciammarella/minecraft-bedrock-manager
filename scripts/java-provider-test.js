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

async function runJavaProviderTests({ pluginHost, testRoot }) {
  const pluginCapabilities = require('../server/services/pluginCapabilities');
  const javaLoaderRegistry = require('../server/services/javaLoaderRegistry');
  const gatewayRegistry = require('../server/services/gatewayRegistry');
  const controlledFs = require('../server/services/controlledFs');
  const controlledDownload = require('../server/services/controlledDownload');
  const controlledProcess = require('../server/services/controlledProcess');
  const childEnv = require('../server/services/childEnv');
  const javaLoaderHost = require('../server/services/javaLoaderHost');
  const javaModMetadata = require('../server/services/javaModMetadata');
  const zipGuard = require('../server/services/zipGuard');
  const gatewayManager = require('../server/services/gatewayManager');
  const fabric = require('../server/bundled-plugins/java-loader-fabric/backend');
  const neoforge = require('../server/bundled-plugins/java-loader-neoforge/backend');
  const geyser = require('../server/bundled-plugins/gateway-geyser/backend');
  const db = require('../server/db/connection');

  assert.equal(pluginCapabilities.parseCapabilities(['not-a-cap'], 'bundled').ok, false);
  const uploadedCaps = pluginCapabilities.parseCapabilities(['provider:java-loader', 'ui:pages'], 'user');
  assert.deepEqual(uploadedCaps.capabilities, ['ui:pages']);
  assert.deepEqual(uploadedCaps.rejectedPrivileged, ['provider:java-loader']);

  pluginHost.resetForTests();
  javaLoaderRegistry.clear();
  gatewayRegistry.clear();

  const bundledDir = path.join(testRoot, 'bundled-plugins');
  const userDir = pluginHost.USER_PLUGINS_DIR;
  fs.mkdirSync(path.join(bundledDir, 'ok-loader'), { recursive: true });
  fs.writeFileSync(path.join(bundledDir, 'ok-loader', 'plugin.json'), JSON.stringify({
    id: 'ok-loader',
    name: 'Ok Loader',
    pages: [],
    menus: [],
    backend: 'backend.js',
    capabilities: ['provider:java-loader', 'download:official-sources', 'runtime:java'],
    downloadHosts: ['example.test'],
  }));
  fs.writeFileSync(path.join(bundledDir, 'ok-loader', 'backend.js'), `
    module.exports = {
      register({ registerJavaLoader }) {
        registerJavaLoader({
          getMetadata: () => ({ id: 'fixture', name: 'Fixture', downloadHosts: ['example.test'] }),
          listMinecraftVersions: async () => ['1.21.1'],
          listLoaderVersions: async () => ['0.16.0'],
          resolveInstallation: async () => ({ loader: 'fixture', minecraftVersion: '1.21.1', loaderVersion: '0.16.0', javaMajor: 21 }),
          planInstallation: async () => ({ downloads: [], result: { loader: 'fixture', minecraftVersion: '1.21.1' } }),
          planUpdate: async () => ({ downloads: [], result: { loader: 'fixture' } }),
          getLaunchSpecification: () => ({ runtime: 'java', jar: 'server.jar', arguments: ['nogui'] }),
          getModSupport: () => ({ supportsMods: true, modsDirectory: 'mods' }),
          validateMod: () => ({ ok: true, warnings: [] }),
          getBackupPaths: () => ['world'],
          getHealthInformation: () => ({ ok: true }),
        });
      }
    };
  `);

  const prevBundled = process.env.MC_MANAGER_BUNDLED_PLUGINS_DIR;
  process.env.MC_MANAGER_BUNDLED_PLUGINS_DIR = bundledDir;
  pluginHost.resetForTests();
  // pluginHost already captured BUNDLED_PLUGINS_DIR at load. Register via loadPlugins([bundledDir])
  // and sourceFromDir compares to pluginHost.BUNDLED_PLUGINS_DIR constant.
  // For tests, load from bundledDir but mark as bundled by using BUNDLED_PLUGINS_DIR path.

  const realBundled = pluginHost.BUNDLED_PLUGINS_DIR;
  const loaded = pluginHost.loadPlugins([realBundled, bundledDir]);
  const vanilla = javaLoaderRegistry.get('vanilla');
  if (vanilla) {
    assert.equal(vanilla.pluginId, 'java-loader-vanilla');
  }
  pluginHost.resetForTests();
  javaLoaderRegistry.clear();
  gatewayRegistry.clear();

  // Treat test folder as bundled by loading only that dir while copying into a dir named like bundled.
  // Direct register API:
  const fakePlugin = {
    id: 'ok-loader',
    source: 'bundled',
    capabilities: ['provider:java-loader'],
  };
  javaLoaderRegistry.register(fakePlugin, {
    getMetadata: () => ({ id: 'fixture', name: 'Fixture', downloadHosts: ['example.test'] }),
    listMinecraftVersions: async () => ['1.21.1'],
    listLoaderVersions: async () => ['0.16.0'],
    resolveInstallation: async () => ({ loader: 'fixture' }),
    planInstallation: async () => ({ downloads: [], result: { loader: 'fixture' } }),
    planUpdate: async () => ({ downloads: [], result: { loader: 'fixture' } }),
    getLaunchSpecification: () => ({ runtime: 'java', jar: 'server.jar', arguments: ['nogui'] }),
    getModSupport: () => ({ supportsMods: true, modsDirectory: 'mods' }),
    validateMod: () => ({ ok: true, warnings: [] }),
    getBackupPaths: () => ['world'],
    getHealthInformation: () => ({ ok: true }),
  });
  assert.equal(javaLoaderRegistry.list().some((item) => item.id === 'fixture'), true);
  assert.throws(
    () => javaLoaderRegistry.register(fakePlugin, {
      getMetadata: () => ({ id: 'fixture', name: 'Dup' }),
      listMinecraftVersions: async () => [],
      listLoaderVersions: async () => [],
      resolveInstallation: async () => ({}),
      planInstallation: async () => ({ downloads: [] }),
      planUpdate: async () => ({ downloads: [] }),
      getLaunchSpecification: () => ({ runtime: 'java', arguments: [] }),
      getModSupport: () => ({ supportsMods: false }),
      validateMod: () => ({ ok: true }),
      getBackupPaths: () => [],
      getHealthInformation: () => ({}),
    }),
    /already registered/
  );
  javaLoaderRegistry.unregisterPlugins(['ok-loader']);
  assert.equal(javaLoaderRegistry.get('fixture'), null);

  assert.throws(
    () => javaLoaderRegistry.register({ id: 'evil', source: 'user', capabilities: ['provider:java-loader'] }, {
      getMetadata: () => ({ id: 'evil' }),
      listMinecraftVersions: async () => [],
      listLoaderVersions: async () => [],
      resolveInstallation: async () => ({}),
      planInstallation: async () => ({ downloads: [] }),
      planUpdate: async () => ({ downloads: [] }),
      getLaunchSpecification: () => ({ runtime: 'java', arguments: [] }),
      getModSupport: () => ({ supportsMods: false }),
      validateMod: () => ({ ok: true }),
      getBackupPaths: () => [],
      getHealthInformation: () => ({}),
    }),
    /bundled/
  );

  const userPluginDir = path.join(userDir, 'evil-provider');
  fs.mkdirSync(userPluginDir, { recursive: true });
  fs.writeFileSync(path.join(userPluginDir, 'plugin.json'), JSON.stringify({
    id: 'evil-provider',
    name: 'Evil',
    pages: [],
    menus: [],
    capabilities: ['provider:java-loader'],
  }));
  await assert.rejects(
    async () => {
      const zipPath = path.join(testRoot, 'evil.zip');
      fs.writeFileSync(zipPath, zipStore({
        'evil-provider/plugin.json': JSON.stringify({
          id: 'evil-provider',
          name: 'Evil',
          capabilities: ['provider:java-loader'],
          pages: [{ id: 'home', title: 'x', file: 'index.html' }],
        }),
        'evil-provider/ui/index.html': '<html></html>',
      }));
      await pluginHost.installPluginFromZip(zipPath);
    },
    /system-provider capabilities/i
  );

  const scopedRoot = path.join(testRoot, 'fs-root');
  fs.mkdirSync(scopedRoot, { recursive: true });
  const fsApi = controlledFs.scoped(scopedRoot);
  assert.throws(() => fsApi.resolve('../secret'), /traversal/i);
  assert.throws(() => fsApi.resolve('/etc/passwd'), /Absolute/i);
  fsApi.writeFileAtomic('ok.txt', 'hello');
  assert.equal(fs.readFileSync(path.join(scopedRoot, 'ok.txt'), 'utf8'), 'hello');

  const zipPath = path.join(testRoot, 'bad.zip');
  fs.writeFileSync(zipPath, zipStore({ '../escape.txt': 'nope', 'ok.txt': 'yes' }));
  assert.throws(() => zipGuard.assertSafeZipNames(zipGuard.listStoredZipEntries(zipPath)), /Malicious/);

  assert.throws(
    () => controlledDownload.assertHttpsUrl('http://example.com/a', ['example.com']),
    /HTTPS/
  );
  assert.throws(
    () => controlledDownload.assertHttpsUrl('https://evil.example/a', ['piston-meta.mojang.com']),
    /approved download list/
  );
  controlledDownload.assertHttpsUrl('https://meta.fabricmc.net/v2/versions/game', ['meta.fabricmc.net']);

  assert.throws(() => controlledProcess.assertArgArray('rm -rf /', 'Java'), /argument array/);
  assert.throws(
    () => javaLoaderHost.validatePlan({ command: 'java -jar server.jar' }),
    /shell/
  );
  assert.throws(
    () => javaLoaderHost.validateLaunchSpec({ command: '/bin/sh', arguments: ['-c', 'id'] }, scopedRoot),
    /shell/
  );

  const env = childEnv.sanitizedChildEnv({ JAVA_HOME: 'C:\\java' });
  assert.equal(env.MC_MANAGER_DB_PATH, undefined);
  process.env.MC_MANAGER_FAKE_SECRET = 's3cret-value';
  const env2 = childEnv.sanitizedChildEnv();
  assert.equal(env2.MC_MANAGER_FAKE_SECRET, undefined);
  delete process.env.MC_MANAGER_FAKE_SECRET;

  const fabricProvider = fabric.createProvider({
    http: {
      getJson: async (url) => {
        if (url.endsWith('/versions/game')) return [{ version: '1.21.1', stable: true }];
        if (url.includes('/versions/loader/1.21.1')) return [{ loader: { version: '0.16.0' } }];
        if (url.endsWith('/versions/installer')) return [{ version: '1.0.1', stable: true }];
        throw new Error(`unexpected ${url}`);
      },
    },
  });
  const fabricPlan = await fabricProvider.planInstallation({ minecraftVersion: '1.21.1', loaderVersion: '0.16.0' });
  javaLoaderHost.validatePlan(fabricPlan);
  assert.match(fabricPlan.downloads[0].url, /meta\.fabricmc\.net/);
  await assert.rejects(
    () => fabricProvider.resolveInstallation({ minecraftVersion: '1.16.5' }),
    /not available/
  );

  const neoProvider = neoforge.createProvider({
    http: {
      getText: async () => '<metadata><versioning><versions><version>21.1.66</version></versions></versioning></metadata>',
    },
  });
  const neoPlan = await neoProvider.planInstallation({ minecraftVersion: '1.21.1' });
  javaLoaderHost.validatePlan(neoPlan);
  assert.equal(neoPlan.installer.runtime, 'java');
  assert.ok(Array.isArray(neoPlan.installer.arguments));
  const neoSpec = neoProvider.getLaunchSpecification({
    loader_version: '21.1.66',
    java_major: 21,
    loader_metadata: JSON.stringify(neoPlan.result),
  });
  assert.ok(neoSpec.arguments[0].startsWith('@'));
  javaLoaderHost.validateLaunchSpec(neoSpec, scopedRoot);

  const jarPath = path.join(testRoot, 'fabric-mod.jar');
  fs.writeFileSync(jarPath, zipStore({
    'fabric.mod.json': JSON.stringify({
      id: 'demo',
      name: 'Demo',
      version: '1.2.3',
      environment: 'client',
      depends: { fabricloader: '*', minecraft: '1.21.1' },
    }),
  }));
  const fabricMeta = javaModMetadata.inspectJar(jarPath);
  assert.equal(fabricMeta.loader, 'fabric');
  assert.equal(fabricMeta.environment, 'client');
  const neoJar = path.join(testRoot, 'neo-mod.jar');
  fs.writeFileSync(neoJar, zipStore({
    'META-INF/neoforge.mods.toml': 'modId="demo"\nversion="2.0.0"\ndisplayName="Demo Neo"\n',
  }));
  const neoMeta = javaModMetadata.inspectJar(neoJar);
  assert.equal(neoMeta.loader, 'neoforge');

  const clientCheck = fabricProvider.validateMod(
    { minecraft_version: '1.21.1', loader_provider_id: 'fabric' },
    { loader: 'fabric', minecraftVersions: ['1.21.1'], environment: 'client', sourceType: 'upload' }
  );
  assert.equal(clientCheck.ok, true);
  assert.ok(clientCheck.warnings.some((item) => /client-only/i.test(item)));
  const badLoader = fabricProvider.validateMod(
    { minecraft_version: '1.21.1' },
    { loader: 'neoforge', minecraftVersions: ['1.21.1'] }
  );
  assert.equal(badLoader.ok, false);

  const geyserProvider = geyser.createProvider();
  const gPlan = await geyserProvider.planInstallation({});
  javaLoaderHost.validatePlan(gPlan);
  const publicGw = geyserProvider.sanitizePublicRecord({
    id: 1,
    name: 'g',
    floodgate_key_path: '/secret/key.pem',
    authentication: 'floodgate',
  });
  assert.equal(publicGw.floodgate_key_path, undefined);
  assert.equal(publicGw.floodgateConfigured, true);

  assert.throws(() => gatewayManager.allocateUdpPort(19132), /reserved/);
  const taken = gatewayManager.takenPorts();
  assert.ok(taken instanceof Set);

  const migrated = db.prepare("SELECT loader_provider_id FROM servers WHERE kind = 'java' LIMIT 1").get();
  if (migrated) assert.equal(migrated.loader_provider_id, 'vanilla');

  if (prevBundled == null) delete process.env.MC_MANAGER_BUNDLED_PLUGINS_DIR;
  else process.env.MC_MANAGER_BUNDLED_PLUGINS_DIR = prevBundled;
  pluginHost.resetForTests();
  javaLoaderRegistry.clear();
  gatewayRegistry.clear();
}

module.exports = { runJavaProviderTests };
