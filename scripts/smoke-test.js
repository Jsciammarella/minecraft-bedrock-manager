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

  const denied = gitCatalog.friendlyGitError(new Error('remote: You are not allowed to download code.\nfatal: The requested URL returned error: 403'));
  assert.match(denied, /read_repository/, 'GitLab download denial should mention the required token scope');

  const packPath = path.join(testRoot, 'library-mod.mcaddon');
  fs.writeFileSync(packPath, 'pack');
  const libraryMod = db.prepare(`
    INSERT INTO mods (name, slug, type, description, file_path, source)
    VALUES (?, ?, 'addon', '', ?, 'upload')
  `).run('Library Edit', `library-edit-${suffix}`, packPath);
  const updatedMod = await modManager.updateMod(libraryMod.lastInsertRowid, { description: 'Added after upload' });
  assert.equal(updatedMod.description, 'Added after upload');

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
