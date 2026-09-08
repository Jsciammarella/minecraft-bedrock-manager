'use strict';

const assert = require('assert');
const {
  LIMITS,
  compareFabricVersions,
  evaluateFabricDependency,
  parseFabricPredicate,
  parseFabricVersion,
  satisfiesFabricDependency,
  satisfiesFabricPredicate,
} = require('../server/services/fabricVersionPredicate');
const { isMavenRange, satisfiesMavenRange } = require('../server/services/mavenVersionRange');
const floodgateVersions = require('../server/bundled-plugins/gateway-geyser/floodgateVersions');
const floodgateJar = require('../server/bundled-plugins/gateway-geyser/floodgateJar');
const javaModMetadata = require('../server/services/javaModMetadata');

function cmp(left, right) {
  return compareFabricVersions(left, right, { semanticOnly: true });
}

function runFabricVersionPredicateTests() {
  assert.equal(satisfiesFabricPredicate('26.2', '~26.2-'), true);

  assert.ok(cmp('26.2-', '26.2-alpha.1') < 0);
  assert.ok(cmp('26.2-', '26.2') < 0);
  assert.ok(cmp('26.2-alpha.1', '26.2') < 0);

  assert.equal(satisfiesFabricPredicate('26.2', '~26.2-'), true);
  assert.equal(satisfiesFabricPredicate('26.2.1', '~26.2-'), true);
  assert.equal(satisfiesFabricPredicate('26.2-rc.2', '~26.2-rc.2'), true);
  assert.equal(satisfiesFabricPredicate('26.2', '~26.2-rc.2'), true);
  assert.equal(satisfiesFabricPredicate('26.2-rc.1', '~26.2-rc.2'), false);
  assert.equal(satisfiesFabricPredicate('26.1.9', '~26.2-'), false);
  assert.equal(satisfiesFabricPredicate('26.3', '~26.2-'), false);
  assert.equal(satisfiesFabricPredicate('26.3-alpha.1', '~26.2-'), false);

  assert.equal(satisfiesFabricPredicate('26.2', '^26.2'), true);
  assert.equal(satisfiesFabricPredicate('26.9', '^26.2'), true);
  assert.equal(satisfiesFabricPredicate('27.0', '^26.2'), false);
  assert.equal(satisfiesFabricPredicate('0.9', '^0.2'), true);
  assert.equal(satisfiesFabricPredicate('1.0', '^0.2'), false);

  assert.equal(satisfiesFabricPredicate('26.2', '26.x'), true);
  assert.equal(satisfiesFabricPredicate('26.9', '26.*'), true);
  assert.equal(satisfiesFabricPredicate('27.0', '26.X'), false);
  assert.equal(satisfiesFabricPredicate('26.2.5', '26.2.x'), true);
  assert.equal(satisfiesFabricPredicate('26.3', '26.2.*'), false);

  assert.equal(satisfiesFabricPredicate('26.2-rc.1', '>26.2- <26.2'), true);
  assert.equal(satisfiesFabricPredicate('26.2', '>26.2- <26.2'), false);
  assert.equal(satisfiesFabricPredicate('26.2', '>=26.2- <26.3-'), true);

  assert.equal(satisfiesFabricDependency('26.2', ['~1.21.1', '~26.2-']), true);
  assert.equal(satisfiesFabricDependency('26.2', ['26.3', '~1.21.1']), false);
  assert.equal(satisfiesFabricDependency('26.2', '26.3 ~26.2-'), false);

  assert.equal(cmp('26.2', '26.2.0'), 0);
  assert.equal(cmp('26.2.1', '26.2.1.0'), 0);
  assert.equal(cmp('0.160.0+26.2', '0.160.0+26.3'), 0);

  const emptyPre = parseFabricVersion('26.2-');
  assert.equal(emptyPre.semantic, true);
  assert.equal(emptyPre.hasEmptyPrerelease, true);
  assert.deepEqual(emptyPre.prerelease, []);
  assert.equal(parseFabricVersion('26.2-alpha.1').hasEmptyPrerelease, false);
  assert.equal(parseFabricVersion('26.2').hasPrerelease, false);
  assert.equal(parseFabricVersion('26.2+build.4').hasPrerelease, false);
  assert.equal(parseFabricVersion('26.2+build.4').build, 'build.4');

  const parsedAnd = parseFabricPredicate('>=26.2- <26.3-');
  assert.equal(parsedAnd.type, 'and');
  assert.equal(parsedAnd.terms.length, 2);
  assert.equal(parsedAnd.terms[0].operator, '>=');
  assert.equal(parsedAnd.terms[0].version.hasEmptyPrerelease, true);
  assert.equal(parsedAnd.terms[1].operator, '<');

  assert.equal(satisfiesFabricPredicate('release-candidate', 'release-candidate'), true);
  assert.equal(satisfiesFabricPredicate('release-candidate', 'other'), false);
  assert.equal(satisfiesFabricPredicate('release-candidate', '=release-candidate'), true);
  assert.equal(satisfiesFabricPredicate('release-candidate', '*'), true);
  const exclusivePlain = evaluateFabricDependency('release-candidate', '>release-candidate');
  assert.equal(exclusivePlain.compatible, false);
  assert.equal(exclusivePlain.parseError, true);

  const tooLong = evaluateFabricDependency('26.2', `>=${'1'.repeat(LIMITS.maxPredicateLength)}`);
  assert.equal(tooLong.compatible, false);
  assert.equal(tooLong.parseError, true);

  const wildcardPrerelease = parseFabricPredicate('26.2.x-alpha');
  assert.equal(wildcardPrerelease.type, 'term');
  assert.equal(wildcardPrerelease.version.semantic, false);
  assert.equal(satisfiesFabricPredicate('26.2', '26.2.x-alpha'), false);

  assert.equal(satisfiesFabricDependency('26.2', []), false);
  assert.equal(satisfiesFabricDependency('26.2', null), true);
  assert.equal(satisfiesFabricDependency('26.2', ''), true);

  const floodgate26 = evaluateFabricDependency('26.2', '~26.2-', {
    normalizeMinecraft: true,
    subject: 'Minecraft',
  });
  assert.equal(floodgate26.compatible, true);
  const floodgate263 = evaluateFabricDependency('26.3', '~26.2-', {
    normalizeMinecraft: true,
    subject: 'Minecraft',
  });
  assert.equal(floodgate263.compatible, false);
  assert.match(floodgate263.reason, /26\.2 version family/);

  assert.equal(floodgateVersions.satisfiesConstraint('~26.2-', '26.2', 'minecraft'), true);
  assert.equal(floodgateVersions.satisfiesConstraint('~26.2-', '1.26.2', 'minecraft'), true);
  assert.equal(floodgateVersions.satisfiesConstraint('~26.2-', '26.3', 'minecraft'), false);
  assert.equal(floodgateVersions.satisfiesConstraint('[1.21,1.21.3]', '1.21.1', 'minecraft'), true);
  assert.equal(floodgateVersions.satisfiesConstraint('[1.21,1.21.3]', '26.2', 'minecraft'), false);
  assert.equal(floodgateVersions.satisfiesConstraint('[21.0,)', '21.1.1', 'loader'), true);
  assert.equal(floodgateVersions.satisfiesConstraint('>=0.16.0', '0.19.5', 'loader'), true);
  assert.equal(isMavenRange('[21.0,22.0)'), true);
  assert.equal(isMavenRange('~26.2-'), false);
  assert.equal(satisfiesMavenRange('[21.0,22.0)', '21.1.1', 'loader'), true);

  assert.equal(floodgateVersions.catalogListsExactMinecraft(['~26.2-'], '26.2'), false);
  assert.equal(floodgateVersions.catalogListsExactMinecraft(['26.2'], '26.2'), true);

  const zlib = require('zlib');
  function zipStore(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, body] of Object.entries(files)) {
      const data = Buffer.from(body);
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

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbm-fabric-pred-'));
  try {
    const jarPath = path.join(tmp, 'floodgate.jar');
    fs.writeFileSync(jarPath, zipStore({
      'fabric.mod.json': JSON.stringify({
        id: 'floodgate',
        version: '2.2.6',
        environment: '*',
        depends: {
          minecraft: '~26.2-',
          fabricloader: '>=0.16.0',
          'fabric-api': '*',
        },
      }),
    }));
    const accepted = floodgateJar.validateFloodgateJar(jarPath, {
      loader: 'fabric',
      minecraftVersion: '26.2',
      loaderVersion: '0.19.5',
    }, { gameVersions: ['26.2'] });
    assert.equal(accepted.modId, 'floodgate');
    assert.equal(accepted.fabricApiDependId, 'fabric-api');
    assert.throws(
      () => floodgateJar.validateFloodgateJar(jarPath, {
        loader: 'fabric',
        minecraftVersion: '26.3',
        loaderVersion: '0.19.5',
      }),
      (err) => err.code === 'FLOODGATE_MINECRAFT_MISMATCH' && /26\.2/.test(err.message)
    );

    const orJar = path.join(tmp, 'floodgate-or.jar');
    fs.writeFileSync(orJar, zipStore({
      'fabric.mod.json': JSON.stringify({
        id: 'floodgate',
        version: '2.2.6',
        environment: '*',
        depends: {
          minecraft: ['~1.21.1', '~26.2-'],
          fabricloader: '>=0.16.0',
          'fabric-api': '*',
        },
      }),
    }));
    assert.equal(
      floodgateJar.validateFloodgateJar(orJar, {
        loader: 'fabric',
        minecraftVersion: '26.2',
        loaderVersion: '0.19.5',
      }).modId,
      'floodgate'
    );

    const badJar = path.join(tmp, 'floodgate-bad.jar');
    fs.writeFileSync(badJar, zipStore({
      'fabric.mod.json': JSON.stringify({
        id: 'floodgate',
        version: '2.2.6',
        environment: '*',
        depends: {
          minecraft: '>not-a-version',
          fabricloader: '>=0.16.0',
        },
      }),
    }));
    assert.throws(
      () => floodgateJar.validateFloodgateJar(badJar, {
        loader: 'fabric',
        minecraftVersion: '26.2',
        loaderVersion: '0.19.5',
      }),
      (err) => err.code === 'FLOODGATE_MINECRAFT_MISMATCH'
        && /could not interpret/i.test(err.message)
        && !/\.js:\d+/.test(err.message)
    );

    const parsedFabric = javaModMetadata.detectFabric(JSON.stringify({
      id: 'demo',
      depends: { minecraft: ['~1.21.1', '~26.2-'] },
    }));
    assert.deepEqual(parsedFabric.dependencies[0].version, ['~1.21.1', '~26.2-']);
    const compat = javaModMetadata.evaluateMinecraftRequirement('26.2', {
      loader: 'fabric',
      metadata: { depends: { minecraft: '~26.2-' } },
    });
    assert.equal(compat.compatible, true);
    const neo = javaModMetadata.evaluateMinecraftRequirement('1.21.1', {
      loader: 'neoforge',
      dependencies: [{ id: 'minecraft', version: '[1.21,1.21.3]' }],
    });
    assert.equal(neo.compatible, true);
    const neoMiss = javaModMetadata.evaluateMinecraftRequirement('26.2', {
      loader: 'neoforge',
      dependencies: [{ id: 'minecraft', version: '[1.21,1.21.3]' }],
    });
    assert.equal(neoMiss.compatible, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { runFabricVersionPredicateTests };

if (require.main === module) {
  runFabricVersionPredicateTests();
  console.log('fabric version predicate tests ok');
}
