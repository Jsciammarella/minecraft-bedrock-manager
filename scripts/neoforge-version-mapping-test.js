'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const minecraftVersions = require('../server/services/minecraftVersions');
const loaderVersionCache = require('../server/services/loaderVersionCache');
const mapping = require('../server/bundled-plugins/java-loader-neoforge/versionMapping');
const catalog = require('../server/bundled-plugins/java-loader-neoforge/versionCatalog');
const recordRepair = require('../server/bundled-plugins/java-loader-neoforge/recordRepair');
const neoforge = require('../server/bundled-plugins/java-loader-neoforge/backend');

function mavenXml(versions) {
  return `<metadata><versioning><versions>${
    versions.map((item) => `<version>${item}</version>`).join('')
  }</versions></versioning></metadata>`;
}

function pomFor(minecraftVersion) {
  return `<project><dependencies><dependency><groupId>net.neoforged</groupId><artifactId>neoform</artifactId><version>${minecraftVersion}-meta</version></dependency></dependencies></project>`;
}

async function runNeoForgeVersionMappingTests({ testRoot, db } = {}) {
  assert.equal(mapping.minecraftFromNeoForge('21.1.66'), '1.21.1');
  assert.equal(mapping.minecraftFromNeoForge('21.1.192'), '1.21.1');
  assert.equal(mapping.minecraftFromNeoForge('21.4.123'), '1.21.4');
  assert.equal(mapping.minecraftFromNeoForge('26.1.0.1-beta'), '26.1');
  assert.equal(mapping.minecraftFromNeoForge('26.1.0.10-beta'), '26.1');
  assert.equal(mapping.minecraftFromNeoForge('26.2.0.48-beta'), '26.2');
  assert.equal(mapping.minecraftFromNeoForge('26.2.0.81'), '26.2');
  assert.equal(mapping.minecraftFromNeoForge('26.1.1.0-beta'), '26.1.1');
  assert.equal(mapping.minecraftFromNeoForge('26.1.2.95'), '26.1.2');
  assert.equal(mapping.minecraftFromNeoForge('26.2'), '26.2');
  assert.equal(mapping.minecraftFromNeoForge('1.21.1'), '1.21.1');
  assert.equal(mapping.minecraftFromNeoForge('21.1.66', { minecraftVersion: '1.21.1' }), '1.21.1');
  assert.equal(mapping.minecraftFromNeoForge('26.2.0.48-beta', { minecraftVersion: '26.2' }), '26.2');
  assert.equal(mapping.minecraftFromNeoForge('not-a-version'), '');
  assert.equal(mapping.minecraftFromNeoForge(''), '');
  assert.equal(mapping.minecraftFromNeoForge('26.2.0.48-beta').startsWith('1.'), false);

  assert.equal(mapping.minecraftFromNeoformVersion('1.21.1-20240808.144430'), '1.21.1');
  assert.equal(mapping.minecraftFromNeoformVersion('26.2-2'), '26.2');
  assert.equal(mapping.minecraftFromNeoForgePom(pomFor('1.21.1')), '1.21.1');
  assert.equal(mapping.minecraftFromNeoForgePom(pomFor('26.2')), '26.2');

  const snapshot = mapping.parseNeoForgeArtifact('26.1.0.0-alpha.2+snapshot-1');
  assert.equal(snapshot.channel, 'snapshot');
  assert.equal(mapping.minecraftFromNeoForge('26.2.0.48-beta').includes('beta'), false);
  assert.equal(mapping.parseNeoForgeArtifact('26.2.0.48-beta').qualifier, 'beta');
  assert.equal(mapping.parseNeoForgeArtifact('26.2.0.81').channel, 'stable');
  assert.equal(mapping.parseNeoForgeArtifact('21.1.66-beta').channel, 'beta');
  assert.equal(mapping.parseNeoForgeArtifact('bad'), null);

  const ordered = minecraftVersions.sortMinecraftVersions(
    ['26.2', '1.21.9', '26.1', '1.21.11', '1.21.10'],
  );
  assert.deepEqual(ordered, ['1.21.9', '1.21.10', '1.21.11', '26.1', '26.2']);
  assert.ok(minecraftVersions.compareMinecraftVersions('1.21.9', '1.21.10') < 0);
  assert.ok(minecraftVersions.compareMinecraftVersions('1.21.11', '26.1') < 0);
  assert.ok(minecraftVersions.compareMinecraftVersions('26.1', '26.2') < 0);
  assert.equal(minecraftVersions.canonicalMinecraftVersion('1.26.2'), '26.2');
  assert.equal(minecraftVersions.canonicalMinecraftVersion('26.2'), '26.2');
  assert.equal(minecraftVersions.canonicalMinecraftVersion('1.21.1'), '1.21.1');
  assert.equal(minecraftVersions.isFabricatedMinecraftVersion('1.26.2'), true);
  assert.equal(minecraftVersions.isFabricatedMinecraftVersion('26.2'), false);
  assert.equal(minecraftVersions.isFabricatedMinecraftVersion('1.21.1'), false);
  assert.equal(minecraftVersions.minecraftVersionsEqual('26.2', '1.26.2'), true);
  assert.equal(minecraftVersions.supportsMinecraftVersion(['26.2'], '1.26.2'), true);
  assert.equal(minecraftVersions.supportsMinecraftVersion(['1.21.1'], '1.21.1'), true);
  assert.equal(minecraftVersions.looksLikeMinecraftVersion('26.2'), true);
  assert.equal(minecraftVersions.looksLikeMinecraftVersion('1.21.11'), true);
  assert.equal(minecraftVersions.looksLikeMinecraftVersion('1.26.2'), false);
  assert.equal(minecraftVersions.looksLikeMinecraftVersion('26.2.0.48-beta'), false);
  assert.equal(minecraftVersions.looksLikeLoaderArtifactVersion('26.2.0.48-beta'), true);
  assert.equal(minecraftVersions.looksLikeLoaderArtifactVersion('21.1.66'), true);
  assert.equal(minecraftVersions.looksLikeLoaderArtifactVersion('1.21.1'), false);
  assert.equal(minecraftVersions.looksLikeLoaderArtifactVersion('26.2'), false);

  assert.throws(
    () => minecraftVersions.rejectSwappedVersions({
      minecraftVersion: '26.2.0.48-beta',
      loaderVersion: '26.2',
      loader: 'neoforge',
    }),
    (err) => err.code === 'VERSION_FIELDS_SWAPPED'
  );

  const many = [];
  for (let i = 0; i < 40; i += 1) many.push(`21.1.${i}`);
  many.push('21.4.9', '26.1.0.1-beta', '26.1.0.2-beta', '26.2.0.48-beta', '26.2.0.81');
  const parsedAll = mapping.parseMavenMetadataVersions(mavenXml(many));
  assert.equal(parsedAll.length, many.length);
  assert.ok(parsedAll.includes('26.2.0.48-beta'));

  const built = catalog.buildCatalog(many);
  assert.ok(built.minecraftVersions.includes('1.21.1'));
  assert.ok(built.minecraftVersions.includes('1.21.4'));
  assert.ok(built.minecraftVersions.includes('26.1'));
  assert.ok(built.minecraftVersions.includes('26.2'));
  assert.equal(built.minecraftVersions.includes('1.26.2'), false);
  assert.equal(built.minecraftVersions.filter((item) => item === '1.21.1').length, 1);
  assert.equal(built.minecraftVersions.filter((item) => item === '26.2').length, 1);

  const cacheDir = path.join(testRoot || os.tmpdir(), `neo-cache-${Date.now()}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, loaderVersionCache.cacheFileName({ loader: 'neoforge', channel: 'all' })), `${JSON.stringify({
    format: 2,
    loader: 'neoforge',
    channel: 'all',
    fetchedAt: new Date().toISOString(),
    versions: [{ loaderVersion: '26.2.0.48-beta', minecraftVersion: '1.26.2', loader: 'neoforge' }],
    minecraftVersions: ['1.26.2'],
  })}\n`);
  assert.equal(loaderVersionCache.readCatalog(cacheDir, { loader: 'neoforge', channel: 'all' }), null);

  fs.writeFileSync(path.join(cacheDir, loaderVersionCache.cacheFileName({ loader: 'neoforge', channel: 'all', format: 1 })), `${JSON.stringify({
    format: 1,
    loader: 'neoforge',
    channel: 'all',
    fetchedAt: new Date().toISOString(),
    versions: [{ loaderVersion: '21.1.1', minecraftVersion: '1.21.1' }],
    minecraftVersions: ['1.21.1'],
  })}\n`);
  assert.equal(loaderVersionCache.readCatalog(cacheDir, { loader: 'neoforge', channel: 'all' }), null);

  const provider = neoforge.createProvider({
    http: {
      getText: async (url) => {
        if (String(url).includes('maven-metadata')) return mavenXml(many);
        if (String(url).includes('/26.2.0.48-beta/')) return pomFor('26.2');
        if (String(url).includes('/21.4.9/')) return pomFor('1.21.4');
        if (String(url).includes('/21.1.39/')) return pomFor('1.21.1');
        return pomFor('26.2');
      },
    },
    knownMinecraftVersions: async () => ['1.21.1', '1.21.4', '26.1', '26.2'],
    dataDir: cacheDir,
  });

  const mcVersions = await provider.listMinecraftVersions();
  assert.ok(mcVersions.includes('1.21.1'));
  assert.ok(mcVersions.includes('1.21.4'));
  assert.ok(mcVersions.includes('26.1'));
  assert.ok(mcVersions.includes('26.2'));
  assert.equal(mcVersions.includes('1.26.2'), false);
  assert.equal(mcVersions.includes('1.26.1'), false);

  const loadersFor262 = await provider.listLoaderVersions('26.2');
  assert.ok(loadersFor262.includes('26.2.0.48-beta'));
  assert.ok(loadersFor262.includes('26.2.0.81'));
  assert.equal(loadersFor262.some((item) => item.startsWith('21.')), false);

  const resolvedLegacy = await provider.resolveInstallation({ minecraftVersion: '1.21.1' });
  assert.equal(resolvedLegacy.minecraftVersion, '1.21.1');
  assert.match(resolvedLegacy.loaderVersion, /^21\.1\./);
  assert.equal(resolvedLegacy.loader, 'neoforge');

  const resolvedModern = await provider.resolveInstallation({
    minecraftVersion: '26.2',
    loaderVersion: '26.2.0.48-beta',
  });
  assert.equal(resolvedModern.minecraftVersion, '26.2');
  assert.equal(resolvedModern.loaderVersion, '26.2.0.48-beta');
  assert.equal(resolvedModern.loaderChannel, 'beta');
  assert.equal(resolvedModern.javaMajor, 25);

  const plan = await provider.planInstallation({ minecraftVersion: '26.2', loaderVersion: '26.2.0.48-beta' });
  assert.equal(plan.result.minecraftVersion, '26.2');
  assert.equal(plan.result.loaderVersion, '26.2.0.48-beta');
  assert.match(plan.downloads[0].url, /26\.2\.0\.48-beta/);
  assert.match(plan.downloads[0].destination, /neoforge-26\.2\.0\.48-beta-installer\.jar/);
  assert.ok(plan.result.argFile.includes('26.2.0.48-beta'));
  assert.ok(!plan.result.argFile.includes('\\') || process.platform === 'win32');

  const launch = provider.getLaunchSpecification({
    loader_version: '26.2.0.48-beta',
    minecraft_version: '26.2',
    java_major: 25,
    loader_metadata: JSON.stringify(plan.result),
  });
  assert.ok(launch.arguments[0].startsWith('@'));
  assert.match(launch.arguments[0], /26\.2\.0\.48-beta/);

  await assert.rejects(
    () => provider.resolveInstallation({ minecraftVersion: '1.16.5' }),
    (err) => err.code === 'NEOFORGE_MINECRAFT_UNSUPPORTED'
  );
  await assert.rejects(
    () => provider.resolveInstallation({ minecraftVersion: '26.2', loaderVersion: '21.1.39' }),
    (err) => err.code === 'NEOFORGE_LOADER_INCOMPATIBLE'
  );

  const fabricProvider = require('../server/bundled-plugins/java-loader-fabric/backend').createProvider({
    http: {
      getJson: async (url) => {
        if (url.endsWith('/versions/game')) return [{ version: '1.21.1', stable: true }, { version: '26.2', stable: true }];
        if (url.includes('/versions/loader/')) return [{ loader: { version: '0.16.0' } }];
        if (url.endsWith('/versions/installer')) return [{ version: '1.0.1', stable: true }];
        throw new Error(`unexpected ${url}`);
      },
    },
  });
  const fabricGames = await fabricProvider.listMinecraftVersions();
  assert.deepEqual(fabricGames, ['1.21.1', '26.2']);
  const fabricPlan = await fabricProvider.planInstallation({ minecraftVersion: '1.21.1', loaderVersion: '0.16.0' });
  assert.equal(fabricPlan.result.minecraftVersion, '1.21.1');
  assert.equal(fabricPlan.result.loaderVersion, '0.16.0');

  if (db) {
    const logs = [];
    const logger = { info: (msg) => logs.push(msg), warn: (msg) => logs.push(msg) };
    const neoLegacyDir = path.join(testRoot, 'repair-legacy');
    const neoModernDir = path.join(testRoot, 'repair-modern');
    const uncertainDir = path.join(testRoot, 'repair-uncertain');
    fs.mkdirSync(neoLegacyDir, { recursive: true });
    fs.mkdirSync(neoModernDir, { recursive: true });
    fs.mkdirSync(uncertainDir, { recursive: true });
    const insert = db.prepare(`
      INSERT INTO servers (name, version, port, data_path, kind, status, loader_provider_id, loader_version, minecraft_version, loader_metadata)
      VALUES (?, ?, ?, ?, 'java', 'stopped', ?, ?, ?, ?)
    `);
    const legacy = insert.run(
      'Repair Legacy',
      '1.21.1',
      25701,
      neoLegacyDir,
      'neoforge',
      '21.1.66',
      '1.21.1',
      JSON.stringify({ loader: 'neoforge', minecraftVersion: '1.21.1', loaderVersion: '21.1.66' })
    );
    const fabricated = insert.run(
      'Repair Fabricated',
      '1.26.2',
      25702,
      neoModernDir,
      'neoforge',
      '26.2.0.48-beta',
      '1.26.2',
      JSON.stringify({ loader: 'neoforge', minecraftVersion: '1.26.2', loaderVersion: '26.2.0.48-beta' })
    );
    const fabricRow = insert.run(
      'Leave Fabric',
      '1.26.1',
      25703,
      uncertainDir,
      'fabric',
      '0.16.0',
      '1.26.1',
      JSON.stringify({ loader: 'fabric', minecraftVersion: '1.26.1' })
    );
    const uncertain = insert.run(
      'Uncertain Neo',
      'mystery',
      25704,
      uncertainDir,
      'neoforge',
      '',
      'mystery',
      '{}'
    );
    const first = recordRepair.repairPersistedRecords({ db, logger });
    assert.ok(first.repaired >= 1);
    const legacyStored = db.prepare('SELECT * FROM servers WHERE id = ?').get(legacy.lastInsertRowid);
    assert.equal(legacyStored.minecraft_version, '1.21.1');
    assert.equal(legacyStored.loader_version, '21.1.66');
    const modernStored = db.prepare('SELECT * FROM servers WHERE id = ?').get(fabricated.lastInsertRowid);
    assert.equal(modernStored.minecraft_version, '26.2');
    assert.equal(modernStored.version, '26.2');
    assert.equal(modernStored.loader_version, '26.2.0.48-beta');
    assert.equal(JSON.parse(modernStored.loader_metadata).minecraftVersion, '26.2');
    const fabricStored = db.prepare('SELECT * FROM servers WHERE id = ?').get(fabricRow.lastInsertRowid);
    assert.equal(fabricStored.minecraft_version, '1.26.1');
    const uncertainStored = db.prepare('SELECT * FROM servers WHERE id = ?').get(uncertain.lastInsertRowid);
    assert.equal(uncertainStored.minecraft_version, 'mystery');
    assert.ok(logs.some((item) => /could not be verified|no verifiable Minecraft version/i.test(item)));
    const second = recordRepair.repairPersistedRecords({ db, logger });
    assert.equal(second.repaired, 0);
    const modernAgain = db.prepare('SELECT minecraft_version FROM servers WHERE id = ?').get(fabricated.lastInsertRowid);
    assert.equal(modernAgain.minecraft_version, '26.2');
  }
}

module.exports = { runNeoForgeVersionMappingTests };
