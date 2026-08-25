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
  const serverEditionRegistry = require('../server/services/serverEditionRegistry');
  const javaHostingPolicy = require('../server/services/javaHostingPolicy');
  const controlledFs = require('../server/services/controlledFs');
  const controlledDownload = require('../server/services/controlledDownload');
  const controlledProcess = require('../server/services/controlledProcess');
  const childEnv = require('../server/services/childEnv');
  const javaLoaderHost = require('../server/services/javaLoaderHost');
  const javaModMetadata = require('../server/services/javaModMetadata');
  const zipGuard = require('../server/services/zipGuard');
  const gatewayManager = require('../server/services/gatewayManager');
  const serverManager = require('../server/services/serverManager');
  const javaModInstall = require('../server/services/javaModInstall');
  const javaEdition = require('../server/services/javaEdition');
  const fabric = require('../server/bundled-plugins/java-loader-fabric/backend');
  const neoforge = require('../server/bundled-plugins/java-loader-neoforge/backend');
  const geyser = require('../server/bundled-plugins/gateway-geyser/backend');
  const db = require('../server/db/connection');

  assert.equal(pluginCapabilities.parseCapabilities(['not-a-cap'], 'bundled').ok, false);
  const uploadedCaps = pluginCapabilities.parseCapabilities(['provider:java-loader', 'ui:pages'], 'user');
  assert.deepEqual(uploadedCaps.capabilities, ['ui:pages']);
  assert.deepEqual(uploadedCaps.rejectedPrivileged, ['provider:java-loader']);
  const uploadedEdition = pluginCapabilities.parseCapabilities(['provider:server-edition', 'ui:pages'], 'user');
  assert.deepEqual(uploadedEdition.capabilities, ['ui:pages']);
  assert.deepEqual(uploadedEdition.rejectedPrivileged, ['provider:server-edition']);

  pluginHost.resetForTests();
  javaLoaderRegistry.clear();
  gatewayRegistry.clear();
  serverEditionRegistry.clear();

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
  serverEditionRegistry.clear();

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
  const omittedFabric = javaModMetadata.detectFabric(JSON.stringify({
    id: 'create',
    name: 'Create',
    version: '6.0.0',
  }));
  assert.equal(omittedFabric.environment, 'both');
  const neoClientToml = javaModMetadata.detectNeoForge(`
modLoader="javafml"
[[mods]]
modId="sodium"
version="1.0"
clientSideOnly=true
[[dependencies.sodium]]
modId="minecraft"
side="BOTH"
`);
  assert.equal(neoClientToml.environment, 'client');
  const neoDepSideOnly = javaModMetadata.detectNeoForge(`
modLoader="javafml"
[[mods]]
modId="create"
version="1.0"
displayName="Create"
[[dependencies.create]]
modId="minecraft"
side="CLIENT"
`);
  assert.equal(neoDepSideOnly.environment, 'unknown');
  const neoDisplayTest = javaModMetadata.detectNeoForge(`
[[mods]]
modId="iris"
displayTest="IGNORE_SERVER_VERSION"
`);
  assert.equal(neoDisplayTest.environment, 'client');
  const quiltJar = path.join(testRoot, 'quilt-client.jar');
  fs.writeFileSync(quiltJar, zipStore({
    'quilt.mod.json': JSON.stringify({
      schema_version: 1,
      quilt_loader: { id: 'sodium', version: '1.0.0', metadata: { name: 'Sodium' } },
      minecraft: { environment: 'client' },
    }),
  }));
  const quiltMeta = javaModMetadata.inspectJar(quiltJar);
  assert.equal(quiltMeta.environment, 'client');
  assert.equal(quiltMeta.loader, 'fabric');
  assert.equal(javaModMetadata.preferJarEnvironment('client', 'both'), 'client');
  assert.equal(javaModMetadata.preferJarEnvironment('unknown', 'server'), 'server');
  assert.equal(javaModMetadata.aggregateEnvironments(['client', 'both']), 'both');
  assert.equal(javaModMetadata.aggregateEnvironments(['unknown', 'unknown']), 'unknown');
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
  const irisHintJar = path.join(testRoot, 'iris-hint.jar');
  fs.writeFileSync(irisHintJar, zipStore({
    'fabric.mod.json': JSON.stringify({
      id: 'iris',
      name: 'Iris',
      version: '1.0.0',
      environment: 'client',
      depends: { minecraft: '1.21.1' },
    }),
  }));
  assert.equal(javaModFiles.inspectPath(irisHintJar, { environment: 'both', loader: 'fabric' }).environment, 'client');
  const staleJar = path.join(testRoot, 'stale-unknown.jar');
  fs.writeFileSync(staleJar, zipStore({
    'fabric.mod.json': JSON.stringify({
      id: 'iris',
      name: 'Iris',
      version: '1.0.0',
      environment: 'client',
    }),
  }));
  const backfill = db.prepare(`
    INSERT INTO mods (name, slug, type, description, file_path, source, edition, environment)
    VALUES (?, ?, 'mod', '', ?, 'upload', 'java', 'unknown')
  `).run('Iris Backfill', `iris-backfill-${Date.now()}`, staleJar);
  const decoratedEnv = javaModFiles.decorate(db.prepare('SELECT * FROM mods WHERE id = ?').get(backfill.lastInsertRowid));
  assert.equal(decoratedEnv.environment, 'client');
  assert.equal(db.prepare('SELECT environment FROM mods WHERE id = ?').get(backfill.lastInsertRowid).environment, 'client');
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
  assert.match(geyserUi, /if \(gateway\.lastError\)/);
  assert.match(geyserUi, /openDetail/);
  assert.match(geyserUi, /Delete gateway/);
  assert.match(geyserUi, /detailNotice/);
  assert.match(geyserUi, /'outlined'/);
  assert.match(geyserUi, /extra-actions/);
  assert.match(geyserUi, /Save Changes/);
  assert.match(geyserUi, /apply-settings/);
  assert.match(geyserUi, /detailAuth/);
  assert.match(geyserUi, /'Authentication'/);
  assert.match(geyserUi, /askConfirm/);
  assert.match(geyserUi, /confirmOverlay/);
  assert.match(geyserUi, /syncSaveButton/);
  assert.match(geyserUi, /The selected actions have been performed/);
  assert.doesNotMatch(geyserUi, /window\.confirm/);
  assert.doesNotMatch(geyserUi, /Hide from Bedrock Connect/);
  assert.doesNotThrow(() => new Function(geyserUi), 'Geyser plugin UI script must parse');
  assert.doesNotMatch(geyserUi, /\/api\/gateways/);
  assert.equal(pluginHost.isAllowedPluginApiPath('hello-world', '/api/plugins/gateway-geyser/gateways'), false);
  assert.equal(pluginHost.isAllowedPluginApiPath('gateway-geyser', '/api/gateways'), false);
  assert.equal(pluginHost.isAllowedPluginApiPath('gateway-geyser', '/api/plugins/gateway-geyser/gateways'), true);

  pluginHost.resetForTests();
  gatewayRegistry.clear();
  pluginHost.loadPlugins([pluginHost.BUNDLED_PLUGINS_DIR]);
  assert.ok(serverEditionRegistry.get('java'), 'Minecraft Java Hosting plugin should register the java edition');
  assert.equal(javaHostingPolicy.isJavaHostingAvailable(), true);
  assert.ok(javaHostingPolicy.listEditions().some((item) => item.id === 'java' && item.available));
  assert.ok(javaHostingPolicy.listEditions().some((item) => item.id === 'bedrock' && item.core));
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
  assert.match(libraryUi, /environmentBadge/);
  assert.match(libraryUi, /'Client'/);
  assert.match(libraryUi, /'Server'/);
  assert.match(libraryUi, /'Both'/);
  assert.match(libraryUi, /'Unknown'/);
  assert.doesNotMatch(libraryUi, /modVersionTags\(mod\)\.slice\(0, 4\)/);
  const tileUi = fs.readFileSync(path.join(__dirname, '../frontend/src/components/ModTileTags.jsx'), 'utf8');
  assert.doesNotMatch(tileUi, /slice\(0,\s*8\)/);
  assert.match(tileUi, /mod-tile-tags-expanded/);
  const tileCss = fs.readFileSync(path.join(__dirname, '../frontend/src/index.css'), 'utf8');
  assert.match(tileCss, /mod-tile-tags[^{]*\{[^}]*flex-wrap/s);
  assert.match(tileCss, /height: 3rem/);
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
    const fgNeoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-neo-'));
    fs.mkdirSync(path.join(fgNeoDir, 'mods'));
    fs.writeFileSync(path.join(fgNeoDir, 'mods', 'Floodgate.jar'), Buffer.alloc(0));
    const copiedNeo = gatewayManager.copyFloodgateKeyToLocalServer(keyPath, { id: 3, data_path: fgNeoDir });
    assert.ok(copiedNeo.some((item) => item.endsWith(path.join('config', 'floodgate', 'key.pem'))));
    fs.rmSync(fgNeoDir, { recursive: true, force: true });
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
    assert.match(uiHtml, /\+ Add Gateway/);
    assert.match(uiHtml, /16-byte key\.pem/);
    assert.match(uiHtml, /mc-manager-plugin-sdk/);
    assert.match(uiHtml, /class="page"/);
    assert.match(uiHtml, /max-width:\s*80rem/);
    assert.match(uiHtml, /tile-grid/);
    assert.match(uiHtml, /detailOverlay/);
    assert.match(uiHtml, /repeat\(3/);
    assert.match(uiHtml, /button\.outlined/);
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

  const integrations = gatewayManager.integrationsForServer({ id: 99999, kind: 'java' });
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
  const nativeProtocol = geyserProvider.checkCompatibility(storedDirect, { minecraftVersion: '1.26.2' });
  assert.equal(nativeProtocol.recommendedMode, 'direct');
  const viaForCurrentJava = geyserProvider.checkCompatibility(storedDirect, { minecraftVersion: '1.21.8' });
  assert.equal(viaForCurrentJava.recommendedMode, 'viaproxy');
  assert.equal(viaForCurrentJava.viaProxyEnabled, false);
  const neoForgeKick = geyserProvider.checkCompatibility(storedDirect, {
    minecraftVersion: '1.21.1',
    loaderProviderId: 'neoforge',
  });
  assert.equal(neoForgeKick.compatible, false);
  assert.equal(neoForgeKick.code, 'MODDED_CLIENT_REQUIRED');
  assert.match(neoForgeKick.message, /vanilla Java client|Create|Xbox cannot install NeoForge/i);
  const viaAlreadyOn = geyserProvider.checkCompatibility(
    { ...storedDirect, compatibility_mode: 'viaproxy' },
    { minecraftVersion: '1.21.8' }
  );
  assert.equal(viaAlreadyOn.viaProxyEnabled, true);
  assert.match(viaAlreadyOn.message, /already enabled/i);

  await assert.rejects(
    () => gatewayManager.installCompatibility(created.id, {}),
    /not installed unless you confirm/
  );
  assert.equal(db.prepare('SELECT compatibility_mode FROM gateways WHERE id = ?').get(created.id).compatibility_mode, 'direct');
  assert.equal(fs.existsSync(path.join(storedDirect.data_path, 'ViaProxy.jar')), false);

  const floodgatePlan = geyserProvider.planFloodgateInstallation({ loader_provider_id: 'neoforge', minecraft_version: '1.21.1' });
  javaLoaderHost.validatePlan(floodgatePlan);
  assert.equal(floodgatePlan.downloads[0].destination, 'mods/Floodgate.jar');
  assert.ok(geyser.DOWNLOAD_HOSTS.includes(new URL(floodgatePlan.downloads[0].url).hostname));
  assert.doesNotMatch(floodgatePlan.downloads[0].url, /^http:/);
  assert.throws(
    () => geyserProvider.planFloodgateInstallation({ loader_provider_id: 'vanilla' }),
    /Fabric|NeoForge|Paper/
  );
  await assert.rejects(
    () => gatewayManager.installFloodgate(created.id, {}),
    /unless you confirm/
  );
  const tinyVia = path.join(storedDirect.data_path, 'ViaProxy.jar');
  fs.writeFileSync(tinyVia, 'jar');
  assert.doesNotThrow(() => geyserProvider.prepareRuntime({
    ...created,
    compatibility_mode: 'viaproxy',
    authentication: 'floodgate',
    data_path: storedDirect.data_path,
  }));
  assert.equal(fs.existsSync(path.join(storedDirect.data_path, 'plugins', 'FloodgateJoin.jar')), false);

  const viaPlan = await geyserProvider.planCompatibilityInstallation({ confirmViaProxy: true });
  javaLoaderHost.validatePlan(viaPlan);
  assert.equal(viaPlan.result.viaproxyVersion, '3.4.12');
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
  assert.equal(launchVia.javaAgent, undefined);
  assert.deepEqual(launchVia.arguments, ['config', 'viaproxy.yml']);
  const viaArgs = javaLoaderHost.buildJavaArgs(launchVia);
  assert.ok(!viaArgs.includes('-javaagent:ViaProxy.jar'));
  assert.ok(viaArgs.includes('-jar'));
  assert.ok(viaArgs.includes('ViaProxy.jar'));
  const viaYml = fs.readFileSync(path.join(storedVia.data_path, 'viaproxy.yml'), 'utf8');
  assert.match(viaYml, /bind-address:\s*127\.0\.0\.1:\d+/);
  assert.match(viaYml, /target-address:\s*\S+:\d+/);
  assert.doesNotMatch(viaYml, /^bind-port:/m);
  assert.doesNotMatch(viaYml, /^target-port:/m);
  const geyserYml = fs.readFileSync(path.join(storedVia.data_path, 'plugins', 'Geyser', 'config.yml'), 'utf8');
  assert.match(geyserYml, /use-direct-connection:\s*true/);
  assert.match(geyserYml, /passthrough-motd:\s*false/);
  assert.match(geyserYml, new RegExp(`address: "${storedVia.target_host}"`));
  assert.match(geyserYml, new RegExp(`port: ${Number(storedVia.target_tcp_port)}`));
  assert.doesNotMatch(geyserYml, new RegExp(`port: ${Number(storedVia.viaproxy_bind_port)}`));
  assert.equal(geyser.VIAPROXY_VERSION, '3.4.12');
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
  assert.equal(tile.typeLabel, 'Remote Java — Geyser');
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
    assert.ok(dashBody.gateways.some((item) => item.id === `gateway:${created.id}` && item.typeLabel === 'Remote Java — Geyser'));
    const startRes = await fetch(`${origin}/api/servers/gateway:${created.id}/start`, { method: 'POST' });
    assert.equal(startRes.status, 400);
    const startBody = await startRes.json();
    assert.match(startBody.error, /Geyser plugin/);
  } finally {
    await new Promise((resolve) => dashServer.close(resolve));
  }

  javaLoaderHost.executeInstallPlan = async () => ({});
  const pluginContributions = require('../server/services/pluginContributions');
  const pluginActions = require('../server/services/pluginActions');
  const serverPluginAttachments = require('../server/services/serverPluginAttachments');
  const javaDir = path.join(testRoot, 'attached-java');
  fs.mkdirSync(javaDir, { recursive: true });
  const javaRow = db.prepare(`
    INSERT INTO servers (name, version, port, data_path, kind, status, loader_provider_id)
    VALUES (?, '1.21.8', ?, ?, 'java', 'stopped', 'vanilla')
  `).run('Attached Java', 25580, javaDir);
  const javaId = javaRow.lastInsertRowid;
  const localGw = await gatewayManager.create({
    name: 'Local Geyser',
    providerId: 'geyser',
    targetType: 'local-server',
    targetServerId: javaId,
    authentication: 'online',
  });
  const firstMigrate = serverPluginAttachments.migrateGateways();
  const secondMigrate = serverPluginAttachments.migrateGateways();
  assert.equal(firstMigrate.attached >= 1, true);
  assert.equal(secondMigrate.attached, firstMigrate.attached);
  const att = serverPluginAttachments.findByResource('gateway-geyser', 'gateway', String(localGw.id));
  assert.ok(att);
  assert.equal(Number(att.server_id), Number(javaId));
  assert.equal(Number(att.primary_attachment), 1);
  const projected = pluginDashboard.list();
  assert.equal(projected.some((item) => item.id === `gateway:${localGw.id}`), false);
  assert.ok(projected.some((item) => item.id === `gateway:${created.id}`));
  const contribs = pluginContributions.listForServer({ id: javaId, status: 'stopped' });
  assert.equal(contribs.length, 1);
  assert.ok(contribs[0].tags.some((tag) => tag.label === 'Geyser'));
  assert.equal(contribs[0].tags.some((tag) => /ViaProxy/.test(tag.label)), false);
  assert.ok(contribs[0].indicators.some((item) => item.id === 'geyser-status' && item.state === 'offline'));
  const startAction = contribs[0].actions.find((item) => item.id === 'toggle-gateway');
  assert.equal(startAction.state, 'disabled');
  assert.match(startAction.disabledReason, /Start the Java server before starting Geyser/);
  await assert.rejects(
    () => gatewayManager.start(localGw.id),
    /Start the Java server before starting Geyser/
  );
  await assert.rejects(
    () => pluginActions.invoke({
      pluginId: 'gateway-geyser',
      actionId: 'toggle-gateway',
      serverId: javaId,
      attachmentId: att.id,
    }),
    /Start the Java server before starting Geyser|already in progress|Unknown/
  );
  await assert.rejects(
    () => pluginActions.invoke({
      pluginId: 'gateway-geyser',
      actionId: 'https://evil.example/start',
      serverId: javaId,
      attachmentId: att.id,
    }),
    /Unknown plugin action/
  );
  await assert.rejects(
    () => pluginActions.invoke({
      pluginId: 'gateway-geyser',
      actionId: 'toggle-gateway',
      serverId: javaId,
      resourceId: String(created.id),
      url: 'https://evil.example',
    }),
    /cannot supply URLs|does not belong|not owned|cannot target|Plugin actions cannot supply URLs/
  );
  pluginActions.setPermissionResolver(() => false);
  await assert.rejects(
    () => pluginActions.invoke({
      pluginId: 'gateway-geyser',
      actionId: 'toggle-gateway',
      serverId: javaId,
      attachmentId: att.id,
    }),
    /permission/
  );
  pluginActions.resetPermissionResolver();
  db.prepare(`UPDATE gateways SET status = 'running', health_status = 'running' WHERE id = ?`).run(localGw.id);
  const runningContrib = pluginContributions.listForServer({ id: javaId, status: 'stopped' })[0];
  const stopAction = runningContrib.actions.find((item) => item.id === 'toggle-gateway');
  assert.equal(stopAction.state, 'enabled');
  assert.match(stopAction.label, /Stop Geyser/);
  db.prepare(`UPDATE gateways SET status = 'stopped', health_status = 'stopped' WHERE id = ?`).run(localGw.id);

  const secondGw = await gatewayManager.create({
    name: 'Second Local Geyser',
    providerId: 'geyser',
    targetType: 'local-server',
    targetServerId: javaId,
    authentication: 'online',
  });
  const secondAtt = serverPluginAttachments.findByResource('gateway-geyser', 'gateway', String(secondGw.id));
  assert.equal(Number(secondAtt.primary_attachment), 0);
  const afterSecond = pluginContributions.listForServer({ id: javaId, status: 'stopped' });
  assert.equal(afterSecond.length, 1);
  assert.equal(afterSecond[0].attachmentId, `gateway:${localGw.id}`);

  const deleteApp = require('express')();
  deleteApp.use(require('express').json());
  deleteApp.use('/api/servers', require('../server/routes/servers'));
  const deleteServer = deleteApp.listen(0);
  try {
    const origin = `http://127.0.0.1:${deleteServer.address().port}`;
    const blocked = await fetch(`${origin}/api/servers/${javaId}`, { method: 'DELETE' });
    assert.equal(blocked.status, 409);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.code, 'PLUGIN_ATTACHMENT');
    assert.ok(db.prepare('SELECT id FROM servers WHERE id = ?').get(javaId));
    assert.ok(db.prepare('SELECT id FROM gateways WHERE id = ?').get(localGw.id));
  } finally {
    await new Promise((resolve) => deleteServer.close(resolve));
  }

  const viaGw = await gatewayManager.installCompatibility(localGw.id, { confirmViaProxy: true });
  db.prepare(`UPDATE gateways SET authentication = 'floodgate' WHERE id = ?`).run(localGw.id);
  const tagged = pluginContributions.listForServer({ id: javaId, status: 'running' })[0];
  assert.ok(tagged.tags.some((tag) => /ViaProxy/.test(tag.label)));
  assert.equal(tagged.tags.some((tag) => tag.label === 'Geyser'), false);
  assert.ok(tagged.tags.some((tag) => tag.label === 'Floodgate'));
  assert.ok(tagged.indicators.every((item) => item.id !== 'geyser-mode'));

  const auditsAttach = db.prepare('SELECT action FROM audit_log WHERE target_id IN (?, ?)').all(String(localGw.id), String(att.id)).map((row) => row.action);
  assert.ok(auditsAttach.includes('plugin.attachment.create') || db.prepare("SELECT action FROM audit_log WHERE action LIKE 'plugin.attachment%'").all().length);

  const dashUi = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/Dashboard.jsx'), 'utf8');
  assert.match(dashUi, /pluginContributions/);
  assert.match(dashUi, /primary-split/);
  const gatewayDetailUi = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/GatewayDetail.jsx'), 'utf8');
  assert.match(gatewayDetailUi, /Remote Java/);
  assert.match(gatewayDetailUi, /PluginPrimaryActions/);
  const geyserUiSrc = fs.readFileSync(path.join(__dirname, '../server/bundled-plugins/gateway-geyser/ui/geyser.js'), 'utf8');
  assert.match(geyserUiSrc, /confirmViaProxy/);
  assert.match(geyserUiSrc, /Install ViaProxy/);
  assert.match(geyserUiSrc, /Save Changes/);
  assert.match(geyserUiSrc, /apply-settings/);
  assert.match(geyserUiSrc, /askConfirm/);
  assert.doesNotMatch(geyserUiSrc, /window\.confirm/);
  assert.doesNotMatch(geyserUiSrc, /Hide from Bedrock Connect/);

  javaLoaderHost.executeInstallPlan = async (plan, opts) => {
    for (const item of plan?.downloads || []) {
      if (!opts?.serverDir || !item?.destination) continue;
      const dest = path.join(opts.serverDir, item.destination);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'jar');
    }
    return {};
  };

  await assert.rejects(
    () => gatewayManager.applySettings(created.id, { authentication: 'online' }),
    (err) => err.code === 'AUTH_INCOMPATIBLE'
  );

  const authRemote = await gatewayManager.create({
    name: 'Auth Remote',
    providerId: 'geyser',
    targetType: 'remote-address',
    targetHost: '192.168.9.9',
    targetTcpPort: 25565,
    authentication: 'online',
  });
  await assert.rejects(
    () => gatewayManager.applySettings(authRemote.id, { authentication: 'offline' }),
    (err) => err.status === 409 && err.code === 'CONFIRMATION_REQUIRED' && err.preview.missingConfirmations.includes('confirmOffline')
  );
  const offlineApplied = await gatewayManager.applySettings(authRemote.id, {
    authentication: 'offline',
    confirmOffline: true,
  });
  assert.equal(offlineApplied.authentication, 'offline');
  assert.equal(db.prepare('SELECT offline_confirmed FROM gateways WHERE id = ?').get(authRemote.id).offline_confirmed, 1);
  assert.ok(db.prepare("SELECT action FROM audit_log WHERE target_id = ? AND action = 'gateway.authentication.change'").get(String(authRemote.id)));

  await assert.rejects(
    () => gatewayManager.applySettings(authRemote.id, { authentication: 'floodgate' }),
    (err) => err.code === 'CONFIRMATION_REQUIRED' && err.preview.missingConfirmations.includes('confirmFloodgate')
  );
  const remoteFg = await gatewayManager.applySettings(authRemote.id, {
    authentication: 'floodgate',
    confirmFloodgate: true,
  });
  assert.equal(remoteFg.authentication, 'floodgate');
  assert.equal(remoteFg.keyExportAvailable, true);
  assert.ok(remoteFg.warnings.some((item) => /cannot install Floodgate or copy the key/i.test(item)));
  const exported = gatewayManager.exportFloodgateKey(authRemote.id);
  assert.equal(exported.filename, 'key.pem');
  assert.equal(exported.bytes.length, 16);
  assert.equal(JSON.stringify({ filename: exported.filename, contentBase64: exported.bytes.toString('base64') }).includes(authRemote.data_path || ''), false);
  const storedKeyPath = db.prepare('SELECT floodgate_key_path, data_path FROM gateways WHERE id = ?').get(authRemote.id);
  fs.mkdirSync(path.join(storedKeyPath.data_path, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(storedKeyPath.data_path, 'plugins', 'FloodgateJoin.jar'), 'keep-me');
  const leaveFg = await gatewayManager.applySettings(authRemote.id, { authentication: 'online' });
  assert.equal(leaveFg.authentication, 'online');
  assert.ok(leaveFg.preservedInactive.includes('key.pem'));
  assert.ok(fs.existsSync(path.join(storedKeyPath.data_path, 'key.pem')));
  assert.ok(fs.existsSync(path.join(storedKeyPath.data_path, 'plugins', 'FloodgateJoin.jar')));
  assert.match(fs.readFileSync(path.join(storedKeyPath.data_path, 'config.yml'), 'utf8'), /auth-type:\s*online/);

  db.prepare(`UPDATE gateways SET status = 'running', health_status = 'running' WHERE id = ?`).run(authRemote.id);
  await assert.rejects(
    () => gatewayManager.applySettings(authRemote.id, { authentication: 'offline', confirmOffline: true }),
    (err) => err.code === 'GATEWAY_RUNNING'
  );

  const javaRuntime = require('../server/services/javaRuntime');
  const origEnsureJava = javaRuntime.ensureJava;
  const ptyPath = require.resolve('node-pty');
  const origPtyModule = require.cache[ptyPath];
  javaRuntime.ensureJava = async () => process.execPath;
  require.cache[ptyPath] = {
    id: ptyPath,
    filename: ptyPath,
    loaded: true,
    exports: {
      spawn() {
        const exit = [];
        return {
          onData() {},
          onExit(cb) { exit.push(cb); },
          kill() { exit.forEach((cb) => cb({ exitCode: 0 })); },
        };
      },
    },
  };
  try {
    fs.writeFileSync(path.join(storedKeyPath.data_path, 'Geyser.jar'), 'jar');
    const restarted = await gatewayManager.applySettings(authRemote.id, {
      authentication: 'offline',
      confirmOffline: true,
      restartGateway: true,
    });
    assert.equal(restarted.authentication, 'offline');
    assert.equal(restarted.gatewayRestarted, true);
    assert.equal(db.prepare('SELECT status FROM gateways WHERE id = ?').get(authRemote.id).status, 'running');
    gatewayManager.stop(authRemote.id);
  } finally {
    javaRuntime.ensureJava = origEnsureJava;
    if (origPtyModule) require.cache[ptyPath] = origPtyModule;
    else delete require.cache[ptyPath];
    try { gatewayManager.stop(authRemote.id); } catch { /* ignore */ }
  }

  const paperDir = path.join(testRoot, 'paper-floodgate');
  fs.mkdirSync(paperDir, { recursive: true });
  const paperRow = db.prepare(`
    INSERT INTO servers (name, version, port, data_path, kind, status, loader_provider_id)
    VALUES (?, '1.21.8', ?, ?, 'java', 'stopped', 'paper')
  `).run('Paper Floodgate', 25581, paperDir);
  const paperId = paperRow.lastInsertRowid;
  const localFgGw = await gatewayManager.create({
    name: 'Local Floodgate Auth',
    providerId: 'geyser',
    targetType: 'local-server',
    targetServerId: paperId,
    authentication: 'online',
  });
  await assert.rejects(
    () => gatewayManager.applySettings(localFgGw.id, { authentication: 'floodgate' }),
    (err) => err.code === 'CONFIRMATION_REQUIRED' && err.preview.floodgateInstallRequired
  );
  db.prepare(`UPDATE servers SET status = 'running' WHERE id = ?`).run(paperId);
  let javaRestarts = 0;
  const origRestartServer = serverManager.restartServer.bind(serverManager);
  serverManager.restartServer = async () => { javaRestarts += 1; };
  try {
    const withoutJavaRestart = await gatewayManager.applySettings(localFgGw.id, {
      authentication: 'floodgate',
      confirmFloodgateInstall: true,
    });
    assert.equal(withoutJavaRestart.authentication, 'floodgate');
    assert.equal(withoutJavaRestart.floodgateInstall.installed, true);
    assert.equal(withoutJavaRestart.keySynchronized, true);
    assert.equal(withoutJavaRestart.javaRestarted, false);
    assert.equal(withoutJavaRestart.javaRestartRequired, true);
    assert.equal(javaRestarts, 0);
    assert.equal(fs.readFileSync(path.join(paperDir, 'plugins', 'floodgate', 'key.pem')).length, 16);
    const taggedLocal = pluginContributions.listForServer({ id: paperId, status: 'running' });
    assert.ok(taggedLocal.some((item) => item.tags.some((tag) => tag.label === 'Floodgate')));

    await gatewayManager.applySettings(localFgGw.id, { authentication: 'online' });
    const withJavaRestart = await gatewayManager.applySettings(localFgGw.id, {
      authentication: 'floodgate',
      confirmJavaRestart: true,
    });
    assert.equal(withJavaRestart.authentication, 'floodgate');
    assert.equal(withJavaRestart.javaRestarted, true);
    assert.equal(javaRestarts, 1);
    const actionOnly = await gatewayManager.applySettings(localFgGw.id, {
      authentication: 'floodgate',
      confirmFloodgateInstall: true,
      confirmJavaRestart: true,
    });
    assert.equal(actionOnly.authentication, 'floodgate');
    assert.equal(actionOnly.gatewayRestarted, false);
    assert.equal(actionOnly.floodgateInstall.alreadyPresent, true);
    assert.equal(actionOnly.floodgateInstall.installed, false);
    assert.equal(actionOnly.javaRestarted, true);
    assert.equal(javaRestarts, 2);
    const leaveLocal = await gatewayManager.applySettings(localFgGw.id, { authentication: 'online' });
    assert.ok(fs.existsSync(path.join(paperDir, 'plugins', 'floodgate-spigot.jar')));
    assert.ok(leaveLocal.preservedInactive.includes('Floodgate JARs'));
  } finally {
    serverManager.restartServer = origRestartServer;
    db.prepare(`UPDATE servers SET status = 'stopped' WHERE id = ?`).run(paperId);
  }

  const rollbackGw = await gatewayManager.create({
    name: 'Auth Rollback',
    providerId: 'geyser',
    targetType: 'remote-address',
    targetHost: '192.168.9.10',
    targetTcpPort: 25565,
    authentication: 'online',
  });
  const geyserProviderLive = gatewayRegistry.get('geyser').provider;
  const origDefaultConfig = geyserProviderLive.getDefaultConfig.bind(geyserProviderLive);
  geyserProviderLive.getDefaultConfig = () => {
    throw Object.assign(new Error('config write failed'), { status: 500 });
  };
  try {
    await assert.rejects(
      () => gatewayManager.applySettings(rollbackGw.id, { authentication: 'offline', confirmOffline: true }),
      /config write failed/
    );
    const rolled = db.prepare('SELECT authentication, status FROM gateways WHERE id = ?').get(rollbackGw.id);
    assert.equal(rolled.authentication, 'online');
    assert.notEqual(rolled.status, 'running');
  } finally {
    geyserProviderLive.getDefaultConfig = origDefaultConfig;
  }

  const origInstallPlan = javaLoaderHost.executeInstallPlan;
  const busyGw = await gatewayManager.create({
    name: 'Auth Busy',
    providerId: 'geyser',
    targetType: 'remote-address',
    targetHost: '192.168.9.11',
    targetTcpPort: 25565,
    authentication: 'online',
  });
  let releaseInstall;
  const hungInstall = new Promise((resolve) => { releaseInstall = resolve; });
  javaLoaderHost.executeInstallPlan = () => hungInstall.then(() => ({}));
  const pendingCompat = gatewayManager.installCompatibility(busyGw.id, {
    confirmViaProxy: true,
    confirmModeSwitch: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    await assert.rejects(
      () => gatewayManager.applySettings(busyGw.id, { authentication: 'offline', confirmOffline: true }),
      (err) => err.code === 'GATEWAY_BUSY'
    );
    await assert.rejects(
      () => gatewayManager.start(busyGw.id),
      (err) => err.code === 'GATEWAY_BUSY'
    );
  } finally {
    releaseInstall({});
    try { await pendingCompat; } catch { /* ignore hung install errors */ }
    javaLoaderHost.executeInstallPlan = origInstallPlan;
  }

  const pluginRoutesAuth = require('../server/routes/plugins');
  const authApp = require('express')();
  authApp.use(require('express').json());
  authApp.use('/api/plugins', pluginRoutesAuth);
  const authServer = authApp.listen(0);
  try {
    const origin = `http://127.0.0.1:${authServer.address().port}`;
    const hideRes = await fetch(`${origin}/api/plugins/gateway-geyser/gateways/${authRemote.id}/apply-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ advertiseInBedrockConnect: false }),
    });
    const hideBody = await hideRes.json();
    assert.equal(hideRes.status, 200, hideBody.error || 'apply-settings should succeed');
    assert.equal(hideBody.advertiseInBedrockConnect, false);
    const keyRes = await fetch(`${origin}/api/plugins/gateway-geyser/gateways/${authRemote.id}/floodgate/key`);
    assert.equal(keyRes.status, 400);
  } finally {
    await new Promise((resolve) => authServer.close(resolve));
  }

  try { gatewayManager.remove(authRemote.id); } catch { /* ignore */ }
  try { gatewayManager.remove(localFgGw.id); } catch { /* ignore */ }
  try { gatewayManager.remove(rollbackGw.id); } catch { /* ignore */ }
  try { gatewayManager.remove(busyGw.id); } catch { /* ignore */ }

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
  const listedDisabled = pluginDashboard.list();
  const disabledTile = listedDisabled.find((item) => item.id === `gateway:${created.id}`);
  assert.ok(disabledTile);
  assert.equal(disabledTile.status, 'plugin_disabled');
  assert.equal(disabledTile.typeLabel, 'Remote Java — Geyser');
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

  const javaHostingPlugin = pluginHost.getPlugin('server-edition-java');
  assert.ok(javaHostingPlugin);
  assert.equal(javaHostingPlugin.name, 'Minecraft Java Hosting');
  assert.ok((javaHostingPlugin.capabilities || []).includes('provider:server-edition'));
  assert.equal(pluginHost.getMenuItems().some((item) => item.pluginId === 'server-edition-java'), false);

  await assert.rejects(
    () => pluginHost.setPluginEnabled('server-edition-java', false),
    (err) => err.code === 'JAVA_HOSTING_DISABLE_CONFIRM' && /No server data will be deleted/i.test(err.message)
  );
  assert.equal(pluginHost.getPlugin('server-edition-java').enabled, true);

  const origStopFail = serverManager.stopServer.bind(serverManager);
  serverManager.stopServer = async () => { throw new Error('refused to stop'); };
  db.prepare(`UPDATE servers SET status = 'running' WHERE id = ?`).run(javaId);
  try {
    await assert.rejects(
      () => pluginHost.setPluginEnabled('server-edition-java', false, { confirm: true }),
      (err) => err.code === 'JAVA_HOSTING_DISABLE_FAILED'
    );
    assert.equal(pluginHost.getPlugin('server-edition-java').enabled, true);
    assert.equal(javaHostingPolicy.isJavaHostingAvailable(), true);
  } finally {
    serverManager.stopServer = origStopFail;
    db.prepare(`UPDATE servers SET status = 'stopped' WHERE id = ?`).run(javaId);
  }

  javaHostingPolicy.markDisabling();
  await assert.rejects(
    () => serverManager.createJavaServer({
      name: 'blocked-java',
      port: 25566,
      acceptEula: true,
      loaderProvider: 'vanilla',
    }),
    (err) => err.code === 'JAVA_HOSTING_DISABLED'
  );
  await assert.rejects(
    () => gatewayManager.start(created.id),
    (err) => err.code === 'JAVA_HOSTING_DISABLED'
  );
  javaHostingPolicy.clearDisabling();

  db.prepare(`UPDATE servers SET status = 'creating' WHERE id = ?`).run(javaId);
  await serverManager.cancelJavaProvisioning({ timeoutMs: 20 });
  assert.equal(serverManager.getServer(javaId).status, 'stopped');

  const stopOrder = [];
  const origGwStop = gatewayManager.stop;
  const origJavaStop = serverManager.stopServer.bind(serverManager);
  gatewayManager.stop = (id) => {
    stopOrder.push(`gateway:${id}`);
    return origGwStop(id);
  };
  serverManager.stopServer = async (id) => {
    stopOrder.push(`java:${id}`);
    return origJavaStop(id);
  };
  db.prepare(`UPDATE servers SET status = 'running' WHERE id = ?`).run(javaId);
  db.prepare(`UPDATE gateways SET status = 'running' WHERE id = ?`).run(created.id);
  try {
    await pluginHost.setPluginEnabled('server-edition-java', false, { confirm: true });
  } finally {
    gatewayManager.stop = origGwStop;
    serverManager.stopServer = origJavaStop;
  }
  const firstGateway = stopOrder.findIndex((item) => item.startsWith('gateway:'));
  const firstJava = stopOrder.findIndex((item) => item.startsWith('java:'));
  assert.ok(firstGateway >= 0, 'disablement must stop Geyser/ViaProxy');
  assert.ok(firstJava >= 0, 'disablement must stop Java servers');
  assert.ok(firstGateway < firstJava, 'Geyser must stop before Java');
  assert.equal(pluginHost.getPlugin('server-edition-java').enabled, false);
  assert.equal(javaHostingPolicy.isJavaHostingAvailable(), false);
  assert.equal(javaHostingPolicy.listEditions().some((item) => item.id === 'java'), false);
  assert.ok(javaHostingPolicy.listEditions().some((item) => item.id === 'bedrock' && item.available));
  assert.ok(javaLoaderRegistry.get('vanilla'), 'loader plugins remain installed while hosting is disabled');
  assert.ok(
    pluginHost.getPlugin('catalog-modrinth-java') || pluginHost.getPlugin('catalog-curseforge'),
    'catalog plugins remain installed while hosting is disabled'
  );
  assert.equal(javaHostingPolicy.isJavaHostingAvailable(), false);
  assert.equal(pluginDashboard.list().some((item) => item.id === `gateway:${created.id}`), false);
  assert.equal(pluginAdvertisements.list().some((item) => item.port === storedVia.bedrock_udp_port), false);
  assert.equal(pluginContributions.listForServer({ id: javaId, status: 'stopped' }).length, 0);
  assert.equal(javaHostingPolicy.filterVisibleServers(serverManager.getAllServers()).some((row) => Number(row.id) === Number(javaId)), false);
  const preservedJava = db.prepare('SELECT * FROM servers WHERE id = ?').get(javaId);
  assert.ok(preservedJava);
  assert.ok(fs.existsSync(preservedJava.data_path));
  const preservedGateway = db.prepare('SELECT * FROM gateways WHERE id = ?').get(created.id);
  assert.ok(preservedGateway);
  assert.notEqual(preservedJava.status, 'running');
  await assert.rejects(() => serverManager.startServer(javaId), (err) => err.code === 'JAVA_HOSTING_DISABLED');
  await assert.rejects(() => serverManager.restartServer(javaId), (err) => err.code === 'JAVA_HOSTING_DISABLED');
  assert.throws(
    () => javaModInstall.install(preservedJava, 1),
    (err) => err.code === 'JAVA_HOSTING_DISABLED'
  );
  await assert.rejects(() => gatewayManager.start(created.id), (err) => err.code === 'JAVA_HOSTING_DISABLED');
  db.prepare(`UPDATE gateways SET status = 'running' WHERE id = ?`).run(created.id);
  await javaHostingPolicy.reconcileOnStartup();
  assert.equal(db.prepare('SELECT status FROM gateways WHERE id = ?').get(created.id).status, 'stopped');

  await pluginHost.setPluginEnabled('server-edition-java', true);
  assert.equal(javaHostingPolicy.isJavaHostingAvailable(), true);
  assert.ok(serverEditionRegistry.get('java'));
  assert.equal(db.prepare('SELECT status FROM servers WHERE id = ?').get(javaId).status, 'stopped');
  assert.equal(db.prepare('SELECT status FROM gateways WHERE id = ?').get(created.id).status, 'stopped');
  assert.ok(pluginDashboard.list().some((item) => item.id === `gateway:${created.id}`));
  assert.ok(javaEdition.PERMISSIONS.some((item) => item.key === 'servers.create_java'));

  const createUi = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/CreateServer.jsx'), 'utf8');
  assert.match(createUi, /serverApi\.editions/);
  assert.match(createUi, /Bedrock/);
  const pluginsUi = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/Plugins.jsx'), 'utf8');
  assert.match(pluginsUi, /Continue/);
  assert.match(pluginsUi, /Cancel/);
  assert.match(pluginsUi, /disableImpact|JAVA_HOSTING_DISABLE_CONFIRM/);
  const dashUiHosting = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/Dashboard.jsx'), 'utf8');
  assert.match(dashUiHosting, /javaHostingAvailable/);

  assert.throws(
    () => serverEditionRegistry.register({
      id: 'evil-edition',
      source: 'user',
      capabilities: ['provider:server-edition'],
    }, { getMetadata: () => ({ id: 'java', label: 'Java' }) }),
    /bundled/
  );

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

  const attachedLoader = db.prepare("SELECT loader_provider_id FROM servers WHERE name = 'Attached Java'").get();
  if (attachedLoader) assert.equal(attachedLoader.loader_provider_id, 'vanilla');

  if (prevBundled == null) delete process.env.MC_MANAGER_BUNDLED_PLUGINS_DIR;
  else process.env.MC_MANAGER_BUNDLED_PLUGINS_DIR = prevBundled;
  pluginHost.resetForTests();
  javaLoaderRegistry.clear();
  gatewayRegistry.clear();
  serverEditionRegistry.clear();
}

module.exports = { runJavaProviderTests };
