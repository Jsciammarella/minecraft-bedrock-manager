'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const floodgateVersions = require('../server/bundled-plugins/gateway-geyser/floodgateVersions');
const floodgateCatalog = require('../server/bundled-plugins/gateway-geyser/floodgateCatalog');
const floodgateJar = require('../server/bundled-plugins/gateway-geyser/floodgateJar');
const floodgateInstall = require('../server/bundled-plugins/gateway-geyser/floodgateInstall');
const floodgateStatus = require('../server/bundled-plugins/gateway-geyser/floodgateStatus');
const provenance = require('../server/bundled-plugins/gateway-geyser/floodgateProvenance');
const geyser = require('../server/bundled-plugins/gateway-geyser/backend');
const controlledDownload = require('../server/services/controlledDownload');

function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'));
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

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function fabricJar({ id = 'floodgate', minecraft = '26.2', loader = '>=0.16.0', fabricApi = true } = {}) {
  const depends = { minecraft, fabricloader: loader };
  if (fabricApi) depends.fabric = '*';
  return zipStore({
    'fabric.mod.json': JSON.stringify({
      id,
      version: 'test',
      environment: '*',
      depends,
    }),
  });
}

function neoJar({
  id = 'floodgate',
  minecraftRange = '[1.21,1.21.3]',
  neoRange = '[21.0,)',
  kind = 'neoforge.mods.toml',
} = {}) {
  const toml = [
    `modId="${id}"`,
    'version="test"',
    'displayName="Floodgate"',
    `[[dependencies.${id}]]`,
    'modId="minecraft"',
    `versionRange="${minecraftRange}"`,
    'type="required"',
    `[[dependencies.${id}]]`,
    'modId="neoforge"',
    `versionRange="${neoRange}"`,
    'type="required"',
  ].join('\n');
  return zipStore({ [`META-INF/${kind}`]: toml });
}

function catalogVersion(opts) {
  return {
    id: opts.id,
    version_number: opts.versionNumber,
    version_type: opts.versionType || 'release',
    date_published: opts.date || '2026-01-01T00:00:00Z',
    game_versions: opts.gameVersions,
    loaders: opts.loaders,
    environment: opts.environment,
    files: [{
      filename: opts.filename,
      primary: true,
      url: opts.url,
      size: opts.size || 1000,
      hashes: opts.hashes || { sha1: 'a'.repeat(40) },
    }],
    dependencies: opts.dependencies || [],
  };
}

function writeJar(dir, name, buf) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, buf);
  return dest;
}

