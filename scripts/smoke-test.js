const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-manager-smoke-'));
process.env.MC_MANAGER_DB_PATH = path.join(testRoot, 'mc_manager.db');
const db = require('../server/db/connection');
const serverManager = require('../server/services/serverManager');
const curseforge = require('../server/services/curseforgeClient');
const gitCatalog = require('../server/services/gitCatalogClient');
const settingsStore = require('../server/services/settingsStore');
const modManager = require('../server/services/modManager');
const connectHost = require('../server/services/connectHost');
const portRanges = require('../server/services/portRanges');

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
  assert.equal(extraLanPreview.native, true);

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
  await assert.rejects(
    () => serverManager.setLanBroadcast(bc.lastInsertRowid, true),
    /cannot be advertised/
  );

  console.log(JSON.stringify({
    databaseMigration: 'ok',
    udpPortDetection: 'ok',
    playerAccessFiles: 'ok',
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
