const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function insertServer(db, { name, port, dataPath, kind = 'bedrock', status = 'stopped' }) {
  return db.prepare(`
    INSERT INTO servers (name, version, port, data_path, kind, status)
    VALUES (?, 'test', ?, ?, ?, ?)
  `).run(name, port, dataPath, kind, status).lastInsertRowid;
}

function copyBundledWithoutBedrockConnect(dest) {
  const src = path.join(__dirname, '../server/bundled-plugins');
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name === 'server-edition-bedrock-connect') continue;
    fs.cpSync(path.join(src, name), path.join(dest, name), { recursive: true });
  }
}

async function runBedrockConnectPluginTests({ pluginHost, testRoot, db, serverManager }) {
  const catalog = require('../server/services/permissionCatalog');
  const javaHostingPolicy = require('../server/services/javaHostingPolicy');
  const bedrockConnectPolicy = require('../server/services/bedrockConnectPolicy');
  const auth = require('../server/services/authService');
  const dnsProxy = require('../server/services/dnsProxy');
  const migration = require('../server/services/bedrockConnectPermissionMigration');
  const dnsSettings = require('../server/services/dnsSettings');

  const uploadedNativeCore = pluginHost.parseManifest({
    id: 'hello-world',
    name: 'Hello',
    pages: [{ id: 'main', title: 'Nope', renderer: 'native-core', path: '/bedrock-connect' }],
  }, 'hello-world');
  assert.equal(uploadedNativeCore.ok, false, 'uploaded plugins cannot request native-core pages');

  pluginHost.resetForTests();
  pluginHost.loadPlugins();
  const plugin = pluginHost.getPlugin('server-edition-bedrock-connect');
  assert.ok(plugin, 'bundled BedrockConnect plugin should load');
  assert.equal(plugin.enabled, true);
  assert.equal(pluginHost.publicPlugin(plugin).removable, false);
  assert.ok((plugin.capabilities || []).includes('provider:server-edition'));
  const menu = pluginHost.getMenuItems().find((item) => item.pluginId === 'server-edition-bedrock-connect');
  assert.ok(menu);
  assert.equal(menu.path, '/bedrock-connect');
  assert.equal(menu.renderer, 'native-core');
  assert.equal(menu.permissionKey, 'bedrock_connect.view');

  const editions = javaHostingPolicy.listEditions();
  const bcEdition = editions.find((item) => item.id === 'bedrock-connect');
  assert.ok(bcEdition);
  assert.equal(bcEdition.kind, 'bedrock_connect');
  assert.equal(bcEdition.createSurface, 'dashboard');
  assert.equal(bcEdition.createPermission, 'bedrock_connect.create');
  assert.equal(bcEdition.catalogFilter, false);
  assert.equal(bedrockConnectPolicy.isBedrockConnectAvailable(), true);

  assert.ok(catalog.permissionByKey('bedrock_connect.view')?.pluginId === 'server-edition-bedrock-connect');
  assert.equal(catalog.isDeprecatedPermission('menu.view.bedrock_connect'), true);
  assert.equal(catalog.startPermissionForKind('bedrock_connect'), 'bedrock_connect.start');
  assert.equal(catalog.createPermissionForKind('bedrock_connect'), 'bedrock_connect.create');
  assert.equal(catalog.deletePermissionForKind('bedrock_connect'), 'bedrock_connect.delete');
  assert.ok(!catalog.STANDARD_KEYS.includes('bedrock_connect.create'));
  assert.ok(!catalog.STANDARD_KEYS.includes('servers.create_bedrock_connect'));

  const defs = auth.listPermissionDefs();
  assert.equal(defs.some((item) => item.key === 'menu.view.bedrock_connect'), false, 'deprecated keys stay out of the ordinary catalog');
  assert.ok(defs.some((item) => item.key === 'bedrock_connect.view' && item.source === 'first-party-plugin'));

  const group = auth.createGroup({ name: `BC Legacy ${Date.now()}` });
  db.prepare(`
    INSERT INTO group_permissions (group_id, permission_key, value)
    VALUES (?, 'menu.view.bedrock_connect', 'allow'),
           (?, 'servers.create_bedrock_connect', 'allow'),
           (?, 'servers.start_bedrock_connect', 'allow'),
           (?, 'servers.stop_bedrock_connect', 'deny')
  `).run(group.id, group.id, group.id, group.id);
  migration.migrate();
  migration.migrate();
  const copied = db.prepare(`
    SELECT permission_key, value FROM group_permissions WHERE group_id = ?
  `).all(group.id);
  const byKey = Object.fromEntries(copied.map((row) => [row.permission_key, row.value]));
  assert.equal(byKey['bedrock_connect.view'], 'allow');
  assert.equal(byKey['bedrock_connect.create'], 'allow');
  assert.equal(byKey['bedrock_connect.start'], 'allow');
  assert.equal(byKey['bedrock_connect.stop'], 'deny');
  assert.equal(byKey['bedrock_connect.restart'], 'deny');
  assert.equal(migration.currentVersion(), '1');

  let bcId;
  const existingBc = serverManager.getBedrockConnectServer();
  if (existingBc) {
    bcId = existingBc.id;
  } else {
    const dataPath = path.join(testRoot, 'bc-plugin-record');
    fs.mkdirSync(dataPath, { recursive: true });
    bcId = insertServer(db, {
      name: 'Bedrock Connect',
      port: 19132,
      dataPath,
      kind: 'bedrock_connect',
    });
    serverManager.invalidateServerCache(bcId);
  }
  db.prepare(`
    UPDATE servers
    SET provider_id = COALESCE(NULLIF(provider_id, ''), 'server-edition-bedrock-connect'),
        capability_id = COALESCE(NULLIF(capability_id, ''), 'bedrock-connect')
    WHERE id = ?
  `).run(bcId);
  const stored = db.prepare('SELECT kind, provider_id, capability_id FROM servers WHERE id = ?').get(bcId);
  assert.equal(stored.kind, 'bedrock_connect');

  await assert.rejects(
    () => pluginHost.setPluginEnabled('server-edition-bedrock-connect', false),
    (err) => err.code === 'BEDROCK_CONNECT_DISABLE_CONFIRM'
  );
  assert.equal(pluginHost.getPlugin('server-edition-bedrock-connect').enabled, true);

  const origStop = serverManager.stopServer.bind(serverManager);
  serverManager.stopServer = async () => { throw new Error('refused to stop'); };
  db.prepare(`UPDATE servers SET status = 'running' WHERE id = ?`).run(bcId);
  try {
    await assert.rejects(
      () => pluginHost.setPluginEnabled('server-edition-bedrock-connect', false, { confirm: true }),
      (err) => err.code === 'BEDROCK_CONNECT_DISABLE_FAILED'
    );
    assert.equal(pluginHost.getPlugin('server-edition-bedrock-connect').enabled, true);
    assert.equal(bedrockConnectPolicy.isBedrockConnectAvailable(), true);
  } finally {
    serverManager.stopServer = origStop;
    db.prepare(`UPDATE servers SET status = 'stopped' WHERE id = ?`).run(bcId);
  }

  dnsSettings.saveConfig({ enabled: true, upstreams: ['1.1.1.1'], overrides: [] });
  await pluginHost.setPluginEnabled('server-edition-bedrock-connect', false, { confirm: true });
  assert.equal(pluginHost.getPlugin('server-edition-bedrock-connect').enabled, false);
  assert.equal(bedrockConnectPolicy.isBedrockConnectAvailable(), false);
  assert.equal(pluginHost.getMenuItems().some((item) => item.path === '/bedrock-connect'), false);
  assert.equal(javaHostingPolicy.listEditions().some((item) => item.id === 'bedrock-connect'), false);
  const hidden = javaHostingPolicy.filterVisibleServers(serverManager.getAllServers());
  assert.equal(hidden.some((item) => item.kind === 'bedrock_connect'), false);
  const retained = db.prepare('SELECT id, kind, name FROM servers WHERE id = ?').get(bcId);
  assert.ok(retained);
  assert.equal(retained.kind, 'bedrock_connect');
  const dnsCfg = dnsSettings.getConfig();
  assert.equal(dnsCfg.enabled, true);
  assert.deepEqual(dnsCfg.upstreams, ['1.1.1.1']);
  assert.equal(dnsProxy.getStatus().running, false);

  await assert.rejects(
    () => serverManager.createBedrockConnect(),
    (err) => err.code === 'PLUGIN_CAPABILITY_DISABLED' && err.plugin === 'server-edition-bedrock-connect'
  );
  await assert.rejects(
    () => serverManager.startBedrockConnect(serverManager.getServer(bcId)),
    (err) => err.code === 'PLUGIN_CAPABILITY_DISABLED'
  );

  await pluginHost.setPluginEnabled('server-edition-bedrock-connect', true);
  assert.equal(bedrockConnectPolicy.isBedrockConnectAvailable(), true);
  assert.ok(pluginHost.getMenuItems().some((item) => item.path === '/bedrock-connect'));
  assert.ok(javaHostingPolicy.filterVisibleServers(serverManager.getAllServers()).some((item) => item.id === bcId));
  const afterEnable = serverManager.getServer(bcId);
  assert.equal(afterEnable.status, 'stopped');
  assert.equal(dnsProxy.getStatus().running, false, 're-enable must not autostart DNS');

  const tmpBundled = fs.mkdtempSync(path.join(os.tmpdir(), 'mbm-bundled-no-bc-'));
  copyBundledWithoutBedrockConnect(tmpBundled);
  pluginHost.resetForTests();
  pluginHost.loadPlugins([tmpBundled, process.env.MC_MANAGER_USER_PLUGINS_DIR]);
  assert.equal(pluginHost.getPlugin('server-edition-bedrock-connect'), null);
  assert.equal(bedrockConnectPolicy.isBedrockConnectAvailable(), false);
  require('../server/services/bedrockConnect');
  require('../server/services/bedrockConnectLifecycle');
  require('../server/services/dnsProxy');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM servers WHERE id = ?').get(bcId).n, 1);
  assert.equal(
    javaHostingPolicy.filterVisibleServers(serverManager.getAllServers()).some((item) => item.id === bcId),
    false
  );
  await assert.rejects(
    () => serverManager.createBedrockConnect(),
    (err) => err.code === 'PLUGIN_CAPABILITY_DISABLED'
  );
  await require('../server/services/bedrockConnectLifecycle').shutdown();
  const bedrockPath = path.join(testRoot, 'plain-bedrock-after-bc-plugin');
  fs.mkdirSync(bedrockPath, { recursive: true });
  const plainId = insertServer(db, {
    name: 'Still Bedrock',
    port: 19140,
    dataPath: bedrockPath,
    kind: 'bedrock',
  });
  serverManager.invalidateServerCache(plainId);
  const visible = javaHostingPolicy.filterVisibleServers(serverManager.getAllServers());
  assert.ok(visible.some((item) => item.id === plainId));

  pluginHost.resetForTests();
  pluginHost.loadPlugins();
  fs.rmSync(tmpBundled, { recursive: true, force: true });
}

module.exports = { runBedrockConnectPluginTests };