async function runGeyserFloodgateTests() {
  const backendSource = fs.readFileSync(
    path.join(__dirname, '../server/bundled-plugins/gateway-geyser/backend.js'),
    'utf8'
  );
  assert.doesNotMatch(backendSource, /Floodgate-Fabric-2\.2\.4-b38/);
  assert.doesNotMatch(backendSource, /Floodgate-Neoforge-2\.2\.4-b38/);
  assert.match(backendSource, /not a replacement for the backend Floodgate/i);
  assert.ok(geyser.DOWNLOAD_HOSTS.includes('api.modrinth.com'));
  assert.ok(geyser.DOWNLOAD_HOSTS.includes('cdn.modrinth.com'));

  assert.equal(floodgateVersions.canonicalMinecraftVersion('1.26.2'), '26.2');
  assert.equal(floodgateVersions.minecraftVersionsEqual('26.2', '1.26.2'), true);
  assert.equal(floodgateVersions.catalogListsExactMinecraft(['1.21.1', '1.21.2'], '1.20.2'), false);
  assert.equal(floodgateVersions.catalogListsExactMinecraft(['26.2'], '1.26.2'), true);
  assert.equal(floodgateVersions.satisfiesConstraint('[1.21,1.21.3]', '1.20.2', 'minecraft'), false);
  assert.equal(floodgateVersions.satisfiesConstraint('[1.21,1.21.3]', '1.21.1', 'minecraft'), true);
  assert.equal(floodgateVersions.satisfiesConstraint('[1.21,1.21.3]', '26.2', 'minecraft'), false);
  assert.equal(floodgateVersions.satisfiesConstraint('[21.0,)', '20.2.12-beta', 'loader'), false);
  assert.equal(floodgateVersions.satisfiesConstraint('[21.0,)', '21.1.1', 'loader'), true);
  assert.equal(floodgateVersions.satisfiesConstraint('>=0.16.0', '0.19.5', 'loader'), true);
  assert.equal(floodgateVersions.isGeyserNativeJavaVersion('26.2', ['1.26.2']), true);
  assert.equal(floodgateVersions.isGeyserNativeJavaVersion('1.20.2', ['1.26.2']), false);

  const allowHosts = ['api.modrinth.com', 'cdn.modrinth.com'];
  const release = catalogVersion({
    id: 'rel',
    versionNumber: '2.2.5',
    versionType: 'release',
    date: '2026-02-01T00:00:00Z',
    gameVersions: ['26.2'],
    loaders: ['fabric'],
    filename: 'Floodgate-Fabric-2.2.5.jar',
    url: 'https://cdn.modrinth.com/data/bWrNNfkb/versions/rel/Floodgate-Fabric-2.2.5.jar',
    dependencies: [{ project_id: 'P7dR8mSH', dependency_type: 'required' }],
  });
  const beta = catalogVersion({
    id: 'beta',
    versionNumber: '2.2.6-beta',
    versionType: 'beta',
    date: '2026-03-01T00:00:00Z',
    gameVersions: ['26.2'],
    loaders: ['fabric'],
    filename: 'Floodgate-Fabric-2.2.6-beta.jar',
    url: 'https://cdn.modrinth.com/data/bWrNNfkb/versions/beta/Floodgate-Fabric-2.2.6-beta.jar',
  });
  const latestIncompatible = catalogVersion({
    id: 'b38',
    versionNumber: '2.2.4-b38',
    versionType: 'release',
    date: '2026-04-01T00:00:00Z',
    gameVersions: ['1.21', '1.21.1', '1.21.2', '1.21.3'],
    loaders: ['fabric'],
    filename: 'Floodgate-Fabric-2.2.4-b38.jar',
    url: 'https://cdn.modrinth.com/data/bWrNNfkb/versions/Mf2wV7re/Floodgate-Fabric-2.2.4-b38.jar',
  });
  const parsed = floodgateCatalog.parseVersionList([release, beta, latestIncompatible], allowHosts);
  const selected = floodgateCatalog.selectCompatibleVersion(parsed, { minecraftVersion: '26.2', loader: 'fabric' });
  assert.equal(selected.versionNumber, '2.2.5');
  assert.equal(floodgateCatalog.selectCompatibleVersion(parsed, { minecraftVersion: '1.20.2', loader: 'neoforge' }), null);

  const betaOnly = floodgateCatalog.parseVersionList([beta], allowHosts);
  assert.equal(
    floodgateCatalog.selectCompatibleVersion(betaOnly, { minecraftVersion: '26.2', loader: 'fabric' }).versionNumber,
    '2.2.6-beta'
  );

  const clientOnly = floodgateCatalog.parseVersionList([catalogVersion({
    id: 'client',
    versionNumber: '9.0.0',
    gameVersions: ['26.2'],
    loaders: ['fabric'],
    filename: 'Floodgate-Client.jar',
    url: 'https://cdn.modrinth.com/data/bWrNNfkb/client.jar',
    environment: 'client_only',
  })], allowHosts);
  assert.equal(floodgateCatalog.selectCompatibleVersion(clientOnly, { minecraftVersion: '26.2', loader: 'fabric' }), null);

  const evilHost = floodgateCatalog.parseVersionList([catalogVersion({
    id: 'evil',
    versionNumber: '1.0.0',
    gameVersions: ['26.2'],
    loaders: ['fabric'],
    filename: 'Floodgate.jar',
    url: 'https://evil.example/Floodgate.jar',
  })], allowHosts);
  assert.equal(evilHost.length, 0);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbm-fg-test-'));
  try {
    const fg26 = writeJar(tmp, 'fg-26.jar', fabricJar({ minecraft: '26.2' }));
    const inspected = floodgateJar.validateFloodgateJar(fg26, {
      loader: 'fabric',
      minecraftVersion: '26.2',
      loaderVersion: '0.19.5',
    }, { gameVersions: ['26.2'] });
    assert.equal(inspected.modId, 'floodgate');
    assert.equal(inspected.requiresFabricApi, true);

    const b38 = writeJar(tmp, 'fg-b38.jar', fabricJar({ minecraft: '>=1.21 <=1.21.3' }));
    assert.throws(
      () => floodgateJar.validateFloodgateJar(b38, {
        loader: 'fabric',
        minecraftVersion: '26.2',
        loaderVersion: '0.19.5',
      }, { gameVersions: ['26.2'] }),
      /Minecraft/
    );

    const neo21 = writeJar(tmp, 'fg-neo21.jar', neoJar({}));
    assert.throws(
      () => floodgateJar.validateFloodgateJar(neo21, {
        loader: 'neoforge',
        minecraftVersion: '1.20.2',
        loaderVersion: '20.2.12-beta',
      }, { gameVersions: ['1.20.2'] }),
      (err) => err.code === 'FLOODGATE_METADATA_UNSUPPORTED' || err.code === 'FLOODGATE_MINECRAFT_MISMATCH' || err.code === 'FLOODGATE_LOADER_VERSION_MISMATCH'
    );

    const neo21On20Meta = writeJar(tmp, 'fg-neo21-on20.jar', neoJar({
      minecraftRange: '[1.21,1.21.3]',
      neoRange: '[21.0,)',
      kind: 'neoforge.mods.toml',
    }));
    assert.throws(
      () => floodgateJar.validateFloodgateJar(neo21On20Meta, {
        loader: 'neoforge',
        minecraftVersion: '1.20.2',
        loaderVersion: '20.2.12-beta',
      }),
      (err) => err.code === 'FLOODGATE_METADATA_UNSUPPORTED'
    );

    const neo20 = writeJar(tmp, 'fg-neo20.jar', neoJar({
      minecraftRange: '[1.20.2,1.20.2]',
      neoRange: '[20.2,20.3)',
      kind: 'mods.toml',
    }));
    const neoOk = floodgateJar.validateFloodgateJar(neo20, {
      loader: 'neoforge',
      minecraftVersion: '1.20.2',
      loaderVersion: '20.2.12-beta',
    }, { gameVersions: ['1.20.2'] });
    assert.equal(neoOk.modId, 'floodgate');

    const apiJar = writeJar(tmp, 'fabric-api.jar', fabricJar({ id: 'fabric', minecraft: '26.2', fabricApi: false }));
    floodgateJar.validateFabricApiJar(apiJar, {
      loader: 'fabric',
      minecraftVersion: '26.2',
      loaderVersion: '0.19.5',
    }, { gameVersions: ['26.2'] });

    const loaderJar = writeJar(tmp, 'fabric-loader.jar', fabricJar({ id: 'fabricloader', minecraft: '26.2', fabricApi: false }));
    assert.throws(
      () => floodgateJar.validateFabricApiJar(loaderJar, {
        loader: 'fabric',
        minecraftVersion: '26.2',
        loaderVersion: '0.19.5',
      }),
      (err) => err.code === 'FABRIC_LOADER_NOT_API'
    );

    const disagree = writeJar(tmp, 'fg-disagree.jar', fabricJar({ minecraft: '[1.21,1.21.3]' }));
    assert.throws(
      () => floodgateJar.validateFloodgateJar(disagree, {
        loader: 'fabric',
        minecraftVersion: '26.2',
        loaderVersion: '0.19.5',
      }, { gameVersions: ['26.2'] }),
      (err) => err.code === 'FLOODGATE_MINECRAFT_MISMATCH' || err.code === 'FLOODGATE_METADATA_DISAGREEMENT'
    );

    const fabricServer = {
      loader_provider_id: 'fabric',
      minecraft_version: '26.2',
      loader_version: '0.19.5',
      data_path: path.join(tmp, 'fabric-server'),
    };
    fs.mkdirSync(path.join(fabricServer.data_path, 'mods'), { recursive: true });
    const fgBuf = fabricJar({ minecraft: '26.2' });
    const apiBuf = fabricJar({ id: 'fabric', minecraft: '26.2', fabricApi: false });
    const catalogs = {
      'https://api.modrinth.com/v2/project/bWrNNfkb/version': [
        catalogVersion({
          id: 'fg26',
          versionNumber: '2.2.5',
          gameVersions: ['26.2'],
          loaders: ['fabric'],
          filename: 'Floodgate-Fabric-2.2.5.jar',
          url: 'https://cdn.modrinth.com/data/bWrNNfkb/fg26.jar',
          hashes: { sha1: sha1(fgBuf) },
          dependencies: [{ project_id: 'P7dR8mSH', dependency_type: 'required' }],
        }),
        latestIncompatible,
      ],
      'https://api.modrinth.com/v2/project/P7dR8mSH/version': [
        catalogVersion({
          id: 'api26',
          versionNumber: '0.129.0+26.2',
          gameVersions: ['26.2'],
          loaders: ['fabric'],
          filename: 'fabric-api-0.129.0+26.2.jar',
          url: 'https://cdn.modrinth.com/data/P7dR8mSH/api26.jar',
          hashes: { sha1: sha1(apiBuf) },
        }),
      ],
    };
    const requestJson = async (url) => {
      const parsed = new URL(url);
      const key = `${parsed.origin}${parsed.pathname}`;
      const body = catalogs[key];
      if (!body) throw new Error(`unexpected catalog url ${url}`);
      return body;
    };
    const plan = await floodgateInstall.planModInstall(fabricServer, { requestJson, allowHosts });
    assert.equal(plan.installMode, 'atomic');
    assert.equal(plan.artifacts.length, 2);
    assert.equal(plan.artifacts[0].versionNumber, '2.2.5');
    assert.doesNotMatch(plan.artifacts[0].url, /2\.2\.4-b38/);
    assert.equal(plan.artifacts[1].projectId, 'P7dR8mSH');

    const jarsByUrl = {
      'https://cdn.modrinth.com/data/bWrNNfkb/fg26.jar': fgBuf,
      'https://cdn.modrinth.com/data/P7dR8mSH/api26.jar': apiBuf,
    };
    const result = await floodgateInstall.executeAtomicPlan(plan, {
      serverDir: fabricServer.data_path,
      allowHosts,
      downloadToFile: async ({ url, destination, sha1: expected }) => {
        const buf = jarsByUrl[url];
        if (!buf) throw new Error(`unexpected download ${url}`);
        if (expected && sha1(buf) !== expected) throw new Error('SHA-1 verification failed');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, buf);
        return { path: destination, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
      },
      copyKey: () => {
        const destDir = path.join(fabricServer.data_path, 'config', 'floodgate');
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, 'key.pem'), Buffer.alloc(16));
      },
    });
    assert.equal(result.installed, true);
    const installed = floodgateJar.inspectInstalledMods(fabricServer.data_path);
    assert.ok(installed.some((item) => item.modId === 'floodgate'));
    assert.ok(installed.some((item) => item.modId === 'fabric'));
    assert.equal(floodgateStatus.inspectReadiness(fabricServer).ready, true);
    const recorded = provenance.read(fabricServer.data_path).artifacts;
    assert.ok(recorded.some((item) => item.modId === 'floodgate' && item.installedBy === 'gateway-geyser'));
    assert.ok(recorded.some((item) => item.modId === 'fabric' && item.dependency === true));

    const again = await floodgateInstall.planModInstall(fabricServer, { requestJson, allowHosts });
    const skip = await floodgateInstall.executeAtomicPlan(again, {
      serverDir: fabricServer.data_path,
      allowHosts,
      downloadToFile: async () => { throw new Error('should not download'); },
    });
    assert.equal(skip.alreadyPresent, true);

    const userDir = path.join(tmp, 'user-server');
    fs.mkdirSync(path.join(userDir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'mods', 'MyPackCore.jar'), 'user-bytes');
    const userServer = { ...fabricServer, data_path: userDir };
    await floodgateInstall.executeAtomicPlan(
      await floodgateInstall.planModInstall(userServer, { requestJson, allowHosts }),
      {
        serverDir: userDir,
        allowHosts,
        downloadToFile: async ({ url, destination }) => {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, jarsByUrl[url]);
          return { path: destination, bytes: 1, sha256: 'ab' };
        },
      }
    );
    assert.equal(fs.readFileSync(path.join(userDir, 'mods', 'MyPackCore.jar'), 'utf8'), 'user-bytes');

    const failDir = path.join(tmp, 'rollback-server');
    fs.mkdirSync(path.join(failDir, 'mods'), { recursive: true });
    const failServer = { ...fabricServer, data_path: failDir };
    const failPlan = await floodgateInstall.planModInstall(failServer, { requestJson, allowHosts });
    await assert.rejects(
      () => floodgateInstall.executeAtomicPlan(failPlan, {
        serverDir: failDir,
        allowHosts,
        downloadToFile: async ({ url, destination }) => {
          if (url.includes('P7dR8mSH')) {
            throw new Error('second artifact failed');
          }
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, jarsByUrl[url]);
          return { path: destination, bytes: 1, sha256: 'ab' };
        },
      }),
      /second artifact failed/
    );
    assert.equal(fs.readdirSync(path.join(failDir, 'mods')).length, 0);
    assert.equal(floodgateStatus.inspectReadiness(failServer).ready, false);

    const neoServer = {
      loader_provider_id: 'neoforge',
      minecraft_version: '1.20.2',
      loader_version: '20.2.12-beta',
      data_path: path.join(tmp, 'neo-1202'),
    };
    fs.mkdirSync(path.join(neoServer.data_path, 'mods'), { recursive: true });
    await assert.rejects(
      () => floodgateInstall.planModInstall(neoServer, {
        allowHosts,
        requestJson: async () => ([latestIncompatible, catalogVersion({
          id: 'neo-b38',
          versionNumber: '2.2.4-b38',
          gameVersions: ['1.21', '1.21.1', '1.21.2', '1.21.3'],
          loaders: ['neoforge'],
          filename: 'Floodgate-Neoforge-2.2.4-b38.jar',
          url: 'https://cdn.modrinth.com/data/bWrNNfkb/versions/YapRHgnZ/Floodgate-Neoforge-2.2.4-b38.jar',
        })]),
      }),
      (err) => err.code === 'FLOODGATE_UNSUPPORTED_TARGET'
        && err.loader === 'neoforge'
        && err.minecraftVersion === '1.20.2'
        && /NeoForge 1\.20\.2/.test(err.message)
    );
    assert.equal(fs.readdirSync(path.join(neoServer.data_path, 'mods')).length, 0);

    fs.writeFileSync(path.join(neoServer.data_path, 'mods', 'Floodgate-Neoforge-2.2.4-b38.jar'), neoJar({}));
    const neoReadiness = floodgateStatus.inspectReadiness(neoServer);
    assert.equal(neoReadiness.ready, false);
    assert.ok(['FLOODGATE_INCOMPATIBLE', 'FLOODGATE_METADATA_UNSUPPORTED', 'FLOODGATE_MINECRAFT_MISMATCH', 'FLOODGATE_LOADER_VERSION_MISMATCH'].includes(neoReadiness.code));

    const gw = {
      authentication: 'floodgate',
      compatibility_mode: 'viaproxy',
      data_path: path.join(tmp, 'gw'),
    };
    fs.mkdirSync(gw.data_path, { recursive: true });
    const missing = floodgateStatus.preflightStart({
      server: neoServer,
      gateway: gw,
      nativeVersions: geyser.GEYSER_NATIVE_JAVA_VERSIONS,
      skipKeys: true,
    });
    assert.ok(missing);
    assert.notEqual(missing.code, null);

    const viaKept = floodgateStatus.viaProxyRequired('1.20.2', geyser.GEYSER_NATIVE_JAVA_VERSIONS);
    assert.equal(viaKept, true);
    assert.equal(floodgateStatus.viaProxyRequired('26.2', geyser.GEYSER_NATIVE_JAVA_VERSIONS), false);

    const status = await floodgateStatus.statusFor({
      server: neoServer,
      gateway: { ...gw, compatibility_mode: 'direct' },
      nativeVersions: geyser.GEYSER_NATIVE_JAVA_VERSIONS,
      deps: {
        allowHosts,
        requestJson: async () => [],
      },
    });
    assert.equal(status.canStart, false);
    assert.equal(status.unsupported, true);
    assert.ok(status.summary.some((line) => /No compatible build available/.test(line)));
    assert.ok(status.summary.some((line) => /ViaProxy: Required for protocol translation/.test(line)));
    assert.ok(status.summary.some((line) => /Change the server loader\/version or authentication mode/.test(line)));
    assert.ok(!status.summary.some((line) => /ViaProxy can correct/.test(line)));

    const keyA = path.join(tmp, 'key-a.pem');
    const keyB = path.join(tmp, 'key-b.pem');
    const keyC = path.join(tmp, 'key-c.pem');
    fs.writeFileSync(keyA, Buffer.alloc(16, 7));
    fs.writeFileSync(keyB, Buffer.alloc(16, 7));
    fs.writeFileSync(keyC, Buffer.alloc(16, 8));
    assert.equal(floodgateStatus.keysMatch(keyA, keyB), true);
    assert.equal(floodgateStatus.keysMatch(keyA, keyC), false);
    const explained = floodgateStatus.explainLastError('io.netty.handler.timeout.ReadTimeoutException: null');
    assert.match(explained, /timed out/i);
    assert.match(explained, /Floodgate/);
    assert.doesNotMatch(explained, /192\.168/);
    assert.doesNotMatch(floodgateStatus.redactSensitive('timeout from 10.0.0.8 key.pem'), /10\.0\.0\.8/);

    const winRel = path.posix.join('mods', 'Floodgate.jar');
    assert.equal(winRel.replace(/\\/g, '/'), 'mods/Floodgate.jar');
    assert.throws(
      () => require('../server/services/controlledFs').assertRelative('../secrets/Floodgate.jar'),
      /traversal/i
    );

    await assert.rejects(
      () => controlledDownload.downloadToFile({
        url: 'https://cdn.modrinth.com/data/bWrNNfkb/bad.jar',
        destination: path.join(tmp, 'bad.jar'),
        sha256: '0'.repeat(64),
        allowHosts,
        fetcher: async () => Buffer.from('not-the-hash'),
      }),
      /SHA-256/
    );
    assert.equal(fs.existsSync(path.join(tmp, 'bad.jar')), false);
    assert.equal(fs.existsSync(`${path.join(tmp, 'bad.jar')}.${process.pid}.part`), false);

    await assert.rejects(
      () => controlledDownload.downloadToFile({
        url: 'https://cdn.modrinth.com/data/bWrNNfkb/big.jar',
        destination: path.join(tmp, 'big.jar'),
        maximumBytes: 4,
        allowHosts,
        fetcher: async () => Buffer.from('12345'),
      }),
      /byte limit/
    );

    assert.throws(
      () => controlledDownload.assertHttpsUrl('https://evil.example/mod.jar', allowHosts),
      /approved download list/
    );
    assert.throws(
      () => controlledDownload.assertRedirectAllowed({ url: 'https://evil.example/next' }, allowHosts),
      /Redirect rejected/
    );

    const provider = geyser.createProvider();
    const blocked = provider.preflightFloodgateStart({
      server: fabricServer,
      gateway: { authentication: 'floodgate', compatibility_mode: 'direct', data_path: gw.data_path },
      skipKeys: true,
    });
    assert.equal(blocked, null);
    const noFg = provider.preflightFloodgateStart({
      server: {
        loader_provider_id: 'fabric',
        minecraft_version: '26.2',
        loader_version: '0.19.5',
        data_path: path.join(tmp, 'empty-fabric'),
      },
      gateway: { authentication: 'floodgate', compatibility_mode: 'direct', data_path: gw.data_path },
      skipKeys: true,
    });
    assert.equal(noFg.code, 'FLOODGATE_MISSING');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { runGeyserFloodgateTests };

if (require.main === module) {
  runGeyserFloodgateTests()
    .then(() => {
      console.log('geyser-floodgate tests passed');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
