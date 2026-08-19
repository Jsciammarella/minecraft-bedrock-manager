const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const zlib = require('zlib');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-manager-smoke-'));
process.env.MC_MANAGER_DB_PATH = path.join(testRoot, 'mc_manager.db');
const db = require('../server/db/connection');
const serverManager = require('../server/services/serverManager');
const curseforge = require('../server/services/curseforgeClient');
const gitCatalog = require('../server/services/gitCatalogClient');
const catalogService = require('../server/services/catalogService');
const packInstaller = require('../server/services/packInstaller');
const settingsStore = require('../server/services/settingsStore');
const modManager = require('../server/services/modManager');
const curseforgeImporter = require('../server/services/curseforgeImporter');
const mcpedlImporter = require('../server/services/mcpedlImporter');
const connectHost = require('../server/services/connectHost');
const portRanges = require('../server/services/portRanges');

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

async function run() {
  const accessTable = db.prepare(
    'SELECT name FROM sqlite_master WHERE type = ? AND name = ?'
  ).get('table', 'server_player_access');
  assert(accessTable, 'server_player_access migration was not created');

  const blocker = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.bind(0, '0.0.0.0', resolve);
  });
  const blockedPort = blocker.address().port;
  assert.equal(
    await serverManager.isUdpPortAvailable(blockedPort),
    false,
    'an OS-bound UDP port was incorrectly reported as available'
  );
  await new Promise(resolve => blocker.close(resolve));

  const platform = require('../server/services/platform');
  assert.equal(
    platform.bedrockBinaryName(),
    process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server'
  );
  const needles = platform.bedrockDownloadNeedles();
  if (process.platform === 'win32') {
    assert.ok(needles.typeRe.test('serverBedrockWindows'));
    assert.ok(!needles.typeRe.test('serverBedrockLinux'));
    assert.ok(needles.urlRe.test('https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.21.0.zip'));
  } else {
    assert.ok(needles.typeRe.test('serverBedrockLinux'));
    assert.ok(!needles.typeRe.test('serverBedrockWindows'));
    assert.ok(needles.urlRe.test('https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.21.0.zip'));
    assert.ok(!needles.urlRe.test('https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.21.0.zip'));
  }
  if (!process.env.MC_MANAGER_JAVA && !process.env.JAVA_HOME) {
    assert.equal(platform.javaCommand(), process.platform === 'win32' ? 'java.exe' : 'java');
  }
  const chmodProbe = path.join(testRoot, 'chmod-probe');
  fs.writeFileSync(chmodProbe, 'ok');
  platform.chmodIfNeeded(chmodProbe);
  assert.equal(await platform.pingHost('127.0.0.1'), true, 'loopback ICMP ping should succeed');
  assert.equal(await platform.pingHost('-n'), false, 'ping must not accept option-like hosts');
  const remotePingProbe = require('../server/services/remotePing');
  assert.equal(
    await remotePingProbe.probeBedrock('127.0.0.1', 9, 400),
    false,
    'a closed UDP port should report the remote Bedrock server as offline'
  );

  if (process.platform === 'win32') {
    const zipPath = path.join(testRoot, 'win-extract.zip');
    fs.writeFileSync(zipPath, zipStore({ 'hello.txt': 'unzip-ok' }));
    const destDir = path.join(testRoot, 'win-extract');
    await platform.unzipArchive(zipPath, destDir);
    assert.equal(
      fs.readFileSync(path.join(destDir, 'hello.txt'), 'utf8'),
      'unzip-ok'
    );
    const listed = await platform.listZipEntries(zipPath);
    assert.ok(listed.some((name) => name.endsWith('hello.txt')));
  }

  assert.equal(
    await serverManager.isUdpPortAvailable(blockedPort),
    true,
    'a released UDP port was incorrectly reported as unavailable'
  );

  const serverPath = path.join(testRoot, 'server');
  fs.mkdirSync(serverPath, { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'allowlist.json'), '[]\n');
  fs.writeFileSync(path.join(serverPath, 'permissions.json'), '[]\n');

  const suffix = Date.now();
  const server = db.prepare(`
    INSERT INTO servers (name, version, port, data_path)
    VALUES (?, 'test', ?, ?)
  `).run(`smoke-${suffix}`, 40000 + (suffix % 10000), serverPath);
  const player = db.prepare(
    'INSERT INTO players (username, xuid) VALUES (?, ?)'
  ).run(`SmokePlayer${suffix}`, String(suffix));

  serverManager.updatePlayerAccess(server.lastInsertRowid, player.lastInsertRowid, {
    isWhitelisted: true,
    permission: 'operator',
  });
  const allowlist = JSON.parse(fs.readFileSync(path.join(serverPath, 'allowlist.json'), 'utf8'));
  const permissions = JSON.parse(fs.readFileSync(path.join(serverPath, 'permissions.json'), 'utf8'));
  assert.equal(allowlist.length, 1, 'allowlist.json was not synchronized');
  assert.equal(permissions[0].permission, 'operator', 'permissions.json was not synchronized');

  serverManager.updatePlayerAccess(server.lastInsertRowid, player.lastInsertRowid, {
    isBanned: true,
    banReason: 'Smoke test',
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(serverPath, 'allowlist.json'), 'utf8')).length, 0);

  serverManager.updatePlayerAccess(server.lastInsertRowid, player.lastInsertRowid, { isBanned: false });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(serverPath, 'allowlist.json'), 'utf8')).length,
    0,
    'unban must not restore the allow list'
  );

  const allowOnly = db.prepare('INSERT INTO players (username, xuid) VALUES (?, ?)').run(
    `SmokeAllow${suffix}`,
    `a${suffix}`
  );
  serverManager.updatePlayerAccess(server.lastInsertRowid, allowOnly.lastInsertRowid, { isWhitelisted: true });
  assert(
    !JSON.parse(fs.readFileSync(path.join(serverPath, 'permissions.json'), 'utf8'))
      .some((row) => String(row.xuid) === `a${suffix}`),
    'allow-list-only players should not be written to permissions.json'
  );
  assert.equal(
    serverManager.listPlayerSummaries().find((row) => row.id === allowOnly.lastInsertRowid).whitelist_count,
    1,
    'whitelist_count should be 1 for a player on one server'
  );

  const permOnly = db.prepare('INSERT INTO players (username, xuid) VALUES (?, ?)').run(
    `SmokePerm${suffix}`,
    `p${suffix}`
  );
  serverManager.updatePlayerAccess(server.lastInsertRowid, permOnly.lastInsertRowid, {
    permission: 'operator',
    hasCustomPermission: true,
  });
  assert(
    !JSON.parse(fs.readFileSync(path.join(serverPath, 'allowlist.json'), 'utf8'))
      .some((row) => row.name === `SmokePerm${suffix}`),
    'custom permission must not add the player to the allow list'
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(serverPath, 'permissions.json'), 'utf8'))
      .find((row) => String(row.xuid) === `p${suffix}`)?.permission,
    'operator',
    'custom permission was not written to permissions.json'
  );

  serverManager.updatePlayerAccess(server.lastInsertRowid, permOnly.lastInsertRowid, {
    permission: 'visitor',
  });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(serverPath, 'permissions.json'), 'utf8'))
      .find((row) => String(row.xuid) === `p${suffix}`)?.permission,
    'visitor',
    'permission changes must stay in sync in permissions.json'
  );

  const server2Path = path.join(testRoot, 'server2');
  fs.mkdirSync(server2Path, { recursive: true });
  fs.writeFileSync(path.join(server2Path, 'allowlist.json'), '[]\n');
  fs.writeFileSync(path.join(server2Path, 'permissions.json'), '[]\n');
  const server2 = db.prepare(`
    INSERT INTO servers (name, version, port, data_path) VALUES (?, 'test', ?, ?)
  `).run(`smoke2-${suffix}`, 41000 + (suffix % 10000), server2Path);

  serverManager.setPlayerBannedEverywhere(allowOnly.lastInsertRowid, true, 'Smoke global ban');
  assert.equal(
    db.prepare('SELECT is_banned FROM players WHERE id = ?').get(allowOnly.lastInsertRowid).is_banned,
    1,
    'global ban flag was not set'
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(serverPath, 'allowlist.json'), 'utf8'))
      .some((row) => row.name === `SmokeAllow${suffix}`),
    false,
    'global ban must remove the player from existing allow lists'
  );
  assert.equal(
    db.prepare(
      'SELECT is_banned FROM server_player_access WHERE server_id = ? AND player_id = ?'
    ).get(server.lastInsertRowid, allowOnly.lastInsertRowid).is_banned,
    1
  );
  assert.equal(
    db.prepare(
      'SELECT is_banned FROM server_player_access WHERE server_id = ? AND player_id = ?'
    ).get(server2.lastInsertRowid, allowOnly.lastInsertRowid).is_banned,
    1,
    'global ban must be applied to every game server'
  );

  const server3Path = path.join(testRoot, 'server3');
  fs.mkdirSync(server3Path, { recursive: true });
  fs.writeFileSync(path.join(server3Path, 'allowlist.json'), '[]\n');
  fs.writeFileSync(path.join(server3Path, 'permissions.json'), '[]\n');
  const server3 = db.prepare(`
    INSERT INTO servers (name, version, port, data_path) VALUES (?, 'test', ?, ?)
  `).run(`smoke3-${suffix}`, 42000 + (suffix % 10000), server3Path);
  serverManager.applyGlobalBansToServer(server3.lastInsertRowid);
  assert.equal(
    db.prepare(
      'SELECT is_banned FROM server_player_access WHERE server_id = ? AND player_id = ?'
    ).get(server3.lastInsertRowid, allowOnly.lastInsertRowid)?.is_banned,
    1,
    'new servers must inherit global bans'
  );

  serverManager.setPlayerBannedEverywhere(allowOnly.lastInsertRowid, false);
  assert.equal(db.prepare('SELECT is_banned FROM players WHERE id = ?').get(allowOnly.lastInsertRowid).is_banned, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(serverPath, 'allowlist.json'), 'utf8'))
      .some((row) => row.name === `SmokeAllow${suffix}`),
    false,
    'unban must not restore allow lists'
  );
  assert.equal(
    serverManager.listPlayerSummaries().find((row) => row.id === allowOnly.lastInsertRowid).whitelist_count,
    0
  );

  const catalog = process.env.CURSEFORGE_API_KEY
    ? await curseforge.searchMods('', { pageSize: 5, page: 1, sortBy: 'popularity' })
    : curseforge.parseSearchResults(`
      <main><div>1 Projects</div><article>
        <img src="https://media.forgecdn.net/example.png">
        <span>Addons</span>
        <a href="/minecraft-bedrock/addons/smoke-addon"><h3>Smoke Addon</h3></a>
        <span>By</span><a href="/members/test-author">Test Author</a>
        <a href="/minecraft-bedrock/addons/smoke-addon/download/123">Download</a>
        <p>A representative Bedrock addon used to verify catalog parsing.</p>
        <span>9.8M</span>
      </article></main>
    `, 1, 5);
  assert(catalog.results.length > 0, 'CurseForge returned no parsed projects');
  assert(catalog.results.every(item => item.slug && item.projectClass && item.websiteUrl));

  const settingsTable = db.prepare(
    'SELECT name FROM sqlite_master WHERE type = ? AND name = ?'
  ).get('table', 'app_settings');
  assert(settingsTable, 'app_settings table was not created');
  settingsStore.set(settingsStore.KEYS.GIT_URL, 'https://gitlab.example.com/group/bedrock-mod-catalog.git');
  settingsStore.set(settingsStore.KEYS.GIT_ENABLED, '1');
  assert.equal(settingsStore.getGitConfig().url, 'https://gitlab.example.com/group/bedrock-mod-catalog.git');
  assert.equal(settingsStore.getGitConfig().enabled, true);

  const gitRoot = path.join(testRoot, 'git-catalog');
  fs.mkdirSync(path.join(gitRoot, 'addons', 'smoke-pack'), { recursive: true });
  fs.mkdirSync(path.join(gitRoot, 'maps'), { recursive: true });
  fs.writeFileSync(path.join(gitRoot, 'addons', 'indexed-pack.mcaddon'), 'pack');
  fs.writeFileSync(path.join(gitRoot, 'catalog.json'), JSON.stringify({
    version: 1,
    mods: [{
      name: 'Indexed Pack',
      slug: 'indexed-pack',
      type: 'addon',
      description: 'From catalog.json',
      author: 'Docs',
      categories: ['survival'],
      file: 'addons/indexed-pack.mcaddon',
    }],
  }));
  fs.writeFileSync(path.join(gitRoot, 'addons', 'smoke-pack', 'mod.json'), JSON.stringify({
    name: 'Smoke Pack',
    type: 'addon',
    description: 'Folder metadata for a utility pack',
    author: 'Tester',
    categories: ['utility'],
  }));
  fs.writeFileSync(path.join(gitRoot, 'addons', 'smoke-pack', 'smoke-pack.mcaddon'), 'pack');
  fs.writeFileSync(path.join(gitRoot, 'maps', 'demo-world.mcworld'), 'world');

  const oceanDir = path.join(gitRoot, 'addons', 'oceanic-delight');
  fs.mkdirSync(oceanDir, { recursive: true });
  fs.writeFileSync(path.join(oceanDir, 'mod.json'), JSON.stringify({
    name: 'Oceanic Delight',
    type: 'addon',
    description: 'From mod.json',
    author: 'Pack Author',
    categories: ['survival'],
  }));
  fs.writeFileSync(path.join(oceanDir, 'Oceanic Delight V5.0.4 1.26.0+.mcaddon'), 'pack');
  fs.writeFileSync(path.join(oceanDir, 'thumbnail.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const gitMods = gitCatalog.parseCatalogFromDir(gitRoot);
  assert(gitMods.some(mod => mod.slug === 'indexed-pack'), 'catalog.json entry was not parsed');
  assert(gitMods.some(mod => mod.slug === 'smoke-pack'), 'mod.json entry was not parsed');
  assert(gitMods.some(mod => mod.slug === 'demo-world' && mod.type === 'world'), 'map pack was not discovered');
  const oceanEntries = gitMods.filter(mod => /oceanic/i.test(`${mod.name} ${mod.slug}`));
  assert.equal(oceanEntries.length, 1, `expected one Oceanic Delight entry, got ${oceanEntries.map(mod => mod.name).join(', ')}`);
  assert.equal(oceanEntries[0].name, 'Oceanic Delight');
  assert(oceanEntries[0].thumbnailPath, 'mod.json folder thumbnail.png was not attached');
  assert(oceanEntries[0].thumbnail.includes('/api/mods/catalog/git/thumbnail/'), 'thumbnail URL was not set');
  assert(gitMods.filter(mod => gitCatalog.matchesQuery(mod, 'smoke')).length >= 1, 'Git catalog search did not match');
  assert(
    gitMods.filter(mod => gitCatalog.matchesCategory(mod, 'survival')).some(mod => mod.slug === 'indexed-pack'),
    'Git catalog category filter did not match'
  );
  const sorted = gitCatalog.sortMods(gitMods, 'relevancy', 'smoke');
  assert.equal(sorted[0].slug, 'smoke-pack', 'Git catalog relevancy sort did not prefer the query match');

  const pointerDir = path.join(gitRoot, 'addons', 'lfs-pack');
  fs.mkdirSync(pointerDir, { recursive: true });
  fs.writeFileSync(path.join(pointerDir, 'mod.json'), JSON.stringify({
    name: 'LFS Pack',
    type: 'addon',
  }));
  fs.writeFileSync(path.join(pointerDir, 'lfs-pack.mcaddon'), 'pack');
  const pointerThumb = path.join(pointerDir, 'thumbnail.png');
  fs.writeFileSync(pointerThumb, [
    'version https://git-lfs.github.com/spec/v1',
    'oid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'size 177000',
    '',
  ].join('\n'));
  assert(gitCatalog.isGitLfsPointer(pointerThumb), 'Git LFS pointer file was not detected');
  const lfsEntry = gitCatalog.parseCatalogFromDir(gitRoot).find(mod => mod.slug === 'lfs-pack');
  assert(lfsEntry, 'LFS pack folder was not parsed');
  assert(!lfsEntry.thumbnailPath, 'LFS pointer thumbnail should be ignored until the real file is pulled');

  const previousGitToken = process.env.GIT_CATALOG_TOKEN;
  delete process.env.GIT_CATALOG_TOKEN;
  settingsStore.remove(settingsStore.KEYS.GIT_TOKEN);
  try {
    const catalogSettings = catalogService.getSettings();
    assert.equal(typeof catalogSettings.git.sync.running, 'boolean', 'catalog settings should include git sync status');
    assert.equal(gitCatalog.isConfigured(), true, 'git catalog should be configured after saving URL and enabled');
    assert.equal(gitCatalog.canSync(), false, 'sync should require a saved token, not only enabled+URL');
    assert.equal(catalogSettings.git.sync.canSync, false, 'settings payload should hide Sync Now without a token');
    assert.equal(gitCatalog.getSyncStatus().running, false);

    settingsStore.set(settingsStore.KEYS.GIT_TOKEN, 'smoke-token');
    assert.equal(gitCatalog.canSync(), true, 'sync should be allowed after a token is saved');
    settingsStore.remove(settingsStore.KEYS.GIT_TOKEN);
    assert.equal(gitCatalog.canSync(), false, 'removing the saved token should disable sync');
  } finally {
    if (previousGitToken == null) delete process.env.GIT_CATALOG_TOKEN;
    else process.env.GIT_CATALOG_TOKEN = previousGitToken;
    settingsStore.remove(settingsStore.KEYS.GIT_TOKEN);
  }

  const originalConfigured = gitCatalog.isConfigured.bind(gitCatalog);
  const originalSync = gitCatalog.sync.bind(gitCatalog);
  let syncStarts = 0;
  gitCatalog.isConfigured = () => true;
  gitCatalog.sync = async () => {
    syncStarts += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { success: true, lastSync: new Date().toISOString(), modCount: 3 };
  };
  try {
    const first = gitCatalog.startSync('overlap-a');
    const second = gitCatalog.startSync('overlap-b');
    assert.equal(first, second, 'overlapping syncs should share one in-flight job');
    assert.equal(gitCatalog.getSyncStatus().running, true, 'sync status should show running');
    const result = await first;
    assert.equal(syncStarts, 1, 'in-flight sync should not start a second git job');
    assert.equal(result.modCount, 3);
    assert.equal(gitCatalog.getSyncStatus().running, false, 'sync status should clear after completion');
  } finally {
    gitCatalog.isConfigured = originalConfigured;
    gitCatalog.sync = originalSync;
  }

  if (spawnSync('bash', ['-c', 'true']).status === 0) {
    const upgradeScript = path.join(__dirname, 'upgrade.sh');
    const runUpgrade = (args) => spawnSync('bash', [upgradeScript, ...args], {
      encoding: 'utf8',
      timeout: 8000,
    });
    const assertUpgradeRejects = (args, pattern) => {
      const result = runUpgrade(args);
      const output = `${result.stderr || ''}${result.stdout || ''}`;
      assert.notEqual(result.status, 0, `upgrade.sh ${args.join(' ')} should fail`);
      assert.match(output, pattern, output);
    };
    assert.equal(runUpgrade(['--help']).status, 0, 'upgrade.sh --help should succeed');
    assert.match(runUpgrade(['--help']).stdout, /--no-backup/, 'upgrade.sh --help should document --no-backup');
    assertUpgradeRejects(['--branch'], /requires a value/);
    assertUpgradeRejects(['--branch', '--all'], /must not start with a dash/);
    assertUpgradeRejects(['--branch', 'HEAD'], /not a valid branch name/);
    assertUpgradeRejects(['--branch', 'refs/heads/main'], /not a raw refs\/ path/);
    assertUpgradeRejects(['--branch', 'feat/foo;rm'], /invalid characters/);
    assertUpgradeRejects(['--tag', 'v0.2.0^{}'], /invalid characters/);
    assertUpgradeRejects(['--branch', 'release/0.2.1', '--tag', 'v0.2.0'], /not both/);
  }

  const denied = gitCatalog.friendlyGitError(new Error('remote: You are not allowed to download code.\nfatal: The requested URL returned error: 403'));
  assert.match(denied, /read_repository/, 'GitLab download denial should mention the required token scope');

  const previousConnectHost = process.env.CONNECT_HOST;
  assert.equal(connectHost.stripHostPort('192.168.1.50:3000'), '192.168.1.50');
  assert.equal(connectHost.formatAddress('192.168.1.50', 19132), '192.168.1.50:19132');
  assert.equal(connectHost.formatAddress('2001:db8::1', 19132), '[2001:db8::1]:19132');
  assert(connectHost.managerHostname(), 'manager hostname should be the OS hostname');
  process.env.CONNECT_HOST = '10.9.9.9';
  try {
    assert.equal(connectHost.resolve({ headers: { host: 'mc.example.com:3000' } }), '10.9.9.9');
  } finally {
    if (previousConnectHost == null) delete process.env.CONNECT_HOST;
    else process.env.CONNECT_HOST = previousConnectHost;
  }
  process.env.CONNECT_HOST = 'mc.example.com';
  try {
    const resolved = connectHost.resolve({ headers: { host: '10.0.0.8:3000' } });
    assert.match(resolved, /^(?:\d{1,3}\.){3}\d{1,3}$/, 'connect address should be an IPv4, not a hostname');
    assert.notEqual(resolved, 'mc.example.com');
  } finally {
    if (previousConnectHost == null) delete process.env.CONNECT_HOST;
    else process.env.CONNECT_HOST = previousConnectHost;
  }
  const localConnectHost = connectHost.resolve({ headers: { host: 'localhost:3000' } });
  assert.match(localConnectHost, /^(?:\d{1,3}\.){3}\d{1,3}$/, 'localhost requests should still advertise an IPv4');
  assert.equal(
    connectHost.isPhantomProxied({ lan: { enabled: true, active: true, native: false } }),
    true
  );
  assert.equal(
    connectHost.isPhantomProxied({ lan: { enabled: true, active: false, native: false } }),
    false
  );
  assert.equal(
    connectHost.attach({ port: 19140, lan: { enabled: true, active: true, native: false } }, { headers: { host: '10.0.0.8:3000' } }).connectAddress.endsWith(':19140'),
    true
  );

  const packPath = path.join(testRoot, 'library-mod.mcaddon');
  fs.writeFileSync(packPath, 'pack');
  const libraryMod = db.prepare(`
    INSERT INTO mods (name, slug, type, description, file_path, source)
    VALUES (?, ?, 'addon', '', ?, 'upload')
  `).run('Library Edit', `library-edit-${suffix}`, packPath);
  const updatedMod = await modManager.updateMod(libraryMod.lastInsertRowid, { description: 'Added after upload' });
  assert.equal(updatedMod.description, 'Added after upload');

  const promptErr = gitCatalog.friendlyGitError(new Error("fatal: could not read Username for 'https://sci-gitlab-01.sciamfam.com': terminal prompts disabled"));
  assert.match(promptErr, /access token/i);

  const bpManifest = {
    format_version: 2,
    header: { name: 'Smoke BP', uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', version: [1, 0, 0] },
    modules: [{ type: 'data', uuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', version: [1, 0, 0] }],
  };
  const rpManifest = {
    format_version: 2,
    header: { name: 'Smoke RP', uuid: 'cccccccc-cccc-cccc-cccc-cccccccccccc', version: [1, 0, 0] },
    modules: [{ type: 'resources', uuid: 'dddddddd-dddd-dddd-dddd-dddddddddddd', version: [1, 0, 0] }],
  };
  const unpacked = path.join(testRoot, 'unpacked-addon');
  fs.mkdirSync(path.join(unpacked, 'BP'), { recursive: true });
  fs.mkdirSync(path.join(unpacked, 'RP'), { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'BP', 'manifest.json'), JSON.stringify(bpManifest));
  fs.writeFileSync(path.join(unpacked, 'RP', 'manifest.json'), JSON.stringify(rpManifest));
  const discovered = packInstaller.findManifestPacks(unpacked);
  assert.equal(discovered.length, 2, 'addon folders with BP and RP manifests should be discovered');
  assert.equal(packInstaller.packTypeFromManifest(bpManifest), 'data');
  assert.equal(packInstaller.packTypeFromManifest(rpManifest), 'resources');

  const addonZip = path.join(testRoot, 'smoke-addon.mcaddon');
  fs.writeFileSync(addonZip, zipStore({
    'BP/manifest.json': JSON.stringify(bpManifest),
    'RP/manifest.json': JSON.stringify(rpManifest),
  }));
  const packServerPath = path.join(testRoot, 'pack-server');
  fs.mkdirSync(path.join(packServerPath, 'behavior_packs'), { recursive: true });
  fs.mkdirSync(path.join(packServerPath, 'resource_packs'), { recursive: true });
  fs.writeFileSync(path.join(packServerPath, 'server.properties'), 'level-name=Bedrock level\n');
  fs.writeFileSync(path.join(packServerPath, 'behavior_packs', 'smoke-addon.mcaddon'), 'stale-archive');
  const packServer = db.prepare(`
    INSERT INTO servers (name, version, port, data_path)
    VALUES (?, 'test', ?, ?)
  `).run(`packs-${suffix}`, 40200, packServerPath);
  const packMod = db.prepare(`
    INSERT INTO mods (name, slug, type, description, file_path, source)
    VALUES (?, ?, 'addon', '', ?, 'upload')
  `).run('Smoke Addon', `smoke-addon-${suffix}`, addonZip);
  await modManager.installModToServer(packServer.lastInsertRowid, packMod.lastInsertRowid);
  const installedByServer = modManager.getInstalledModIdsByServer();
  assert(
    (installedByServer[String(packServer.lastInsertRowid)] || []).includes(packMod.lastInsertRowid),
    'installedModIds should include the pack just installed'
  );
  const placedBp = path.join(packServerPath, 'behavior_packs', `addon_${packMod.lastInsertRowid}_aaaaaaaa`);
  const placedRp = path.join(packServerPath, 'resource_packs', `addon_${packMod.lastInsertRowid}_cccccccc`);
  assert(fs.existsSync(path.join(placedBp, 'manifest.json')), 'behavior pack was not extracted');
  assert(fs.existsSync(path.join(placedRp, 'manifest.json')), 'resource pack was not extracted');
  assert.equal(fs.existsSync(path.join(packServerPath, 'behavior_packs', 'smoke-addon.mcaddon')), false);
  const worldBp = JSON.parse(fs.readFileSync(path.join(packServerPath, 'worlds', 'Bedrock level', 'world_behavior_packs.json'), 'utf8'));
  const worldRp = JSON.parse(fs.readFileSync(path.join(packServerPath, 'worlds', 'Bedrock level', 'world_resource_packs.json'), 'utf8'));
  assert.equal(worldBp[0].pack_id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.equal(worldRp[0].pack_id, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  await modManager.uninstallModFromServer(packServer.lastInsertRowid, packMod.lastInsertRowid);
  assert.equal(fs.existsSync(placedBp), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(packServerPath, 'worlds', 'Bedrock level', 'world_behavior_packs.json'), 'utf8')).length, 0);

  const worldZip = path.join(testRoot, 'smoke-map.mcworld');
  fs.writeFileSync(worldZip, zipStore({
    'level.dat': 'dummy-level',
    'levelname.txt': 'Smoke Map\n',
    'db/placeholder': 'x',
  }));
  fs.writeFileSync(path.join(packServerPath, 'worlds', 'smoke-map.mcworld'), 'stale-world');
  const worldMod = db.prepare(`
    INSERT INTO mods (name, slug, type, description, file_path, source)
    VALUES (?, ?, 'world', '', ?, 'upload')
  `).run('Smoke Map', `smoke-map-${suffix}`, worldZip);
  await modManager.installModToServer(packServer.lastInsertRowid, worldMod.lastInsertRowid);
  const importedWorld = path.join(packServerPath, 'worlds', 'Smoke Map');
  assert(fs.existsSync(path.join(importedWorld, 'level.dat')), 'mcworld was not extracted as a world folder');
  assert.equal(fs.existsSync(path.join(packServerPath, 'worlds', 'smoke-map.mcworld')), false);
  assert.match(fs.readFileSync(path.join(packServerPath, 'server.properties'), 'utf8'), /^level-name=Smoke Map$/m);
  await modManager.uninstallModFromServer(packServer.lastInsertRowid, worldMod.lastInsertRowid);
  assert.equal(fs.existsSync(importedWorld), false, 'imported world folder was not removed');
  assert.match(fs.readFileSync(path.join(packServerPath, 'server.properties'), 'utf8'), /^level-name=Bedrock level$/m);
  assert(fs.existsSync(path.join(packServerPath, 'worlds', 'Bedrock level')), 'original world should stay after map uninstall');

  const zipAddon = path.join(testRoot, 'smoke-addon.zip');
  fs.writeFileSync(zipAddon, zipStore({
    'BP/manifest.json': JSON.stringify(bpManifest),
    'RP/manifest.json': JSON.stringify(rpManifest),
  }));
  const zipMod = db.prepare(`
    INSERT INTO mods (name, slug, type, description, file_path, source)
    VALUES (?, ?, 'addon', '', ?, 'upload')
  `).run('Smoke Zip Addon', `smoke-zip-${suffix}`, zipAddon);
  await modManager.installModToServer(packServer.lastInsertRowid, zipMod.lastInsertRowid);
  const zipBp = path.join(packServerPath, 'behavior_packs', `addon_${zipMod.lastInsertRowid}_aaaaaaaa`);
  assert(fs.existsSync(path.join(zipBp, 'manifest.json')), '.zip addon was not extracted');
  await modManager.uninstallModFromServer(packServer.lastInsertRowid, zipMod.lastInsertRowid);
  assert.equal(fs.existsSync(zipBp), false);

  const templateZip = path.join(testRoot, 'smoke.mctemplate');
  fs.writeFileSync(templateZip, zipStore({
    'level.dat': 'dummy-level',
    'levelname.txt': 'Smoke Template\n',
  }));
  const templateMod = db.prepare(`
    INSERT INTO mods (name, slug, type, description, file_path, source)
    VALUES (?, ?, 'template', '', ?, 'upload')
  `).run('Smoke Template', `smoke-template-${suffix}`, templateZip);
  await modManager.installModToServer(packServer.lastInsertRowid, templateMod.lastInsertRowid);
  const templateWorld = path.join(packServerPath, 'worlds', 'Smoke Template');
  assert(fs.existsSync(path.join(templateWorld, 'level.dat')), '.mctemplate was not extracted as a world');
  assert.match(fs.readFileSync(path.join(packServerPath, 'server.properties'), 'utf8'), /^level-name=Smoke Template$/m);
  await modManager.uninstallModFromServer(packServer.lastInsertRowid, templateMod.lastInsertRowid);
  assert.equal(fs.existsSync(templateWorld), false);
  assert.match(fs.readFileSync(path.join(packServerPath, 'server.properties'), 'utf8'), /^level-name=Bedrock level$/m);

  const structurePath = path.join(testRoot, 'house.mcstructure');
  fs.writeFileSync(structurePath, 'structure-bytes');
  const structureMod = db.prepare(`
    INSERT INTO mods (name, slug, type, description, file_path, source)
    VALUES (?, ?, 'structure', '', ?, 'upload')
  `).run('Smoke Structure', `smoke-structure-${suffix}`, structurePath);
  await modManager.installModToServer(packServer.lastInsertRowid, structureMod.lastInsertRowid);
  const structureDest = path.join(packServerPath, 'worlds', 'Bedrock level', 'structures', 'house.mcstructure');
  assert(fs.existsSync(structureDest), '.mcstructure was not copied into the world structures folder');
  await modManager.uninstallModFromServer(packServer.lastInsertRowid, structureMod.lastInsertRowid);
  assert.equal(fs.existsSync(structureDest), false);

  assert.equal(
    packInstaller.pickPackIconPath(['BP/pack_icon.png', 'RP/pack_icon.jpeg']),
    'BP/pack_icon.png'
  );
  assert.equal(
    packInstaller.pickPackIconPath(['deep/nested/pack_icon.png', 'pack_icon.jpg']),
    'pack_icon.jpg'
  );
  assert.equal(
    packInstaller.pickPackIconPath(['__MACOSX/pack_icon.png', 'RP/textures/pack_icon.webp']),
    'RP/textures/pack_icon.webp'
  );
  assert(packInstaller.isIncompleteArchiveError(
    'pack_icon.png bad CRC c7fed3c8 (should be d32d4633) file #492: bad zipfile offset (local header sig): 3910879'
  ));
  const encodingWarning = 'halocraftb/animation_controllers/pu#U00f1etazo.json: mismatching "local" filename (halocraftb/animation_controllers/pu+etazo.json), continuing with "central" filename version';
  assert.equal(packInstaller.isIncompleteArchiveError(encodingWarning), false);
  assert(packInstaller.isFilenameEncodingWarning(encodingWarning));
  assert.match(
    packInstaller.friendlyExtractError('Ranzie_Rise_and_Survive_1.2.mcaddon', {
      stderr: 'pack_icon.png bad CRC c7fed3c8 file #492: bad zipfile offset',
    }),
    /incomplete or corrupted/i
  );
  assert.match(
    packInstaller.friendlyExtractError('truncated.mcaddon', {
      code: 9,
      message: 'Command failed: unzip -t -qq truncated.mcaddon',
    }),
    /incomplete or corrupted/i
  );

  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const iconZip = path.join(testRoot, 'icon-addon.mcaddon');
  fs.writeFileSync(iconZip, zipStore({
    'BP/manifest.json': JSON.stringify(bpManifest),
    'BP/pack_icon.png': tinyPng,
    'RP/manifest.json': JSON.stringify(rpManifest),
    'RP/pack_icon.png': tinyPng,
  }));
  const extractedIcon = await packInstaller.extractPackIconFromArchive(iconZip, testRoot, 'smoke-icon');
  assert(extractedIcon, 'pack_icon.png should be extracted from the addon');
  assert.equal(path.extname(extractedIcon), '.png');
  assert(fs.existsSync(extractedIcon));
  assert.equal(fs.readFileSync(extractedIcon).compare(tinyPng), 0);

  const nestedInner = zipStore({
    'manifest.json': JSON.stringify(rpManifest),
    'pack_icon.png': tinyPng,
  });
  const nestedOuter = path.join(testRoot, 'nested-icon.mcaddon');
  fs.writeFileSync(nestedOuter, zipStore({ 'RP.mcpack': nestedInner }));
  const nestedIcon = await packInstaller.extractPackIconFromArchive(nestedOuter, testRoot, 'nested-icon');
  assert(nestedIcon, 'pack_icon inside a nested mcpack should be used');
  assert.equal(fs.readFileSync(nestedIcon).compare(tinyPng), 0);

  const truncatedZip = path.join(testRoot, 'truncated.mcaddon');
  const completeZip = zipStore({ 'BP/manifest.json': JSON.stringify(bpManifest) });
  fs.writeFileSync(truncatedZip, completeZip.subarray(0, Math.max(32, Math.floor(completeZip.length / 3))));
  await assert.rejects(
    () => packInstaller.verifyArchive(truncatedZip),
    /incomplete or corrupted/i
  );

  const bedrockConnect = require('../server/services/bedrockConnect');
  assert.equal(bedrockConnect.bundledVersion(), '1.68.0');
  assert(
    fs.existsSync(path.join(__dirname, '../vendor/bedrock-connect/BedrockConnect-1.0-SNAPSHOT.jar')),
    'bundled Bedrock Connect JAR is missing'
  );
  const serverColumns = db.prepare('PRAGMA table_info(servers)').all().map(column => column.name);
  assert(serverColumns.includes('kind'), 'servers.kind column was not created');
  assert(serverColumns.includes('pending_port'), 'servers.pending_port column was not created');
  assert(serverColumns.includes('ipv6_port'), 'servers.ipv6_port column was not created');
  assert(serverColumns.includes('pending_ipv6_port'), 'servers.pending_ipv6_port column was not created');
  assert(serverColumns.includes('lan_broadcast'), 'servers.lan_broadcast column was not created');
  assert(serverColumns.includes('lan_proxy_port'), 'servers.lan_proxy_port column was not created');
  assert(serverColumns.includes('remote_host'), 'servers.remote_host column was not created');
  assert(serverColumns.includes('remote_ipv4_port'), 'servers.remote_ipv4_port column was not created');
  assert(serverColumns.includes('remote_ipv6_port'), 'servers.remote_ipv6_port column was not created');
  const portUsageColumns = db.prepare('PRAGMA table_info(port_usage)').all().map(column => column.name);
  assert(portUsageColumns.includes('family'), 'port_usage.family column was not created');
  assert.equal(portRanges.preferredIpv6Port(19140), 18140);
  assert.equal(portRanges.isIpv4GamePort(19133), false);
  assert.equal(portRanges.isIpv6GamePort(18132), true);
  assert.equal(portRanges.classifyFamily(18140), 'ipv6');

  const portServerPath = path.join(testRoot, 'port-server');
  fs.mkdirSync(portServerPath, { recursive: true });
  fs.writeFileSync(path.join(portServerPath, 'server.properties'), 'server-port=19150\nserver-portv6=18150\n');
  const portServer = db.prepare(`
    INSERT INTO servers (name, version, port, ipv6_port, data_path)
    VALUES (?, 'test', ?, ?, ?)
  `).run(`port-change-${suffix}`, 19150, 18150, portServerPath);
  const queued = await serverManager.queuePortChange(portServer.lastInsertRowid, 19151);
  assert.equal(queued.pending, false, 'stopped server port change should apply immediately');
  const moved = serverManager.getServer(portServer.lastInsertRowid);
  assert.equal(moved.port, 19151);
  assert.equal(moved.pending_port, null);
  assert.equal(moved.ipv6_port, 18151, 'paired IPv6 port should move 1000 below the new IPv4 port');
  const props = fs.readFileSync(path.join(portServerPath, 'server.properties'), 'utf8');
  assert.match(props, /server-port=19151/);
  assert.match(props, /server-portv6=18151/);
  assert.match(props, /allow-list=false/);
  const queuedIpv6 = await serverManager.queueIpv6PortChange(portServer.lastInsertRowid, 18152);
  assert.equal(queuedIpv6.pending, false);
  assert.equal(serverManager.getServer(portServer.lastInsertRowid).ipv6_port, 18152);
  await assert.rejects(
    () => serverManager.queuePortChange(portServer.lastInsertRowid, 18152),
    /IPv4 and IPv6 ports must be different/
  );
  await assert.rejects(
    () => serverManager.queuePortChange(portServer.lastInsertRowid, 19133),
    /not in the IPv4 game ranges/
  );

  const occupantPath = path.join(testRoot, 'occupant');
  fs.mkdirSync(occupantPath, { recursive: true });
  const occupant = db.prepare(`
    INSERT INTO servers (name, version, port, data_path)
    VALUES (?, 'test', 19132, ?)
  `).run(`occupant-${suffix}`, occupantPath);
  serverManager.registerPort(occupant.lastInsertRowid, 19132, 'udp');
  const preview = await serverManager.previewBedrockConnect();
  assert.equal(preview.exists, false);
  assert(preview.conflict, 'preview should report a 19132 conflict');
  assert.equal(preview.conflict.serverId, occupant.lastInsertRowid);
  assert.notEqual(preview.conflict.nextPort, 19132);
  assert.notEqual(preview.conflict.nextPort, 19133);

  const nativeLan = await serverManager.previewLanBroadcast(occupant.lastInsertRowid);
  assert.equal(nativeLan.allowed, true);
  assert.equal(nativeLan.native, true);
  const nativeEnabled = await serverManager.setLanBroadcast(occupant.lastInsertRowid, true);
  assert.equal(nativeEnabled.native, true);
  const extraLanPreview = await serverManager.previewLanBroadcast(portServer.lastInsertRowid);
  assert.equal(extraLanPreview.allowed, true);
  assert.equal(extraLanPreview.native, false);
  assert(extraLanPreview.conflict, 'LAN preview should report a 19132 conflict');
  assert.equal(extraLanPreview.conflict.serverId, occupant.lastInsertRowid);

  db.prepare('DELETE FROM servers WHERE id = ?').run(occupant.lastInsertRowid);
  const bcPath = path.join(testRoot, 'bedrock-connect');
  fs.mkdirSync(bcPath, { recursive: true });
  const bc = db.prepare(`
    INSERT INTO servers (name, version, port, data_path, kind)
    VALUES (?, 'test-jar', 19132, ?, 'bedrock_connect')
  `).run('Bedrock Connect', bcPath);
  const alpha = db.prepare(`
    INSERT INTO servers (name, version, port, data_path)
    VALUES (?, 'test', ?, ?)
  `).run(`aaa-${suffix}`, 40120, path.join(testRoot, 'alpha'));
  const ordered = serverManager.getAllServers();
  assert.equal(ordered[0].id, bc.lastInsertRowid, 'Bedrock Connect tile should sort first');
  assert(ordered.some(row => row.id === alpha.lastInsertRowid));
  const ports = await serverManager.getAllPorts();
  assert(ports.used.some(item => item.port === 19132), '19132 should be marked used while Bedrock Connect exists');
  assert(ports.used.some(item => item.port === 19133 && item.family === 'ipv6'), '19133 should be reserved as IPv6 discovery');
  assert(!ports.available.some(item => item.port === 19133), '19133 must not be offered as an available game port');
  assert(!ports.available.some(item => item.family !== 'ipv6' && item.port === 19133));
  const nextIpv4 = await serverManager.nextAvailablePort();
  assert.notEqual(nextIpv4, 19133);
  assert(portRanges.isIpv4GamePort(nextIpv4), 'next available port should be an IPv4 game port');
  await assert.rejects(
    () => serverManager.createServer({ name: `blocked-${suffix}`, port: 19132, version: 'latest' }),
    /19132 is reserved/
  );
  await assert.rejects(
    () => serverManager.createServer({ name: `v6asv4-${suffix}`, port: 19133, version: 'latest' }),
    /not in the IPv4 game ranges/
  );
  const lanWhileBcStopped = await serverManager.previewLanBroadcast(alpha.lastInsertRowid);
  assert.equal(lanWhileBcStopped.allowed, true, 'LAN listing should work while Bedrock Connect is stopped');
  db.prepare("UPDATE servers SET status = 'running' WHERE id = ?").run(bc.lastInsertRowid);
  serverManager.invalidateServerCache(bc.lastInsertRowid);
  const blockedLan = await serverManager.previewLanBroadcast(alpha.lastInsertRowid);
  assert.equal(blockedLan.allowed, false);

  const bedrockConnectList = require('../server/services/bedrockConnectList');
  const listResult = bedrockConnectList.writeList();
  assert.equal(listResult.written, true);
  const listed = JSON.parse(fs.readFileSync(listResult.path, 'utf8'));
  assert(listed.some((item) => item.name === `aaa-${suffix}` && item.port === 40120));
  assert(!listed.some((item) => item.name === 'Bedrock Connect'));
  assert(bedrockConnectList.spawnArgs(bcPath).includes('featured_servers=false'));
  assert(bedrockConnectList.spawnArgs(bcPath).some((arg) => arg.startsWith('custom_servers=')));
  await assert.rejects(
    () => serverManager.setLanBroadcast(bc.lastInsertRowid, true),
    /cannot be advertised/
  );

  const playerPresence = require('../server/services/playerPresence');
  const listOutput = [
    '\u001b[0mThere are 2/10 players online:',
    'SneezyPuma42904, TestPlayer',
    '[2026-08-16 03:22:00:123 INFO] Server started.',
  ].join('\n');
  assert.deepEqual(playerPresence.parseListOutput(listOutput), ['SneezyPuma42904', 'TestPlayer']);
  assert.deepEqual(playerPresence.parseListOutput('There are 0/10 players online:'), []);
  const joinEvents = playerPresence.parsePresenceEvents(
    'Player connected: SneezyPuma42904, xuid: 2533274790000000\nPlayer Spawned: SneezyPuma42904 xuid: 2533274790000000'
  );
  assert.equal(joinEvents.length, 2);
  assert.equal(joinEvents[0].username, 'SneezyPuma42904');
  assert.equal(joinEvents[0].xuid, '2533274790000000');
  assert.equal(
    playerPresence.stripAnsi('\u001b[38;5;15mlist\u001b[m\n\u001b[38;5;15m[2026-08-18 14:03:00:897 INFO] Player Spawned: SneezyPuma42904\u001b[m'),
    'list\n[2026-08-18 14:03:00:897 INFO] Player Spawned: SneezyPuma42904'
  );
  assert.equal(serverManager.calculateUptime('2099-01-01 00:00:00'), '0m');
  assert.match(serverManager.calculateUptime('2000-01-01 00:00:00'), /\d/);
  const leaveEvents = playerPresence.parsePresenceEvents(
    'Player disconnected: SneezyPuma42904, xuid: 2533274790000000, Pfid: abc'
  );
  assert.equal(leaveEvents[0].type, 'leave');
  const inferred = playerPresence.inferOnlineFromBuffer([
    'Player connected: Alpha, xuid: 1',
    'Player connected: Beta, xuid: 2',
    'Player disconnected: Alpha, xuid: 1',
  ].join('\n'));
  assert.deepEqual(inferred.map((event) => event.username), ['Beta']);

  const created = serverManager.ensurePlayer('SmokeNewPlayer');
  assert.equal(created.created, true);
  const again = serverManager.ensurePlayer('smokenewplayer');
  assert.equal(again.created, false);
  assert.equal(again.id, created.id);
  serverManager.markPlayerOnline(server.lastInsertRowid, created.id);
  assert.equal(serverManager.readOnlinePlayers(server.lastInsertRowid).length, 1);
  serverManager.setExactOnlinePlayers(server.lastInsertRowid, []);
  assert.equal(serverManager.readOnlinePlayers(server.lastInsertRowid).length, 0);

  const dnsPacket = require('../server/services/dnsPacket');
  const dnsSettings = require('../server/services/dnsSettings');
  const { DnsProxy } = require('../server/services/dnsProxy');

  function encodeDnsName(name) {
    const chunks = String(name).split('.').filter(Boolean).map((label) => {
      const body = Buffer.from(label);
      return Buffer.concat([Buffer.from([body.length]), body]);
    });
    return Buffer.concat([...chunks, Buffer.from([0])]);
  }

  function buildDnsQuery(name, type = 1) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x1234, 0);
    header.writeUInt16BE(0x0100, 2);
    header.writeUInt16BE(1, 4);
    const question = Buffer.alloc(4);
    question.writeUInt16BE(type, 0);
    question.writeUInt16BE(1, 2);
    return Buffer.concat([header, encodeDnsName(name), question]);
  }

  const query = buildDnsQuery('geo.hivebedrock.network');
  const parsedQuery = dnsPacket.parseQuery(query);
  assert.equal(parsedQuery.name, 'geo.hivebedrock.network');
  const aResponse = dnsPacket.buildAResponse(query, parsedQuery, '10.0.1.142');
  assert.equal(aResponse.readUInt16BE(6), 1);
  const answerStart = parsedQuery.questionEnd;
  assert.equal(aResponse.readUInt16BE(answerStart + 2), 1);
  assert.equal(Array.from(aResponse.slice(answerStart + 12, answerStart + 16)).join('.'), '10.0.1.142');

  assert.throws(() => dnsSettings.saveConfig({
    enabled: false,
    upstreams: ['1.1.1.1', '8.8.8.8', '9.9.9.9', '8.8.4.4'],
    overrides: [],
  }), /At most 3/);
  assert.throws(() => dnsSettings.saveConfig({
    enabled: false,
    upstreams: [],
    overrides: Array.from({ length: 21 }, (_, i) => ({ hostname: `s${i}.example.net`, ipv4: '10.0.1.10' })),
  }), /At most 20/);
  dnsSettings.saveConfig({
    enabled: false,
    upstreams: ['1.1.1.1'],
    overrides: [{ hostname: 'geo.hivebedrock.network', ipv4: '10.0.1.142' }],
  });
  assert.equal(dnsSettings.overrideMap().get('geo.hivebedrock.network'), '10.0.1.142');

  const proxy = new DnsProxy();
  const overrideAnswer = await proxy.handleQuery(query);
  assert.equal(Array.from(overrideAnswer.slice(answerStart + 12, answerStart + 16)).join('.'), '10.0.1.142');
  const aaaaAnswer = await proxy.handleQuery(buildDnsQuery('geo.hivebedrock.network', 28));
  assert.equal(aaaaAnswer.readUInt16BE(6), 0);

  const mockDns = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    mockDns.once('error', reject);
    mockDns.bind(0, '127.0.0.1', resolve);
  });
  const mockPort = mockDns.address().port;
  mockDns.on('message', (msg, rinfo) => {
    const parsed = dnsPacket.parseQuery(msg);
    mockDns.send(dnsPacket.buildAResponse(msg, parsed, '9.9.9.9'), rinfo.port, rinfo.address);
  });
  const originalUpstreams = dnsSettings.resolveUpstreams;
  dnsSettings.resolveUpstreams = () => [`127.0.0.1:${mockPort}`];
  const forwarded = await proxy.handleQuery(buildDnsQuery('example.com'));
  dnsSettings.resolveUpstreams = originalUpstreams;
  await new Promise((resolve) => mockDns.close(resolve));
  const forwardedParsed = dnsPacket.parseQuery(forwarded);
  const forwardedStart = forwardedParsed.questionEnd;
  assert.equal(Array.from(forwarded.slice(forwardedStart + 12, forwardedStart + 16)).join('.'), '9.9.9.9');

  assert.equal(
    curseforgeImporter.isValidCurseforgeUrl('https://www.curseforge.com/minecraft-bedrock/addons/pickup-carry-cf'),
    true
  );
  assert.equal(curseforgeImporter.isValidCurseforgeUrl('https://www.curseforge.com/minecraft-java/mc-mods/jei'), false);
  assert.equal(curseforgeImporter.isValidCurseforgeUrl('https://example.com/minecraft-bedrock/addons/x'), false);
  await assert.rejects(
    () => curseforgeImporter.importFromUrl('https://example.com/not-curseforge'),
    /must start with/
  );
  const validated = await curseforgeImporter.validateOnly(
    'https://www.curseforge.com/minecraft-bedrock/addons/pickup-carry-cf'
  );
  assert.equal(validated.ok, true);
  const validatedFilesPage = await curseforgeImporter.validateOnly(
    'https://www.curseforge.com/minecraft-bedrock/maps/one-block-plus/files/all?page=1&pageSize=20&showAlphaFiles=hide'
  );
  assert.equal(validatedFilesPage.url, 'https://www.curseforge.com/minecraft-bedrock/maps/one-block-plus');
  await assert.rejects(
    () => curseforgeImporter.validateOnly('https://www.curseforge.com/minecraft-bedrock'),
    /Bedrock project URL|must start with|Not a CurseForge/
  );
  const previousFetchUrl = process.env.CURSEFORGE_FETCH_URL;
  process.env.CURSEFORGE_FETCH_URL = 'http://127.0.0.1:1';
  await assert.rejects(
    () => curseforgeImporter.importFromUrl('https://example.com/not-curseforge'),
    /must start with/
  );
  if (previousFetchUrl === undefined) delete process.env.CURSEFORGE_FETCH_URL;
  else process.env.CURSEFORGE_FETCH_URL = previousFetchUrl;

  assert.equal(mcpedlImporter.isValidMcpedlUrl('https://mcpedl.com/useful-slime/'), true);
  assert.equal(mcpedlImporter.isValidMcpedlUrl('https://www.mcpedl.com/useful-slime/'), true);
  assert.equal(mcpedlImporter.isValidMcpedlUrl('https://example.com/useful-slime'), false);
  await assert.rejects(
    () => mcpedlImporter.importFromUrl('https://example.com/not-mcpedl'),
    /must start with/
  );
  const validatedMcpedl = await mcpedlImporter.validateOnly('https://www.mcpedl.com/useful-slime/?ref=home');
  assert.equal(validatedMcpedl.url, 'https://mcpedl.com/useful-slime');
  await assert.rejects(
    () => mcpedlImporter.validateOnly('https://mcpedl.com'),
    /MCPEDL project URL|must start with/
  );

  const udpGateway = require('../server/services/udpGateway');
  const lanBroadcast = require('../server/services/lanBroadcast');
  assert.equal(lanBroadcast.statusFor({
    id: 1,
    port: 19132,
    kind: 'remote',
    lan_broadcast: 1,
  }).native, false, 'remote servers must not use native LAN on 19132');
  assert.equal(lanBroadcast.bindPortFor({
    kind: 'remote',
    port: 19134,
    lan_proxy_port: 19200,
  }), 19134, 'remote LAN proxy should reuse the local game port');
  assert.equal(typeof lanBroadcast.killOrphanPhantoms(), 'number');
  assert(Array.isArray(lanBroadcast.listPhantomPids()));
  assert.equal(udpGateway.MAX_REMOTE_SERVERS, 10);
  assert.throws(
    () => serverManager.assertRemoteLocalPort(19132),
    /reserved for LAN discovery/
  );
  assert.throws(
    () => serverManager.assertRemoteLocalPort(19133, 'IPv6 port'),
    /reserved for LAN discovery/
  );
  assert.equal(udpGateway.validateRemoteHost('127.0.0.1'), '127.0.0.1');
  assert.equal(udpGateway.validateRemoteHost('[::1]'), '::1');
  assert.throws(() => udpGateway.validateRemoteHost('bad host'), /invalid characters/);
  assert.throws(() => udpGateway.validateRemoteHost(''), /required/);

  const mockRemote = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    mockRemote.once('error', reject);
    mockRemote.bind(0, '127.0.0.1', resolve);
  });
  const mockRemotePort = mockRemote.address().port;
  const received = new Promise((resolve) => {
    mockRemote.on('message', (msg, rinfo) => {
      if (msg && msg[0] === 0x01) {
        const pong = Buffer.alloc(1 + 8 + 8 + 16);
        pong[0] = 0x1c;
        msg.copy(pong, 1, 1, 9);
        pong.writeBigUInt64BE(1n, 9);
        Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex').copy(pong, 17);
        mockRemote.send(pong, rinfo.port, rinfo.address);
        return;
      }
      mockRemote.send(msg, rinfo.port, rinfo.address);
      if (msg.toString() === 'ping-remote') resolve({ msg, rinfo });
    });
  });

  const remoteCreated = await serverManager.createServer({
    kind: 'remote',
    name: `remote-gw-${suffix}`,
    port: 19190,
    ipv6Port: 18190,
    remoteHost: '127.0.0.1',
    remoteIpv4Port: mockRemotePort,
    remoteIpv6Port: mockRemotePort,
  });
  assert.equal(remoteCreated.kind, 'remote');
  assert.equal(remoteCreated.status, 'stopped');
  const storedRemote = serverManager.getServer(remoteCreated.id);
  assert.equal(storedRemote.remote_host, '127.0.0.1');
  assert.equal(Number(storedRemote.remote_ipv4_port), mockRemotePort);
  assert.equal(udpGateway.isActive(remoteCreated.id), false);

  await serverManager.setLanBroadcast(remoteCreated.id, false);
  await serverManager.startServer(remoteCreated.id);
  assert.equal(serverManager.getServer(remoteCreated.id).status, 'running');
  assert.equal(udpGateway.isActive(remoteCreated.id), true);
  const remotePing = require('../server/services/remotePing');
  let reachable = null;
  for (let i = 0; i < 20; i += 1) {
    reachable = remotePing.reachable(remoteCreated.id);
    if (reachable === true) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(reachable, true, 'a started remote gateway should report the Bedrock pong as online');
  const remoteStats = await serverManager.getServerStats(remoteCreated.id);
  assert.equal(remoteStats.remoteReachable, true);

  const probe = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.send(Buffer.from('ping-remote'), 19190, '127.0.0.1', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  const got = await Promise.race([
    received,
    new Promise((_, reject) => setTimeout(() => reject(new Error('UDP gateway did not forward')), 2000)),
  ]);
  assert.equal(got.msg.toString(), 'ping-remote');
  probe.close();

  assert.throws(
    () => serverManager.sendCommand(remoteCreated.id, 'list'),
    /do not accept console commands/
  );
  await assert.rejects(
    () => serverManager.updateServer(remoteCreated.id, 'latest'),
    /cannot be updated/
  );
  await assert.rejects(
    () => modManager.installModToServer(remoteCreated.id, 1),
    /do not support mods/
  );

  await serverManager.stopServer(remoteCreated.id);
  assert.equal(udpGateway.isActive(remoteCreated.id), false);
  assert.equal(remotePing.reachable(remoteCreated.id), null, 'stopped remotes should not keep pinging');
  await new Promise((resolve) => mockRemote.close(resolve));

  for (let i = 0; i < 10; i += 1) {
    const capPath = path.join(testRoot, `remote-cap-${i}`);
    fs.mkdirSync(capPath, { recursive: true });
    db.prepare(`
      INSERT INTO servers (name, version, port, data_path, kind, remote_host, remote_ipv4_port)
      VALUES (?, 'N/A', ?, ?, 'remote', '127.0.0.1', 19132)
    `).run(`remote-cap-${suffix}-${i}`, 25580 + i, capPath);
  }
  await assert.rejects(
    () => serverManager.createServer({
      kind: 'remote',
      name: `remote-cap-extra-${suffix}`,
      port: 19191,
      remoteHost: '127.0.0.1',
      remoteIpv4Port: 19132,
    }),
    /At most 10 remote servers/
  );

  console.log(JSON.stringify({
    databaseMigration: 'ok',
    udpPortDetection: 'ok',
    playerAccessFiles: 'ok',
    playerPresence: 'ok',
    packInstall: 'ok',
    dnsProxy: 'ok',
    bedrockConnectList: 'ok',
    curseforgeUrlImport: 'ok',
    remoteGateway: 'ok',
    mcpedlUrlImport: 'ok',
    windowsPlatformAdapter: 'ok',
    curseforgeProjects: catalog.results.map(item => item.name),
    gitCatalogMods: gitMods.map(item => item.slug),
  }, null, 2));
}

run()
  .then(() => {
    db.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
    process.exit(0);
  })
  .catch(error => {
    console.error(error);
    db.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
    process.exit(1);
  });
