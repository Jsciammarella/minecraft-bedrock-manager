const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-manager-smoke-'));
process.env.MC_MANAGER_DB_PATH = path.join(testRoot, 'mc_manager.db');
const db = require('../server/db/connection');
const serverManager = require('../server/services/serverManager');
const curseforge = require('../server/services/curseforgeClient');

async function run() {
  const accessTable = db.prepare(
    'SELECT name FROM sqlite_master WHERE type = ? AND name = ?'
  ).get('table', 'server_player_access');
  assert(accessTable, 'server_player_access migration was not created');

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

  console.log(JSON.stringify({
    databaseMigration: 'ok',
    playerAccessFiles: 'ok',
    curseforgeProjects: catalog.results.map(item => item.name),
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
