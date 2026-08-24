const assert = require('assert');
const fs = require('fs');
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

function jarBytes() {
  return zipStore({
    'fabric.mod.json': JSON.stringify({
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      environment: '*',
    }),
  });
}

async function runModrinthProviderTests({ pluginHost, testRoot }) {
  const axios = require('axios');
  const catalogHttp = require('../server/services/catalogHttp');
  const catalogProviderRegistry = require('../server/services/catalogProviderRegistry');
  const catalogDownloadPolicy = require('../server/services/catalogDownloadPolicy');
  const catalogLibrary = require('../server/services/catalogLibrary');
  const catalogService = require('../server/services/catalogService');
  const controlledDownload = require('../server/services/controlledDownload');
  const productIdentity = require('../server/services/productIdentity');
  const pluginCapabilities = require('../server/services/pluginCapabilities');
  const modrinth = require('../server/bundled-plugins/catalog-modrinth-java/backend');

  assert.match(productIdentity.userAgent(), /^minecraft-bedrock-manager\/\d/);
  assert.match(productIdentity.userAgent(), /github\.com/);
  assert.match(controlledDownload.USER_AGENT, /minecraft-bedrock-manager\/\d/);
  assert.equal(pluginCapabilities.parseCapabilities(['provider:catalog-source'], 'user').rejectedPrivileged.includes('provider:catalog-source'), true);

  const pluginJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../server/bundled-plugins/catalog-modrinth-java/plugin.json'), 'utf8'));
  assert.equal(pluginJson.id, 'catalog-modrinth-java');
  assert.ok(pluginJson.capabilities.includes('provider:catalog-source'));
  assert.ok(pluginJson.downloadHosts.includes('api.modrinth.com'));
  assert.ok(pluginJson.downloadHosts.includes('cdn.modrinth.com'));
  assert.ok(!JSON.stringify(pluginJson).toLowerCase().includes('authorization'));

  assert.equal(modrinth.mapEnvironment('client_only').environment, 'client');
  assert.equal(modrinth.mapEnvironment('singleplayer_only').environment, 'client');
  assert.equal(modrinth.mapEnvironment('server_only').environment, 'server');
  assert.equal(modrinth.mapEnvironment('dedicated_server_only').environment, 'server');
  assert.equal(modrinth.mapEnvironment('client_and_server').environment, 'both');
  assert.match(modrinth.mapEnvironment('client_and_server').warning, /connecting Minecraft clients/);
  assert.equal(modrinth.mapEnvironment('client_or_server').environment, 'both');
  assert.equal(modrinth.mapEnvironment('client_or_server').label.includes('Server Only'), false);
  assert.equal(modrinth.mapEnvironment('client_only_server_optional').environment, 'both');
  assert.match(modrinth.mapEnvironment('client_only_server_optional').label, /Client Focused/);
  assert.equal(modrinth.mapEnvironment('unknown').environment, 'unknown');
  assert.equal(modrinth.mapEnvironment('unknown').label, 'Compatibility Unknown');

  assert.equal(modrinth.sortIndex('relevancy'), 'relevance');
  assert.equal(modrinth.sortIndex('popularity'), 'follows');
  assert.equal(modrinth.sortIndex('lastUpdated'), 'updated');
  assert.equal(modrinth.sortIndex('totalDownloads'), 'downloads');
  assert.equal(modrinth.sortIndex('newest'), 'newest');

  const facets = JSON.parse(JSON.stringify(modrinth.buildFacets({
    minecraftVersions: ['1.21.1'],
    loader: 'neoforge',
    category: 'modrinth-java:technology',
    environment: 'server-compatible',
  })));
  assert.ok(facets.some((group) => group.includes('project_type:mod')));
  assert.ok(facets.some((group) => group.includes('versions:1.21.1')));
  assert.ok(facets.some((group) => group.includes('categories:neoforge') && group.includes('categories:forge')));
  assert.ok(facets.some((group) => group.includes('categories:technology')));
  const injected = modrinth.buildFacets({ category: 'modrinth-java:technology"],["project_type:modpack' });
  assert.ok(!JSON.stringify(injected).includes('modpack'));

  assert.equal(modrinth.isInstallableJar({ filename: 'mod.jar', primary: true }), true);
  assert.equal(modrinth.isInstallableJar({ filename: 'mod-sources.jar' }), false);
  assert.equal(modrinth.isInstallableJar({ filename: 'mod-javadoc.jar' }), false);
  assert.equal(modrinth.isInstallableJar({ filename: 'mod-dev.jar' }), false);
  assert.equal(modrinth.selectPrimaryFile([
    { filename: 'mod-sources.jar', primary: true },
    { filename: 'mod.jar', primary: false },
  ]).filename, 'mod.jar');

  const dirty = modrinth.formatProject({
    project_id: 'AABBCCDD',
    slug: 'demo',
    title: '<script>alert(1)</script>Demo',
    description: '<b>bold</b> text',
    author: 'JellySquid',
    license: { id: 'MIT' },
    icon_url: 'https://cdn.modrinth.com/data/AABBCCDD/icon.png',
    environment: ['client_only'],
    categories: ['fabric', 'optimization'],
    versions: ['1.21.1'],
    downloads: 12,
    follows: 3,
  });
  assert.equal(dirty.name.includes('<script>'), false);
  assert.equal(dirty.description.includes('<b>'), false);
  assert.equal(dirty.source, 'modrinth');
  assert.equal(dirty.providerId, 'modrinth-java');
  assert.equal(dirty.environment, 'client');
  assert.equal(dirty.license, 'MIT');
  assert.equal(dirty.follows, 3);
  assert.match(dirty.websiteUrl, /^https:\/\/modrinth\.com\/mod\//);
  assert.equal(modrinth.formatProject({
    project_id: 'x',
    icon_url: 'https://evil.example/icon.png',
    websiteUrl: 'javascript:alert(1)',
  }).thumbnail, '');

  const captured = [];
  const versions = [{
    id: 'VERSERVER',
    project_id: 'PROJ1',
    name: '1.0.0',
    version_number: '1.0.0',
    environment: 'server_only',
    loaders: ['neoforge'],
    game_versions: ['1.21.1'],
    version_type: 'release',
    date_published: '2026-01-01T00:00:00Z',
    dependencies: [],
    files: [{
      filename: 'server.jar',
      primary: true,
      size: 12,
      url: 'https://cdn.modrinth.com/data/PROJ1/versions/VERSERVER/server.jar',
      hashes: { sha1: 'abc', sha512: 'def' },
    }],
  }, {
    id: 'VERCLIENT',
    project_id: 'PROJ1',
    name: '1.0.0-client',
    environment: 'client_only',
    loaders: ['neoforge'],
    game_versions: ['1.21.1'],
    files: [{
      filename: 'client.jar',
      primary: true,
      size: 12,
      url: 'https://cdn.modrinth.com/data/PROJ1/versions/VERCLIENT/client.jar',
      hashes: { sha1: 'aaa' },
    }],
  }, {
    id: 'VERUNKNOWN',
    project_id: 'PROJ1',
    name: '1.0.0-unknown',
    environment: 'unknown',
    loaders: ['neoforge'],
    game_versions: ['1.21.1'],
    files: [{
      filename: 'unknown.jar',
      primary: true,
      size: 12,
      url: 'https://cdn.modrinth.com/data/PROJ1/versions/VERUNKNOWN/unknown.jar',
      hashes: { sha1: 'eee' },
    }],
  }, {
    id: 'VERNEWEST',
    project_id: 'PROJ1',
    name: '9.9.9',
    environment: 'server_only',
    loaders: ['neoforge'],
    game_versions: ['1.99.0'],
    files: [{
      filename: 'newest.jar',
      primary: true,
      size: 12,
      url: 'https://cdn.modrinth.com/data/PROJ1/versions/VERNEWEST/newest.jar',
      hashes: { sha1: 'fff' },
    }],
  }, {
    id: 'VERBOTH',
    project_id: 'PROJ1',
    name: '1.0.0-both',
    environment: 'client_and_server',
    loaders: ['neoforge'],
    game_versions: ['1.21.1'],
    files: [{
      filename: 'both.jar',
      primary: true,
      size: 12,
      url: 'https://cdn.modrinth.com/data/PROJ1/versions/VERBOTH/both.jar',
      hashes: { sha1: 'bbb' },
    }],
  }];
  const http = {
    isConfigured: () => true,
    request: async ({ credentialProfile, url, params }) => {
      captured.push({ credentialProfile, url, params, headersProbe: true });
      assert.equal(credentialProfile, 'modrinth');
      if (String(url).includes('/search')) {
        const facets = JSON.parse(params.facets);
        assert.ok(facets.some((group) => group.includes('project_type:mod')));
        assert.ok(params.limit <= 40);
        return {
          data: {
            hits: [{
              project_id: 'PROJ1',
              slug: 'demo',
              title: 'Demo',
              description: 'A mod',
              author: 'Author',
              environment: ['client_only', 'server_only'],
              categories: ['neoforge'],
              versions: ['1.21.1'],
              downloads: 10,
            }],
            total_hits: 1,
          },
        };
      }
      if (String(url).includes('/tag/category')) {
        return { data: [{ name: 'technology', project_type: 'mod' }, { name: 'audio', project_type: 'resourcepack' }] };
      }
      if (/\/project\/[^/]+$/.test(String(url))) {
        return {
          data: {
            id: 'PROJ1',
            slug: 'demo',
            title: 'Demo',
            description: 'A mod',
            game_versions: ['1.21.1'],
            environment: ['server_only'],
            categories: ['neoforge'],
            license: { id: 'MIT' },
          },
        };
      }
      if (String(url).includes('/version/') && !String(url).includes('/project/')) {
        const id = String(url).split('/').pop();
        const found = versions.find((item) => item.id === id);
        if (!found) {
          const err = new Error('missing');
          err.status = 404;
          throw err;
        }
        return { data: found };
      }
      if (String(url).includes('/version')) {
        let listed = versions;
        if (params?.loaders) {
          const wanted = JSON.parse(params.loaders);
          listed = listed.filter((item) => item.loaders.some((loader) => wanted.includes(loader)));
        }
        if (params?.game_versions) {
          const wanted = JSON.parse(params.game_versions);
          listed = listed.filter((item) => item.game_versions.some((version) => wanted.includes(version)));
        }
        assert.equal(params.include_changelog, 'false');
        return { data: listed };
      }
      throw new Error(`unexpected ${url}`);
    },
  };
  const provider = modrinth.createProvider({ catalogHttp: http });
  assert.equal(provider.getMetadata().id, 'modrinth-java');
  assert.equal(provider.getMetadata().credentialProfile, null);
  assert.equal(provider.isAvailable(), true);

  const cats = await provider.getCategories();
  assert.deepEqual(cats.map((item) => item.id), ['modrinth-java:technology']);

  const search = await provider.search('create', {
    page: 1,
    pageSize: 40,
    loader: 'neoforge',
    minecraftVersions: ['1.21.1'],
    sortBy: 'totalDownloads',
    environment: 'server-compatible',
  });
  const searchCall = captured.find((item) => String(item.url).endsWith('/search'));
  assert.equal(searchCall.params.index, 'downloads');
  assert.equal(searchCall.params.query, 'create');
  assert.equal(search.results[0].environment, 'unknown');
  assert.equal(search.results[0].downloadState, 'unknown');

  const files = await provider.listDownloadFiles('PROJ1', { loader: 'neoforge', minecraftVersions: ['1.21.1'] });
  assert.ok(files.some((file) => file.environment === 'server'));
  assert.ok(files.some((file) => file.environment === 'client'));
  assert.ok(files.some((file) => file.environment === 'unknown'));
  assert.equal(files.some((file) => file.id === 'VERNEWEST'), false);
  const both = files.find((file) => file.id === 'VERBOTH');
  assert.match(both.warning, /connecting Minecraft clients/);
  assert.equal(both.environmentLabel, 'Client & Server Required');

  await assert.rejects(() => provider.download('PROJ1', ['VERCLIENT']), (err) => err.code === 'CLIENT_ONLY_FILE');
  const serverPlan = await provider.download('PROJ1', ['VERSERVER']);
  assert.equal(serverPlan.plan, true);
  assert.equal(serverPlan.files[0].environment, 'server');
  assert.match(serverPlan.files[0].url, /^https:\/\/cdn\.modrinth\.com\//);
  assert.match(serverPlan.files[0].metadata.modrinth.downloadUrl, /^https:\/\/cdn\.modrinth\.com\//);
  const bothPlan = await provider.download('PROJ1', ['VERBOTH']);
  assert.match(bothPlan.files[0].warning, /connecting Minecraft clients/);
  const unknownPlan = await provider.download('PROJ1', ['VERUNKNOWN']);
  assert.equal(unknownPlan.files[0].environment, 'unknown');
  assert.equal(unknownPlan.files[0].environmentLabel, 'Compatibility Unknown');
  const picker = await provider.download('PROJ1', []);
  assert.equal(picker.needsSelection, true);

  const cachedSearchCalls = captured.filter((item) => String(item.url).endsWith('/search')).length;
  await provider.search('create', {
    page: 1,
    pageSize: 200,
    loader: 'neoforge',
    minecraftVersions: ['1.21.1'],
    sortBy: 'totalDownloads',
    environment: 'server-compatible',
  });
  assert.equal(captured.filter((item) => String(item.url).endsWith('/search')).length, cachedSearchCalls);
  await provider.search('create', {
    page: 1,
    pageSize: 200,
    loader: 'fabric',
    minecraftVersions: ['1.21.1'],
    sortBy: 'totalDownloads',
    environment: 'all',
  });
  const secondSearch = captured.filter((item) => String(item.url).endsWith('/search')).pop();
  assert.equal(secondSearch.params.limit, 40);
  assert.notEqual(secondSearch.params.facets, searchCall.params.facets);

  const depVersions = {
    REQ: {
      id: 'REQ',
      project_id: 'DEP1',
      environment: 'server_only',
      loaders: ['neoforge'],
      game_versions: ['1.21.1'],
      dependencies: [],
      files: [{
        filename: 'dep.jar',
        primary: true,
        url: 'https://cdn.modrinth.com/data/DEP1/dep.jar',
        hashes: { sha1: 'ccc' },
      }],
    },
    OPT: {
      id: 'OPT',
      project_id: 'DEPOPT',
      environment: 'server_only',
      loaders: ['neoforge'],
      game_versions: ['1.21.1'],
      dependencies: [],
      files: [{
        filename: 'opt.jar',
        primary: true,
        url: 'https://cdn.modrinth.com/data/DEPOPT/opt.jar',
        hashes: {},
      }],
    },
    CLIENTDEP: {
      id: 'CLIENTDEP',
      project_id: 'DEPCLIENT',
      environment: 'client_only',
      loaders: ['neoforge'],
      game_versions: ['1.21.1'],
      dependencies: [],
      files: [{
        filename: 'cdep.jar',
        primary: true,
        url: 'https://cdn.modrinth.com/data/DEPCLIENT/cdep.jar',
        hashes: {},
      }],
    },
  };
  const parentWithDeps = {
    id: 'PARENT',
    project_id: 'PARENT',
    environment: 'server_only',
    loaders: ['neoforge'],
    game_versions: ['1.21.1'],
    dependencies: [
      { dependency_type: 'required', version_id: 'REQ', project_id: 'DEP1' },
      { dependency_type: 'optional', version_id: 'OPT', project_id: 'DEPOPT' },
    ],
    files: [{
      filename: 'parent.jar',
      primary: true,
      url: 'https://cdn.modrinth.com/data/PARENT/parent.jar',
      hashes: { sha1: 'ddd' },
    }],
  };
  const depHttp = {
    request: async ({ url }) => {
      if (/\/project\/[^/]+$/.test(url)) {
        const id = url.split('/').pop();
        return { data: { id, slug: id.toLowerCase(), title: id, game_versions: ['1.21.1'], environment: ['server_only'], categories: ['neoforge'] } };
      }
      if (url.endsWith('/version/REQ')) return { data: depVersions.REQ };
      if (url.endsWith('/version/OPT')) return { data: depVersions.OPT };
      if (url.endsWith('/version/CLIENTDEP')) return { data: depVersions.CLIENTDEP };
      if (url.includes('/version') && url.includes('PARENT')) return { data: [parentWithDeps] };
      if (url.includes('/project/PARENT')) return { data: { id: 'PARENT', slug: 'parent', title: 'Parent' } };
      throw new Error(url);
    },
  };
  const depProvider = modrinth.createProvider({ catalogHttp: depHttp });
  const depPlan = await depProvider.download('PARENT', ['PARENT']);
  assert.equal(depPlan.files.length, 1);
  assert.equal(depPlan.relatedPlans.length, 1);
  assert.equal(depPlan.relatedPlans[0].project.modrinthId, 'DEP1');
  assert.equal(depPlan.relatedPlans.some((item) => item.project.modrinthId === 'DEPOPT'), false);

  const clientDepParent = {
    ...parentWithDeps,
    dependencies: [{ dependency_type: 'required', version_id: 'CLIENTDEP', project_id: 'DEPCLIENT' }],
  };
  const clientDepHttp = {
    request: async ({ url }) => {
      if (/\/project\/[^/]+$/.test(url)) {
        const id = url.split('/').pop();
        return { data: { id, slug: id.toLowerCase(), title: id, environment: ['server_only'], categories: ['neoforge'] } };
      }
      if (url.endsWith('/version/CLIENTDEP')) return { data: depVersions.CLIENTDEP };
      if (url.includes('/version')) return { data: [clientDepParent] };
      throw new Error(url);
    },
  };
  await assert.rejects(
    () => modrinth.createProvider({ catalogHttp: clientDepHttp }).download('PARENT', ['PARENT']),
    (err) => err.code === 'CLIENT_ONLY_FILE'
  );

  const cycleA = {
    id: 'A',
    project_id: 'A',
    environment: 'server_only',
    loaders: ['neoforge'],
    game_versions: ['1.21.1'],
    dependencies: [{ dependency_type: 'required', version_id: 'B', project_id: 'B' }],
    files: [{ filename: 'a.jar', primary: true, url: 'https://cdn.modrinth.com/data/A/a.jar', hashes: {} }],
  };
  const cycleB = {
    id: 'B',
    project_id: 'B',
    environment: 'server_only',
    loaders: ['neoforge'],
    game_versions: ['1.21.1'],
    dependencies: [{ dependency_type: 'required', version_id: 'A', project_id: 'A' }],
    files: [{ filename: 'b.jar', primary: true, url: 'https://cdn.modrinth.com/data/B/b.jar', hashes: {} }],
  };
  const cycleHttp = {
    request: async ({ url }) => {
      if (url.endsWith('/version/A') || (url.includes('/project/A') && url.includes('/version'))) return { data: url.includes('/version/A') ? cycleA : [cycleA] };
      if (url.endsWith('/version/B')) return { data: cycleB };
      if (/\/project\/[^/]+$/.test(url)) {
        const id = url.split('/').pop();
        return { data: { id, slug: id.toLowerCase(), title: id } };
      }
      throw new Error(url);
    },
  };
  await assert.rejects(
    () => modrinth.createProvider({ catalogHttp: cycleHttp }).download('A', ['A']),
    (err) => err.code === 'DEPENDENCY_CYCLE'
  );

  const depthHttp = {
    request: async ({ url }) => {
      if (/\/project\/[^/]+$/.test(url)) {
        const id = url.split('/').pop();
        return { data: { id, slug: String(id).toLowerCase(), title: id, environment: ['server_only'], categories: ['neoforge'] } };
      }
      const versionMatch = String(url).match(/\/version\/(D\d+)$/);
      const id = versionMatch ? versionMatch[1] : (String(url).includes('/project/D0') ? 'D0' : '');
      if (!id) throw new Error(url);
      const n = Number(id.slice(1));
      const version = {
        id,
        project_id: id,
        environment: 'server_only',
        loaders: ['neoforge'],
        game_versions: ['1.21.1'],
        dependencies: n < 12 ? [{ dependency_type: 'required', version_id: `D${n + 1}`, project_id: `D${n + 1}` }] : [],
        files: [{ filename: `${id}.jar`, primary: true, url: `https://cdn.modrinth.com/data/${id}/${id}.jar`, hashes: {} }],
      };
      return { data: String(url).includes('/project/') && String(url).includes('/version') ? [version] : version };
    },
  };
  await assert.rejects(
    () => modrinth.createProvider({ catalogHttp: depthHttp }).download('D0', ['D0']),
    (err) => err.code === 'DEPENDENCY_DEPTH'
  );

  catalogDownloadPolicy.assertPlanNotClientOnly({
    project: { edition: 'java', providerId: 'modrinth-java' },
    files: [{ environment: 'server', fileName: 'ok.jar' }],
  });
  assert.throws(
    () => catalogDownloadPolicy.assertPlanNotClientOnly({
      project: { edition: 'java', providerId: 'modrinth-java' },
      files: [{ environment: 'client', fileName: 'no.jar' }],
    }),
    (err) => err.code === 'CLIENT_ONLY_FILE'
  );
  assert.equal(catalogDownloadPolicy.appliesJavaPolicy({ id: 'modrinth-java' }, {}), true);

  const payload = jarBytes();
  const sha1 = crypto.createHash('sha1').update(payload).digest('hex');
  const sha512 = crypto.createHash('sha512').update(payload).digest('hex');
  const dest = path.join(testRoot, 'modrinth-hash.jar');
  await controlledDownload.downloadToFile({
    url: 'https://cdn.modrinth.com/data/x/mod.jar',
    destination: dest,
    allowHosts: ['cdn.modrinth.com'],
    sha1,
    sha512,
    fetcher: async () => payload,
  });
  assert.ok(fs.existsSync(dest));
  await assert.rejects(
    () => controlledDownload.downloadToFile({
      url: 'https://cdn.modrinth.com/data/x/bad.jar',
      destination: path.join(testRoot, 'modrinth-bad.jar'),
      allowHosts: ['cdn.modrinth.com'],
      sha512: '00',
      fetcher: async () => payload,
    }),
    /SHA-512/
  );
  assert.equal(fs.existsSync(path.join(testRoot, 'modrinth-bad.jar')), false);
  await assert.rejects(
    () => controlledDownload.downloadToFile({
      url: 'https://cdn.modrinth.com/data/x/big.jar',
      destination: path.join(testRoot, 'modrinth-big.jar'),
      allowHosts: ['cdn.modrinth.com'],
      maximumBytes: 4,
      fetcher: async () => payload,
    }),
    /byte limit/
  );
  await assert.rejects(
    () => controlledDownload.downloadToFile({
      url: 'https://evil.example/mod.jar',
      destination: path.join(testRoot, 'modrinth-evil.jar'),
      allowHosts: ['cdn.modrinth.com'],
      fetcher: async () => payload,
    }),
    /approved download list/
  );
  assert.equal(controlledDownload.hostnameAllowed('cdn.modrinth.com', ['cdn.modrinth.com']), true);
  assert.equal(controlledDownload.hostnameAllowed('evil.example', ['cdn.modrinth.com']), false);
  const modManager = require('../server/services/modManager');
  assert.equal(modManager.sanitizeFilename('../../etc/passwd.jar'), 'passwd.jar');
  assert.equal(modManager.sanitizeFilename('ok.jar'), 'ok.jar');

  const originalDownload = controlledDownload.downloadToFile;
  let libraryModId = null;
  controlledDownload.downloadToFile = async ({ destination }) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, payload);
    return { path: destination, bytes: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') };
  };
  try {
    const imported = await catalogLibrary.importDownloadPlan({
      project: {
        name: 'Demo',
        slug: 'modrinth-demo',
        edition: 'java',
        source: 'modrinth',
        providerId: 'modrinth-java',
        modrinthId: 'PROJ1',
        artifactType: 'mod',
      },
      files: [{
        url: 'https://cdn.modrinth.com/data/PROJ1/server.jar',
        fileName: 'server.jar',
        fileId: 'VERSERVER',
        loader: 'neoforge',
        minecraftVersions: ['1.21.1'],
        environment: 'server',
        sha1,
        sha512,
        metadata: { modrinth: { projectId: 'PROJ1', versionId: 'VERSERVER' } },
      }],
    }, { allowHosts: ['cdn.modrinth.com'], providerId: 'modrinth-java' });
    assert.equal(imported.success, true);
    const db = require('../server/db/connection');
    const row = db.prepare('SELECT * FROM mods WHERE id = ?').get(imported.modId);
    assert.equal(row.source, 'modrinth');
    assert.equal(row.curseforge_id, null);
    assert.equal(JSON.parse(row.metadata_json).modrinthProjectId, 'PROJ1');
    assert.equal(JSON.parse(row.metadata_json).modrinthVersionId, 'VERSERVER');
    libraryModId = imported.modId;
    const merged = await catalogLibrary.importDownloadPlan({
      project: {
        name: 'Demo',
        slug: 'modrinth-demo',
        edition: 'java',
        source: 'modrinth',
        providerId: 'modrinth-java',
        modrinthId: 'PROJ1',
      },
      files: [{
        url: 'https://cdn.modrinth.com/data/PROJ1/server.jar',
        fileName: 'server-copy.jar',
        sha256: row.sha256,
        loader: 'neoforge',
        minecraftVersions: ['1.21.1'],
        environment: 'server',
      }],
    }, { allowHosts: ['cdn.modrinth.com'], providerId: 'modrinth-java' });
    assert.equal(merged.merged, true);
    assert.equal(merged.modId, imported.modId);
    const otherPayload = zipStore({
      'fabric.mod.json': JSON.stringify({
        id: 'other',
        name: 'Other',
        version: '1.0.0',
        environment: '*',
      }),
    });
    controlledDownload.downloadToFile = async ({ destination }) => {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, otherPayload);
      return {
        path: destination,
        bytes: otherPayload.length,
        sha256: crypto.createHash('sha256').update(otherPayload).digest('hex'),
      };
    };
    const second = await catalogLibrary.importDownloadPlan({
      project: {
        name: 'Other',
        slug: 'modrinth-other',
        edition: 'java',
        source: 'modrinth',
        providerId: 'modrinth-java',
        modrinthId: 'PROJ2',
        artifactType: 'mod',
      },
      files: [{
        url: 'https://cdn.modrinth.com/data/PROJ2/other.jar',
        fileName: 'other.jar',
        fileId: 'VEROTHER',
        loader: 'fabric',
        minecraftVersions: ['1.21.1'],
        environment: 'server',
      }],
    }, { allowHosts: ['cdn.modrinth.com'], providerId: 'modrinth-java' });
    assert.equal(second.success, true);
    assert.notEqual(second.modId, imported.modId);
    const secondRow = db.prepare('SELECT curseforge_id FROM mods WHERE id = ?').get(second.modId);
    assert.equal(secondRow.curseforge_id, null);
  } finally {
    controlledDownload.downloadToFile = originalDownload;
  }

  const originalGet = axios.get;
  const uaCalls = [];
  axios.get = async (url, opts) => {
    uaCalls.push(opts.headers);
    assert.equal(opts.headers.Authorization, undefined);
    assert.ok(!Object.keys(opts.headers).some((key) => /authorization/i.test(key)));
    assert.match(opts.headers['User-Agent'], /minecraft-bedrock-manager\/\d/);
    if (String(url).includes('rate-limit')) {
      return {
        status: 429,
        headers: { 'x-ratelimit-reset': '0', 'x-ratelimit-remaining': '0' },
        data: { error: 'rate_limit' },
      };
    }
    throw new Error(`unexpected ${url}`);
  };
  catalogHttp.resetModrinthLimiterForTests();
  try {
    await assert.rejects(
      () => catalogHttp.request({ credentialProfile: 'modrinth', url: 'https://evil.example/v2/search' }),
      /official Modrinth API host|approved download list/
    );
    await assert.rejects(
      () => catalogHttp.request({ credentialProfile: 'modrinth', url: 'http://api.modrinth.com/v2/search' }),
      /HTTPS/
    );
    await assert.rejects(
      () => catalogHttp.request({ credentialProfile: 'modrinth', url: 'https://api.modrinth.com/v2/rate-limit' }),
      /rate limit/i
    );
    assert.equal(uaCalls.every((headers) => !headers.Authorization), true);
  } finally {
    axios.get = originalGet;
    catalogHttp.resetModrinthLimiterForTests();
  }

  catalogProviderRegistry.clear();
  catalogService.ensureProviders();
  pluginHost.resetForTests();
  pluginHost.loadPlugins([pluginHost.BUNDLED_PLUGINS_DIR]);
  assert.ok(catalogProviderRegistry.get('modrinth-java'));
  assert.ok(catalogProviderRegistry.get('curseforge-java'));
  pluginHost.setPluginEnabled('catalog-modrinth-java', false);
  assert.equal(catalogProviderRegistry.get('modrinth-java'), null);
  assert.ok(catalogProviderRegistry.get('curseforge-java'));
  assert.ok(libraryModId);
  assert.equal(require('../server/db/connection').prepare('SELECT source FROM mods WHERE id = ?').get(libraryModId).source, 'modrinth');
  pluginHost.setPluginEnabled('catalog-modrinth-java', true);
  assert.ok(catalogProviderRegistry.get('modrinth-java'));
  pluginHost.resetForTests();
  catalogProviderRegistry.clear();
  catalogService.ensureProviders();
}

module.exports = { runModrinthProviderTests };
