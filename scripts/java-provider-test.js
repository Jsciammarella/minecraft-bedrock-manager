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

  await assert.rejects(
    async () => {
      const zipPath = path.join(testRoot, 'evil-gateway.zip');
      fs.writeFileSync(zipPath, zipStore({
        'evil-gateway/plugin.json': JSON.stringify({
          id: 'evil-gateway',
          name: 'Evil Gateway',
          capabilities: ['provider:gateway'],
          pages: [{ id: 'home', title: 'x', file: 'index.html' }],
        }),
        'evil-gateway/ui/index.html': '<html></html>',
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
  const badMc = fabricProvider.validateMod(
    { minecraft_version: '1.26.1', loader_provider_id: 'fabric' },
    { loader: 'fabric', minecraftVersions: ['1.21.1'] }
  );
  assert.equal(badMc.ok, false);
  assert.match(badMc.error, /1\.26\.1/);
  const minecraftVersions = require('../server/services/minecraftVersions');
  assert.equal(minecraftVersions.supportsMinecraftVersion(['1.21.1'], '1.26.1'), false);
  assert.equal(minecraftVersions.supportsMinecraftVersion(['1.21'], '1.21.1'), true);
  assert.equal(minecraftVersions.supportsMinecraftVersion([], '1.26.1'), true);
  const javaModDependencies = require('../server/services/javaModDependencies');
  const crashDeps = javaModDependencies.parseLoaderCrash(
    'Mod yagm requires architectury 13.0.8 or above\nCurrently, architectury is not installed'
  );
  assert.ok(crashDeps.some((item) => String(item.id).toLowerCase() === 'architectury'));
  const neoForgeLog = [
    "Missing or unsupported mandatory dependencies:",
    "\tMod ID: 'architectury', Requested by: 'yagm', Expected range: '[13.0.8,)', Actual version: '[MISSING]'",
    "Error during pre-loading phase: Mod yagm requires architectury 13.0.8 or above",
    "Currently, architectury is not installed",
    "Failure message: Mod yagm requires architectury 13.0.8 or above",
    "\t- Mod yagm requires architectury 13.0.8 or above",
  ].join('\n');
  const neoForgeDeps = javaModDependencies.parseLoaderCrash(neoForgeLog);
  assert.ok(neoForgeDeps.some((item) => String(item.id).toLowerCase() === 'architectury' && String(item.version).includes('13.0.8')));
  assert.equal(javaModDependencies.looksLikeDependencyFailure("Missing or unsupported mandatory dependencies:"), true);
  assert.equal(javaModDependencies.looksLikeDependencyFailure("\tMod ID: 'architectury', Requested by: 'yagm', Expected range: '[13.0.8,)', Actual version: '[MISSING]'"), true);
  const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-java-deps-'));
  fs.mkdirSync(path.join(crashDir, 'crash-reports'));
  fs.writeFileSync(path.join(crashDir, 'crash-reports', 'crash-2026-08-23_04.51.26-fml.txt'), neoForgeLog);
  const crashReportText = javaModDependencies.readCrashReports(crashDir);
  assert.ok(javaModDependencies.parseLoaderCrash(crashReportText).some((item) => String(item.id).toLowerCase() === 'architectury'));
  fs.rmSync(crashDir, { recursive: true, force: true });
  const neoToml = javaModMetadata.detectNeoForge(`
modLoader="javafml"
[[mods]]
modId="yagm"
version="0.1"
displayName="Yet Another Gravestone Mod"
[[dependencies.yagm]]
modId="neoforge"
mandatory=true
versionRange="[21.1,)"
[[dependencies.yagm]]
modId="architectury"
mandatory=true
versionRange="[13.0.8,)"
`);
  assert.ok(neoToml.dependencies.some((item) => item.id === 'architectury' && !item.optional));
  const owoLog = [
    "Skipping jar. File /tmp/mods/owo-lib-0.13.0-alpha.15_1.21.jar is a Fabric mod and cannot be loaded",
    "Mod ID: 'owo', Requested by: 'accessories', Expected range: '[0.12.15.0+1.21,)', Actual version: '[MISSING]'",
    'Mod accessories requires owo 0.12.15.0+1.21 or above',
    'Currently, owo is not installed',
  ].join('\n');
  const owoDeps = javaModDependencies.parseLoaderCrash(owoLog);
  assert.ok(owoDeps.some((item) => String(item.id).toLowerCase() === 'owo'));
  const skipped = javaModDependencies.parseWrongLoaderSkips(owoLog);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].filePath, /owo-lib-0\.13\.0-alpha\.15_1\.21\.jar$/);
  assert.equal(skipped[0].loader, 'fabric');
  assert.equal(javaModDependencies.looksLikeDependencyFailure(owoLog), true);
  assert.equal(javaModDependencies.fileMatchesServer(
    { loader: 'fabric', environment: 'both', minecraftVersions: ['1.21.1'] },
    { loader_provider_id: 'neoforge', minecraft_version: '1.21.1' }
  ), false);
  assert.equal(javaModDependencies.fileMatchesServer(
    { loader: 'neoforge', environment: 'both', minecraftVersions: ['1.21.1'] },
    { loader_provider_id: 'neoforge', minecraft_version: '1.21.1' }
  ), true);
  assert.equal(javaModDependencies.fileMatchesServer(
    { loader: 'unknown', environment: 'both', minecraftVersions: ['1.21.1'] },
    { loader_provider_id: 'neoforge', minecraft_version: '1.21.1' }
  ), false);
  assert.equal(javaModDependencies.fileMatchesServer(
    { loader: 'unknown', environment: 'both', minecraftVersions: ['1.21.1'] },
    { loader_provider_id: 'neoforge', minecraft_version: '1.21.1' },
    { allowUnknown: true }
  ), true);
  assert.equal(javaModDependencies.fileMatchesServer(
    { loader: 'unknown', fabric: true, environment: 'both', minecraftVersions: ['1.21.1'] },
    { loader_provider_id: 'neoforge', minecraft_version: '1.21.1' },
    { allowUnknown: true }
  ), false);
  const javaModFiles = require('../server/services/javaModFiles');
  const fabricLibraryMod = {
    file_path: '/tmp/owo-lib-fabric.jar',
    loader: 'fabric',
    extra_files: null,
    sha256: 'abc123',
    minecraft_versions: JSON.stringify(['1.21.1']),
    environment: 'both',
  };
  const neoServer = { loader_provider_id: 'neoforge', minecraft_version: '1.21.1' };
  assert.equal(javaModFiles.bestFileForServer(fabricLibraryMod, neoServer, { sha256: 'abc123' }), null);
  assert.equal(javaModFiles.bestFileForServer(fabricLibraryMod, neoServer, { sha256: 'abc123', allowMismatch: true })?.sha256, 'abc123');
  const modCompatibility = require('../server/services/modCompatibility');
  assert.equal(modCompatibility.loadersCompatible('fabric', 'neoforge', { allowUnknown: false }), false);
  assert.equal(modCompatibility.loadersCompatible('neoforge', 'neoforge', { allowUnknown: false }), true);
  const catalogLibrary = require('../server/services/catalogLibrary');
  assert.equal(catalogLibrary.resolvedCatalogLoader({
    jarLoader: 'fabric',
    fileLoader: 'unknown',
    requestedLoader: 'neoforge',
  }), 'fabric');
  const fabricToml = javaModMetadata.detectFabric(JSON.stringify({
    id: 'yagm',
    name: 'YAGM',
    depends: { minecraft: '~1.21.1', architectury: '>=13.0.8' },
    recommends: { cloth: '*' },
  }));
  assert.deepEqual(fabricToml.minecraftVersions, ['1.21.1']);
  assert.ok(fabricToml.dependencies.some((item) => item.id === 'architectury' && !item.optional));
  assert.ok(fabricToml.dependencies.some((item) => item.id === 'cloth' && item.optional));

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

  const geyserUi = fs.readFileSync(path.join(__dirname, '../server/bundled-plugins/gateway-geyser/ui/geyser.js'), 'utf8');
  assert.match(geyserUi, /\/api\/plugins\/gateway-geyser/);
  assert.match(geyserUi, /floodgateHint/);
  assert.doesNotMatch(geyserUi, /\/api\/gateways/);
  assert.equal(pluginHost.isAllowedPluginApiPath('hello-world', '/api/plugins/gateway-geyser/gateways'), false);
  assert.equal(pluginHost.isAllowedPluginApiPath('gateway-geyser', '/api/gateways'), false);
  assert.equal(pluginHost.isAllowedPluginApiPath('gateway-geyser', '/api/plugins/gateway-geyser/gateways'), true);

  pluginHost.resetForTests();
  gatewayRegistry.clear();
  pluginHost.loadPlugins([pluginHost.BUNDLED_PLUGINS_DIR]);
  assert.equal(modCompatibility.compatibleWithServer(
    { edition: 'java', loader: 'fabric', minecraft_versions: JSON.stringify(['1.21.1']) },
    { kind: 'java', loader_provider_id: 'fabric', minecraft_version: '1.26.1' }
  ), false);
  assert.equal(modCompatibility.compatibleWithServer(
    { edition: 'java', loader: 'fabric', minecraft_versions: JSON.stringify(['1.21.1']) },
    { kind: 'java', loader_provider_id: 'fabric', minecraft_version: '1.21.1' }
  ), true);
  assert.equal(modCompatibility.compatibleWithServer(
    {
      edition: 'java',
      loader: 'neoforge',
      file_path: '/tmp/neoforge-old.jar',
      minecraft_versions: JSON.stringify(['1.20.1']),
      extra_files: JSON.stringify([{
        path: '/tmp/fabric-new.jar',
        name: 'fabric-new.jar',
        loader: 'fabric',
        minecraftVersions: ['1.21.1'],
        environment: 'both',
      }]),
    },
    { kind: 'java', loader_provider_id: 'fabric', minecraft_version: '1.21.1' }
  ), true);
  const modArchives = require('../server/services/modArchives');
  const serialized = JSON.parse(modArchives.serializeExtraFiles([{
    path: '/tmp/fabric-new.jar',
    name: 'fabric-new.jar',
    loader: 'fabric',
    minecraftVersions: ['1.21.1'],
    sha256: 'abc',
  }]));
  assert.equal(serialized[0].loader, 'fabric');
  assert.deepEqual(serialized[0].minecraftVersions, ['1.21.1']);
  const libraryUi = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/ModLibrary.jsx'), 'utf8');
  assert.match(libraryUi, /Downloaded jars/);
  assert.match(libraryUi, /Add jar files/);
  const tileUi = fs.readFileSync(path.join(__dirname, '../frontend/src/components/ModTileTags.jsx'), 'utf8');
  assert.match(tileUi, /slice\(0, 8\)/);
  const detailUi = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/ServerDetail.jsx'), 'utf8');
  assert.match(detailUi, /Re-evaluate/);
  assert.match(detailUi, /Wrong version \/ launcher/);
  const fgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-key-'));
  const fgServerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-java-'));
  const fgEmptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-none-'));
  try {
    const keyPath = gatewayManager.writeFloodgateKey(fgDir);
    assert.equal(fs.readFileSync(keyPath).length, 16);
    const kept = fs.readFileSync(keyPath);
    assert.equal(gatewayManager.ensureFloodgateKey(fgDir), keyPath);
    assert.ok(fs.readFileSync(keyPath).equals(kept));
    fs.writeFileSync(keyPath, Buffer.concat([
      Buffer.from(crypto.randomBytes(16).toString('base64')),
      Buffer.from('\n'),
    ]));
    assert.equal(fs.readFileSync(keyPath).length, 25);
    gatewayManager.ensureFloodgateKey(fgDir);
    assert.equal(fs.readFileSync(keyPath).length, 16);

    fs.mkdirSync(path.join(fgServerDir, 'plugins'));
    fs.writeFileSync(path.join(fgServerDir, 'plugins', 'Floodgate-Spigot.jar'), Buffer.alloc(0));
    const copied = gatewayManager.copyFloodgateKeyToLocalServer(keyPath, { id: 1, data_path: fgServerDir });
    assert.equal(copied.length, 1);
    assert.ok(copied[0].endsWith(path.join('plugins', 'floodgate', 'key.pem')));
    assert.ok(fs.readFileSync(copied[0]).equals(fs.readFileSync(keyPath)));
    assert.deepEqual(gatewayManager.copyFloodgateKeyToLocalServer(keyPath, { id: 2, data_path: fgEmptyDir }), []);
  } finally {
    fs.rmSync(fgDir, { recursive: true, force: true });
    fs.rmSync(fgServerDir, { recursive: true, force: true });
    fs.rmSync(fgEmptyDir, { recursive: true, force: true });
  }

  try { db.prepare("DELETE FROM gateways WHERE name IN ('Isolated Geyser', 'Missing provider', 'Offline no confirm', 'Remote floodgate', 'Floodgate Key', 'While disabled', 'Escape')").run(); } catch { /* ignore */ }
  assert.ok(gatewayRegistry.get('geyser'), 'bundled Geyser plugin should register');
  const geyserMeta = gatewayRegistry.list().find((item) => item.id === 'geyser');
  assert.deepEqual(geyserMeta.targetKinds, ['java']);
  assert.equal(geyserMeta.supportsCreateForTarget, true);
  assert.equal(geyserMeta.managementPluginId, 'gateway-geyser');
  assert.ok(pluginHost.getMenuItems().some((item) => item.pluginId === 'gateway-geyser' && item.label === 'Geyser'));
  assert.equal(pluginHost.getMenuItems().some((item) => item.path === '/gateways'), false);
  const geyserPlugin = pluginHost.getPlugin('gateway-geyser');
  const geyserPublic = pluginHost.publicPlugin(geyserPlugin);
  assert.equal(geyserPublic.pages[0].file, 'index.html');
  assert.ok(pluginHost.resolveUiFile(geyserPlugin, geyserPublic.pages[0].file));

  const pluginRoutes = require('../server/routes/plugins');
  const geyserUiApp = require('express')();
  geyserUiApp.use('/api/plugins', pluginRoutes);
  const geyserUiServer = geyserUiApp.listen(0);
  try {
    const origin = `http://127.0.0.1:${geyserUiServer.address().port}`;
    const metaRes = await fetch(`${origin}/api/plugins/gateway-geyser/meta`);
    const meta = await metaRes.json();
    assert.equal(meta.pages[0].file, 'index.html');
    const uiRes = await fetch(`${origin}/api/plugins/gateway-geyser/ui/${meta.pages[0].file}`);
    const uiHtml = await uiRes.text();
    assert.ok(uiRes.ok, 'Geyser plugin UI should be served as HTML');
    assert.match(String(uiRes.headers.get('content-type') || ''), /text\/html/i);
    assert.match(uiHtml, /Add gateway/);
    assert.match(uiHtml, /16-byte key\.pem/);
    assert.match(uiHtml, /mc-manager-plugin-sdk/);
    assert.match(uiHtml, /\.hidden\s*\{/);
    assert.match(uiHtml, /function applyTheme/);
    assert.doesNotMatch(uiHtml, /href=["']geyser\.css["']/);
    assert.equal(String(uiRes.headers.get('cross-origin-resource-policy') || ''), 'cross-origin');
    const missingFileRes = await fetch(`${origin}/api/plugins/gateway-geyser/ui/undefined`);
    assert.equal(missingFileRes.status, 404);
  } finally {
    await new Promise((resolve) => geyserUiServer.close(resolve));
  }

  await assert.rejects(
    () => gatewayManager.create({
      name: 'Missing provider',
      targetType: 'remote-address',
      targetHost: '192.168.1.10',
      targetTcpPort: 25565,
    }),
    /provider is required/
  );

  const originalInstall = javaLoaderHost.executeInstallPlan;
  javaLoaderHost.executeInstallPlan = async () => ({});
  let created;
  try {
    created = await gatewayManager.create({
      name: 'Isolated Geyser',
      providerId: 'geyser',
      targetType: 'remote-address',
      targetHost: '192.168.1.20',
      targetTcpPort: 25565,
      authentication: 'online',
    });
    assert.equal(created.status, 'stopped');
    assert.equal(created.floodgate_key_path, undefined);
    assert.equal(JSON.stringify(created).includes('BEGIN PRIVATE'), false);
    await assert.rejects(
      () => gatewayManager.create({
        name: 'Offline no confirm',
        providerId: 'geyser',
        targetType: 'remote-address',
        targetHost: '192.168.1.21',
        targetTcpPort: 25565,
        authentication: 'offline',
      }),
      /explicit security confirmation/
    );
    await assert.rejects(
      () => gatewayManager.create({
        name: 'Remote floodgate',
        providerId: 'geyser',
        targetType: 'remote-address',
        targetHost: '192.168.1.22',
        targetTcpPort: 25565,
        authentication: 'floodgate',
      }),
      /Floodgate/
    );
    const floodgateGw = await gatewayManager.create({
      name: 'Floodgate Key',
      providerId: 'geyser',
      targetType: 'remote-address',
      targetHost: '192.168.1.23',
      targetTcpPort: 25565,
      authentication: 'floodgate',
      confirmFloodgate: true,
    });
    assert.equal(floodgateGw.floodgate_key_path, undefined);
    const storedKey = db.prepare('SELECT floodgate_key_path FROM gateways WHERE id = ?').get(floodgateGw.id);
    assert.equal(fs.readFileSync(storedKey.floodgate_key_path).length, 16);
    try { gatewayManager.remove(floodgateGw.id); } catch { /* ignore */ }
  } finally {
    javaLoaderHost.executeInstallPlan = originalInstall;
  }

  const geyserLink = integrations.find((item) => item.id === 'geyser');
  assert.ok(geyserLink);
  assert.equal(geyserLink.action, 'configure');
  assert.match(geyserLink.href, /\/plugins\/gateway-geyser/);
  assert.match(geyserLink.href, /targetServerId=99999/);
  assert.equal(gatewayManager.integrationsForServer({ id: 1, kind: 'bedrock' }).length, 0);

  const pluginDashboard = require('../server/services/pluginDashboard');
  const pluginAdvertisements = require('../server/services/pluginAdvertisements');
  const pluginEvents = require('../server/services/pluginEvents');
  const bedrockConnectList = require('../server/services/bedrockConnectList');

  const storedDirect = db.prepare('SELECT * FROM gateways WHERE id = ?').get(created.id);
  assert.equal(storedDirect.compatibility_mode, 'direct');
  assert.equal(Number(storedDirect.advertise_in_bedrock_connect), 1);
  const publicDirect = gatewayManager.publicRecord(storedDirect);
  assert.equal(publicDirect.compatibilityMode, 'direct');
  assert.equal(publicDirect.viaproxy_bind_port, undefined);
  assert.equal(JSON.stringify(publicDirect).includes('key.pem') && publicDirect.floodgate_key_path, undefined);

  const oldProtocol = geyserProvider.checkCompatibility(storedDirect, { minecraftVersion: '1.20.1' });
  assert.equal(oldProtocol.recommendedMode, 'viaproxy');
  assert.match(oldProtocol.message, /does not support the protocol required by the current Geyser release/);
  const nativeProtocol = geyserProvider.checkCompatibility(storedDirect, { minecraftVersion: '1.21.8' });
  assert.equal(nativeProtocol.recommendedMode, 'direct');

  await assert.rejects(
    () => gatewayManager.installCompatibility(created.id, {}),
    /not installed unless you confirm/
  );
  assert.equal(db.prepare('SELECT compatibility_mode FROM gateways WHERE id = ?').get(created.id).compatibility_mode, 'direct');
  assert.equal(fs.existsSync(path.join(storedDirect.data_path, 'ViaProxy.jar')), false);

  const viaPlan = await geyserProvider.planCompatibilityInstallation({ confirmViaProxy: true });
  javaLoaderHost.validatePlan(viaPlan);
  for (const item of viaPlan.downloads) {
    assert.ok(geyser.DOWNLOAD_HOSTS.includes(new URL(item.url).hostname));
    assert.doesNotMatch(item.url, /^http:/);
  }
  javaLoaderHost.executeInstallPlan = async (plan, { serverDir }) => {
    for (const item of plan.downloads || []) {
      const dest = path.join(serverDir, item.destination);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'jar');
    }
    return {};
  };
  const installed = await gatewayManager.installCompatibility(created.id, { confirmViaProxy: true });
  assert.equal(installed.compatibilityMode, 'viaproxy');
  const storedVia = db.prepare('SELECT * FROM gateways WHERE id = ?').get(created.id);
  assert.equal(storedVia.compatibility_mode, 'viaproxy');
  assert.ok(fs.existsSync(path.join(storedVia.data_path, 'ViaProxy.jar')));
  assert.ok(fs.existsSync(path.join(storedVia.data_path, 'plugins', 'Geyser-ViaProxy.jar')));
  const publicVia = gatewayManager.publicRecord(storedVia);
  assert.equal(publicVia.viaproxy_bind_port, undefined);
  assert.ok(!JSON.stringify(publicVia).includes(String(storedVia.viaproxy_bind_port)));
  const launchVia = geyserProvider.getLaunchSpecification(storedVia);
  assert.equal(launchVia.jar, 'ViaProxy.jar');
  assert.deepEqual(launchVia.arguments, ['config', 'viaproxy.yml']);
  const viaYml = fs.readFileSync(path.join(storedVia.data_path, 'viaproxy.yml'), 'utf8');
  assert.match(viaYml, /bind-address:\s*127\.0\.0\.1:\d+/);
  assert.match(viaYml, /target-address:\s*\S+:\d+/);
  assert.doesNotMatch(viaYml, /^bind-port:/m);
  assert.doesNotMatch(viaYml, /^target-port:/m);
  assert.equal(launchVia.shell, undefined);
  assert.equal(launchVia.command, undefined);
  controlledProcess.assertArgArray(launchVia.arguments, 'Launch');
  javaLoaderHost.validateLaunchSpec(launchVia, storedVia.data_path);
  assert.throws(() => controlledFs.assertRelative('../secret.jar'), /traversal|not allowed|relative/i);

  await assert.rejects(
    () => gatewayManager.start(created.id),
    /Floodgate|online-mode|AUTH|cannot join an online-mode/i
  );

  javaLoaderHost.executeInstallPlan = async () => {
    throw new Error('download failed');
  };
  await assert.rejects(
    () => gatewayManager.installCompatibility(created.id, { confirmViaProxy: true }),
    /download failed/
  );
  assert.ok(fs.existsSync(path.join(storedVia.data_path, 'ViaProxy.jar')));
  assert.equal(fs.readFileSync(path.join(storedVia.data_path, 'ViaProxy.jar'), 'utf8'), 'jar');

  const dashTiles = pluginDashboard.list();
  const tile = dashTiles.find((item) => item.id === `gateway:${created.id}`);
  assert.ok(tile);
  assert.equal(tile.typeLabel, 'Geyser Server');
  assert.equal(tile.readOnly, true);
  assert.equal(pluginDashboard.collisionsWithServers().length, 0);
  assert.match(tile.managementUrl, /gateway-geyser/);
  assert.match(tile.managementUrl, new RegExp(`gatewayId=${created.id}`));

  const ads = pluginAdvertisements.list();
  const ad = ads.find((item) => item.port === storedVia.bedrock_udp_port);
  assert.ok(ad);
  assert.match(ad.name, /Geyser/);
  assert.notEqual(ad.port, storedVia.viaproxy_bind_port);
  assert.notEqual(ad.port, storedVia.target_tcp_port);
  assert.equal(pluginAdvertisements.isUnadvertisableHost('127.0.0.1'), true);
  assert.equal(pluginAdvertisements.isUnadvertisableHost('localhost'), true);

  let syncs = 0;
  const originalSync = bedrockConnectList.scheduleSync;
  bedrockConnectList.scheduleSync = () => { syncs += 1; };
  pluginEvents.emit('gateway.updated', { gatewayId: created.id });
  bedrockConnectList.scheduleSync = originalSync;
  assert.ok(syncs >= 1);

  const dashApp = require('express')();
  dashApp.use('/api/dashboard', require('../server/routes/dashboard'));
  dashApp.use('/api/servers', require('../server/routes/servers'));
  const dashServer = dashApp.listen(0);
  try {
    const origin = `http://127.0.0.1:${dashServer.address().port}`;
    const dashRes = await fetch(`${origin}/api/dashboard`);
    const dashBody = await dashRes.json();
    assert.ok(dashBody.gateways.some((item) => item.id === `gateway:${created.id}` && item.typeLabel === 'Geyser Server'));
    const startRes = await fetch(`${origin}/api/servers/gateway:${created.id}/start`, { method: 'POST' });
    assert.equal(startRes.status, 400);
    const startBody = await startRes.json();
    assert.match(startBody.error, /Geyser plugin/);
  } finally {
    await new Promise((resolve) => dashServer.close(resolve));
  }

  const dashUi = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/Dashboard.jsx'), 'utf8');
  assert.match(dashUi, /Geyser Server/);
  const gatewayDetailUi = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/GatewayDetail.jsx'), 'utf8');
  assert.match(gatewayDetailUi, /This Geyser server is managed by the Geyser plugin/);
  assert.match(gatewayDetailUi, /Manage in Geyser Plugin/);
  const geyserUiSrc = fs.readFileSync(path.join(__dirname, '../server/bundled-plugins/gateway-geyser/ui/geyser.js'), 'utf8');
  assert.match(geyserUiSrc, /confirmViaProxy/);
  assert.match(geyserUiSrc, /Install ViaProxy/);

  const audits = db.prepare('SELECT action FROM audit_log WHERE target_id = ?').all(String(created.id)).map((row) => row.action);
  assert.ok(audits.includes('gateway.create'));
  assert.ok(audits.includes('gateway.viaproxy.install'));
  assert.ok(audits.includes('gateway.viaproxy.rollback'));

  javaLoaderHost.executeInstallPlan = async () => ({});
  await gatewayManager.removeCompatibility(created.id, { confirm: true });
  assert.equal(db.prepare('SELECT compatibility_mode FROM gateways WHERE id = ?').get(created.id).compatibility_mode, 'direct');

  db.prepare(`UPDATE gateways SET status = 'running' WHERE id = ?`).run(created.id);
  pluginHost.setPluginEnabled('gateway-geyser', false);
  const stoppedRunning = db.prepare('SELECT status FROM gateways WHERE id = ?').get(created.id);
  assert.equal(stoppedRunning.status, 'stopped');
  const disabledTile = pluginDashboard.list().find((item) => item.id === `gateway:${created.id}`);
  assert.ok(disabledTile);
  assert.equal(disabledTile.status, 'plugin_disabled');
  assert.equal(disabledTile.typeLabel, 'Geyser Server');
  assert.equal(disabledTile.managementUrl, '/plugins');
  assert.equal(pluginAdvertisements.list().some((item) => item.port === storedVia.bedrock_udp_port), false);
  pluginHost.setPluginEnabled('gateway-geyser', false);
  assert.equal(gatewayRegistry.get('geyser'), null);
  assert.equal(pluginHost.getMenuItems().some((item) => item.pluginId === 'gateway-geyser'), false);
  await assert.rejects(
    () => gatewayManager.create({
      name: 'While disabled',
      providerId: 'geyser',
      targetType: 'remote-address',
      targetHost: '192.168.1.30',
      targetTcpPort: 25565,
    }),
    /not installed/
  );
  const preserved = db.prepare('SELECT * FROM gateways WHERE id = ?').get(created.id);
  assert.ok(preserved);
  assert.equal(preserved.status, 'stopped');
  pluginHost.setPluginEnabled('gateway-geyser', true);
  assert.ok(gatewayRegistry.get('geyser'));
  assert.ok(pluginHost.getMenuItems().some((item) => item.pluginId === 'gateway-geyser'));

  const otherProvider = {
    getMetadata: () => ({
      id: 'other-gw',
      name: '<b>Other</b>',
      targetKinds: ['java', 'nope'],
      managementPluginId: 'escape',
      managementPage: '../secret',
    }),
    planInstallation: async () => ({ downloads: [], result: {} }),
    planUpdate: async () => ({ downloads: [], result: {} }),
    getLaunchSpecification: () => ({ runtime: 'java', jar: 'Geyser.jar', arguments: ['--nogui'] }),
    getDefaultConfig: () => '',
    sanitizePublicRecord: (row) => row,
  };
  gatewayRegistry.register({
    id: 'gateway-other',
    source: 'bundled',
    capabilities: ['provider:gateway'],
  }, otherProvider);
  const otherMeta = gatewayRegistry.list().find((item) => item.id === 'other-gw');
  assert.equal(otherMeta.name, 'Other');
  assert.deepEqual(otherMeta.targetKinds, ['java']);
  assert.equal(otherMeta.managementPluginId, 'gateway-other');
  assert.equal(otherMeta.managementPage, 'home');

  const scoped = require('../server/services/pluginGatewayService').scopedGatewayService({
    id: 'gateway-geyser',
    capabilities: ['provider:gateway'],
  });
  await assert.rejects(
    () => scoped.create({
      name: 'Escape',
      providerId: 'other-gw',
      targetType: 'remote-address',
      targetHost: '192.168.1.40',
      targetTcpPort: 25565,
    }),
    /another gateway provider/
  );
  assert.throws(() => scoped.getOwn(created.id + 9999), /not found/);
  const own = scoped.listOwn();
  assert.ok(own.some((row) => row.id === created.id));
  assert.equal(own.some((row) => row.provider_id === 'other-gw'), false);
  assert.ok(Array.isArray(scoped.listJavaTargets()));

  try { gatewayManager.remove(created.id); } catch { /* ignore */ }

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
