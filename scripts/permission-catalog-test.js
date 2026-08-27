const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const family = require('./verify-release-family');

function snapshot(keys) {
  return [...new Set(keys)].sort();
}

async function runPermissionCatalogTests({ auth, catalog, db, pluginHost }) {
  auth.ensureSeed();
  if (auth.needsAdministratorBootstrap()) {
    auth.bootstrapAdministrator({ username: 'admin', password: 'mcadmin' });
  }
  const admin = auth.login('admin', 'mcadmin').user;
  assert.equal(admin.isAdmin, true);

  const groups = auth.listGroups();
  const byKey = Object.fromEntries(
    groups
      .filter((group) => group.systemKey || group.slug)
      .map((group) => [group.systemKey || group.slug, group]),
  );
  const administrators = groups.find((group) => group.systemKey === 'administrators' || group.slug === 'administrators');
  const readOnly = groups.find((group) => group.systemKey === 'read-only' || group.slug === 'read-only');
  const standard = groups.find((group) => group.systemKey === 'standard-users' || group.slug === 'standard');
  const powerUsers = groups.find((group) => group.systemKey === 'power-users' || group.slug === 'power-users');
  assert(administrators, 'Administrators system group exists');
  assert(readOnly, 'Read-only system group exists');
  assert(standard, 'Standard Users system group exists');
  assert(powerUsers, 'Power Users system group exists');
  assert.equal(groups.filter((group) => (group.systemKey || group.slug) === 'power-users').length, 1);

  const adminGroupUser = auth.createUser({
    username: `admin-group-${Date.now()}`,
    fullName: 'Group Admin',
    password: 'groupadmin1',
    groupIds: [administrators.id],
  }, admin);
  assert.equal(adminGroupUser.isAdmin, false, 'Administrators-group membership does not set is_admin');

  const reader = auth.createUser({
    username: `reader-${Date.now()}`,
    fullName: 'Reader',
    password: 'readonly1',
    groupIds: [readOnly.id],
  }, admin);
  assert.deepEqual(snapshot(reader.permissions), snapshot(catalog.READ_ONLY_KEYS));
  assert.equal(reader.permissions.includes('dashboard.view'), true);
  assert.equal(reader.permissions.includes('menu.view.dashboard'), false);
  assert.equal(reader.permissions.includes('servers.create_bedrock'), false);

  const operator = auth.createUser({
    username: `standard-${Date.now()}`,
    fullName: 'Standard',
    password: 'standard1',
    groupIds: [standard.id],
  }, admin);
  assert.deepEqual(snapshot(operator.permissions), snapshot(catalog.STANDARD_KEYS));
  assert.equal(operator.permissions.includes('servers.create_bedrock'), false);
  assert.equal(operator.permissions.includes('catalog.view'), true);

  const power = auth.createUser({
    username: `power-${Date.now()}`,
    fullName: 'Power',
    password: 'poweruser1',
    groupIds: [powerUsers.id],
  }, admin);
  assert.deepEqual(snapshot(power.permissions), snapshot(catalog.POWER_USER_KEYS));
  assert.equal(power.permissions.includes('servers.create_bedrock'), true);
  assert.equal(power.permissions.includes('servers.delete'), false);
  assert.equal(power.permissions.includes('plugins.install'), false);
  assert.equal(power.permissions.includes('bedrock_connect.view'), false);

  const none = auth.createUser({
    username: `none-${Date.now()}`,
    fullName: 'None',
    password: 'noneuser1',
    skipDefaultGroup: true,
  }, admin);
  assert.equal(none.permissions.includes('dashboard.view'), false);

  const denyGroup = auth.createGroup({ name: `Deny Dash ${Date.now()}` });
  auth.updateGroup(denyGroup.id, {
    userIds: [operator.id],
    permissions: { 'dashboard.view': 'deny' },
  });
  const afterGroupDeny = auth.getUser(operator.id, { includePermissions: true });
  assert.equal(afterGroupDeny.permissions.includes('dashboard.view'), false);

  const allowOverride = auth.updateUser(operator.id, {
    userPermissions: { 'dashboard.view': 'allow' },
  }, admin);
  assert.equal(allowOverride.permissions.includes('dashboard.view'), false, 'group deny overrides direct user allow');

  const userDeny = auth.updateUser(power.id, {
    userPermissions: { 'servers.start': 'deny' },
  }, admin);
  assert.equal(userDeny.permissions.includes('servers.start'), false, 'direct user deny overrides group allow');

  const javaPerms = catalog.requiredServerUpdatePermissions(
    { kind: 'java' },
    { pvp: true, simulation_distance: 8 },
    { pvp: false, simulation_distance: 10 },
  );
  assert.ok(javaPerms.includes('servers.java.pvp'));
  assert.ok(javaPerms.includes('servers.java.simulation_distance'));
  assert.ok(!javaPerms.includes('servers.change_java_settings'));

  const unchanged = catalog.requiredServerUpdatePermissions(
    { kind: 'java' },
    { pvp: true, simulation_distance: 8 },
    { pvp: true, simulation_distance: 8 },
  );
  assert.deepEqual(unchanged, []);

  for (const [field, permission] of Object.entries(catalog.PROPERTY_FIELD_MAP)) {
    assert.ok(catalog.permissionByKey(permission), `property field ${field} maps to known permission ${permission}`);
  }

  pluginHost.resetForTests();
  pluginHost.loadPlugins();
  auth.syncDynamicPermissions();

  const frontendRoot = path.join(__dirname, '../frontend/src');
  const frontendFiles = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(js|jsx)$/.test(name)) frontendFiles.push(full);
    }
  };
  walk(frontendRoot);
  const keyRe = /can(?:Any)?\(\s*['"]([a-z0-9_.]+)['"]/g;
  const missing = new Set();
  for (const file of frontendFiles) {
    const text = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = keyRe.exec(text))) {
      const key = match[1];
      if (key.startsWith('menu.view.plugin.')) continue;
      if (!catalog.permissionByKey(key) && !catalog.listKeys().includes(key)) missing.add(`${path.relative(frontendRoot, file)}:${key}`);
    }
  }
  assert.deepEqual([...missing], [], `frontend permission keys missing from catalog: ${[...missing].join(', ')}`);

  const matrix = require('../server/security/actionMatrix');
  const routeDir = path.join(__dirname, '../server/routes');
  const found = new Set();
  for (const name of fs.readdirSync(routeDir).filter((item) => item.endsWith('.js'))) {
    const prefix = matrix.ROUTE_FILE_PREFIXES[name];
    if (!prefix) continue;
    const text = fs.readFileSync(path.join(routeDir, name), 'utf8');
    const routeRe = /router\.(post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = routeRe.exec(text))) {
      const routePath = match[2].startsWith('/') ? match[2] : `/${match[2]}`;
      found.add(`${match[1].toUpperCase()} ${prefix}${routePath === '/' ? '' : routePath}`);
    }
    const securedRe = /securedRoute\(\s*router\s*,\s*\{([\s\S]*?)\}\s*,/g;
    while ((match = securedRe.exec(text))) {
      const block = match[1];
      const method = /method:\s*['"](\w+)['"]/.exec(block);
      const routePath = /path:\s*['"]([^'"]+)['"]/.exec(block);
      if (!method || !routePath) continue;
      const suffix = routePath[1].startsWith('/') ? routePath[1] : `/${routePath[1]}`;
      found.add(`${method[1].toUpperCase()} ${prefix}${suffix === '/' ? '' : suffix}`);
    }
  }
  const matrixKeys = new Set(
    matrix.mutatingEntries()
      .filter((item) => item.method !== 'WS')
      .map((item) => `${item.method} ${item.route}`),
  );
  const missingRoutes = [...found].filter((item) => !matrixKeys.has(item)).sort();
  const extraRoutes = [...matrixKeys].filter((item) => !found.has(item)).sort();
  assert.deepEqual(missingRoutes, [], `mutating routes missing from action matrix: ${missingRoutes.join(', ')}`);
  assert.deepEqual(extraRoutes, [], `action matrix routes that no longer exist: ${extraRoutes.join(', ')}`);

  for (const entry of matrix.mutatingEntries()) {
    assert.ok(entry.mode, `${entry.method} ${entry.route} must declare a permission mode`);
    const perms = matrix.declaredPermissions(entry);
    if (entry.mode === 'authentication' || entry.mode === 'field-mapped' || entry.mode === 'kind-specific' || entry.mode === 'plugin-action') {
      if (entry.mode === 'authentication') assert.ok(entry.exceptionReason, `${entry.route} authentication exception needs a reason`);
      if (entry.mode === 'field-mapped' || entry.mode === 'kind-specific' || entry.mode === 'plugin-action') {
        assert.ok(entry.resolver, `${entry.method} ${entry.route} needs a permission resolver`);
      }
    } else {
      assert.ok(perms.length, `${entry.method} ${entry.route} has no permission or approved exception`);
    }
    for (const key of perms) {
      const known = catalog.permissionByKey(key) || catalog.listKeys().includes(key) || catalog.ALL_KEYS.includes(key);
      if (!known && String(key).startsWith('server_access.')) {
        assert.equal(family.pluginPresent(), false, `unknown permission ${key} on ${entry.method} ${entry.route}`);
        continue;
      }
      assert.ok(known, `unknown permission ${key} on ${entry.method} ${entry.route}`);
    }
    if (entry.method !== 'WS' && entry.mode !== 'authentication' && perms.length) {
      const mutatingPerms = perms.filter((key) => catalog.permissionByKey(key)?.riskLevel !== 'read');
      assert.ok(mutatingPerms.length, `mutating route ${entry.method} ${entry.route} has only read-risk permissions`);
    }
  }

  const pluginActionsSrc = fs.readFileSync(path.join(__dirname, '../server/services/pluginActions.js'), 'utf8');
  assert.match(pluginActionsSrc, /permissionResolver\(/, 'plugin action resolver must be invoked');
  const pluginRouteSrc = fs.readFileSync(path.join(__dirname, '../server/routes/plugins.js'), 'utf8');
  assert.match(pluginRouteSrc, /gatewayPermissionsFor/, 'geyser plugin routes declare a host resolver');

  const enforcementBlob = [];
  const walkServer = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === 'bundled-plugins') continue;
        walkServer(full);
      } else if (/\.js$/.test(name) && name !== 'permissionDefinitions.js') {
        enforcementBlob.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walkServer(path.join(__dirname, '../server/routes'));
  walkServer(path.join(__dirname, '../server/security'));
  walkServer(path.join(__dirname, '../server/services'));
  for (const file of frontendFiles) enforcementBlob.push(fs.readFileSync(file, 'utf8'));
  const blob = enforcementBlob.join('\n');
  const unenforced = catalog.CORE_PERMISSIONS
    .filter((item) => !item.informational && !blob.includes(`'${item.key}'`) && !blob.includes(`"${item.key}"`))
    .map((item) => item.key);
  assert.deepEqual(unenforced, [], `core permissions with no enforcement location: ${unenforced.join(', ')}`);

  const duplicate = pluginHost.parseManifest({
    id: 'hello-world',
    name: 'Hello',
    permissions: [
      { key: 'greet', name: 'Greet', description: 'One' },
      { key: 'greet', name: 'Greet again', description: 'Two' },
    ],
  }, 'hello-world');
  assert.equal(duplicate.ok, false, 'duplicate plugin permission keys are rejected');

  const listedPlugins = pluginHost.getPlugins();
  assert.ok(listedPlugins.some((item) => item.id === 'server-edition-bedrock-connect'), 'BedrockConnect is listed as a bundled plugin');
  const bc = pluginHost.getPlugin('server-edition-bedrock-connect');
  assert.ok(bc?.permissions.some((item) => item.key === 'bedrock_connect.view'));
  const javaPlugin = pluginHost.getPlugin('server-edition-java');
  assert.ok(javaPlugin?.permissions.some((item) => item.key === 'servers.create_java'));
  const pluginsPage = fs.readFileSync(path.join(frontendRoot, 'pages/Plugins.jsx'), 'utf8');
  assert.match(pluginsPage, /const canUpload = can\('plugins\.install'\)/);

  const defs = auth.listPermissionDefs();
  assert.ok(defs.some((item) => item.key === 'dashboard.view'));
  assert.equal(defs.some((item) => item.key === 'menu.view.dashboard'), false);
  assert.ok(catalog.CORE_PERMISSIONS.every((item) => item.displayName && item.description && item.primaryCategory && item.riskLevel));
  assert.ok(catalog.CORE_PERMISSIONS.every((item) => item.source === 'core'));
  assert.equal((catalog.PLUGIN_OWNED_PERMISSIONS || []).length, 0, 'core catalog must not own active first-party plugin permissions');
  assert.equal(catalog.CORE_PERMISSIONS.some((item) => item.key === 'bedrock_connect.view' || item.key.startsWith('servers.java.')), false);
  assert.ok(pluginHost.getDynamicPermissions().some((item) => item.key === 'bedrock_connect.view'));
  assert.ok(pluginHost.getDynamicPermissions().some((item) => item.key === 'servers.java.pvp'));
  assert.ok(power.permissions.includes('players.scan'));
  assert.equal(reader.permissions.includes('players.scan'), false);
  assert.equal(operator.permissions.includes('players.scan'), false);

  const serializer = require('../server/services/serverSerializer');
  const sample = {
    id: 1,
    name: 'Alpha',
    kind: 'bedrock',
    status: 'running',
    port: 19132,
    ipv6_port: 19133,
    pid: 4321,
    max_players: 10,
    gamemode: 'survival',
    difficulty: 'easy',
    remote_host: 'example.invalid',
    remote_ipv4_port: 19132,
    stats: { uptime: '5m', onlinePlayers: 3, installedMods: 2, lan: { enabled: true } },
    installedModIds: [9],
    onlinePlayers: [{ id: 1, username: 'Steve' }],
    pluginContributions: [{ connectAddress: '10.0.0.5:19132', status: 'running' }],
  };
  const security = require('../server/security');
  const profile = security.publicInfo().securityProfile;
  const allowAll = profile === security.profiles.PROFILE_NO_AUTH;
  const noProps = serializer.serializeServerForPrincipal(sample, { isAdmin: false, isActive: true, permissions: ['servers.view_details'] }, { context: 'detail', skipAttach: true, stats: sample.stats, onlinePlayers: sample.onlinePlayers, installedModIds: [9] });
  assert.equal(noProps.pid, undefined, `pid must never be serialized under ${profile}`);
  if (allowAll) {
    assert.equal(noProps.max_players, 10, `no-auth should include server properties under ${profile}`);
    assert.equal(noProps.gamemode, 'survival', `no-auth should include gamemode under ${profile}`);
    assert.equal(noProps.port, 19132, `no-auth should include connection details under ${profile}`);
    assert.equal(noProps.status, 'running', `no-auth should include runtime status under ${profile}`);
    assert.deepEqual(noProps.installedModIds, [9], `no-auth should include installed mods under ${profile}`);
    assert.deepEqual(noProps.onlinePlayers, [{ id: 1, username: 'Steve' }], `no-auth should include player names under ${profile}`);
  } else {
    assert.equal(noProps.max_players, undefined, `local-rbac should omit properties without servers.view_properties under ${profile}`);
    assert.equal(noProps.gamemode, undefined, `local-rbac should omit gamemode without servers.view_properties under ${profile}`);
    assert.equal(noProps.port, undefined, `local-rbac should omit connection details without servers.view_connection_details under ${profile}`);
    assert.equal(noProps.status, undefined, `local-rbac should omit runtime status without servers.view_runtime_status under ${profile}`);
    assert.equal(noProps.installedModIds, undefined, `local-rbac should omit mods without servers.mods.view under ${profile}`);
    assert.equal(noProps.onlinePlayers, undefined, `local-rbac should omit player names without players.view_server_membership under ${profile}`);
  }
  const withRuntime = serializer.serializeServerForPrincipal(sample, { isAdmin: false, isActive: true, permissions: ['servers.view_details', 'servers.view_runtime_status'] }, { context: 'detail', skipAttach: true, stats: sample.stats, onlinePlayers: sample.onlinePlayers });
  assert.equal(withRuntime.status, 'running');
  assert.equal(withRuntime.stats.onlinePlayers, 3);
  if (allowAll) {
    assert.deepEqual(
      withRuntime.onlinePlayers,
      [{ id: 1, username: 'Steve' }],
      `no-auth should include player names under ${profile}`,
    );
  } else {
    assert.equal(
      withRuntime.onlinePlayers,
      undefined,
      `local-rbac should omit player names without players.view_server_membership under ${profile}`,
    );
  }
  const dash = serializer.serializeGatewayForPrincipal({
    id: 'gateway:1', name: 'Geyser', status: 'running', connectAddress: '10.0.0.8', port: 19132, targetSummary: 'Remote Java x:25565',
  }, { isAdmin: false, isActive: true, permissions: ['dashboard.view'] }, { context: 'dashboard' });
  if (allowAll) {
    assert.equal(dash.status, 'running', `no-auth dashboard should include runtime status under ${profile}`);
    assert.equal(dash.connectAddress, '10.0.0.8', `no-auth dashboard should include connection details under ${profile}`);
    assert.equal(dash.port, 19132, `no-auth dashboard should include port under ${profile}`);
  } else {
    assert.equal(dash.status, undefined, `local-rbac dashboard should omit runtime status without dashboard.view_runtime_status under ${profile}`);
    assert.equal(dash.connectAddress, undefined, `local-rbac dashboard should omit connection details without dashboard.view_connection_details under ${profile}`);
    assert.equal(dash.port, undefined, `local-rbac dashboard should omit port without dashboard.view_connection_details under ${profile}`);
  }

  const addOnly = auth.createUser({
    username: `addonly-${Date.now()}`,
    fullName: 'Add Only',
    password: 'addonly12',
    skipDefaultGroup: true,
  }, admin);
  const customGroup = auth.createGroup({ name: `Members ${Date.now()}` });
  auth.updateGroup(customGroup.id, {
    userIds: [operator.id],
    permissions: { 'groups.add_members': 'allow' },
  });
  auth.updateGroup(customGroup.id, { userIds: [operator.id, addOnly.id] });
  const addActor = auth.getUser(addOnly.id, { includePermissions: true });
  auth.updateGroup(customGroup.id, { userIds: [operator.id, addOnly.id, reader.id] }, addActor);
  let removed = false;
  try {
    auth.updateGroup(customGroup.id, { userIds: [addOnly.id] }, addActor);
    removed = true;
  } catch (err) {
    assert.equal(err.code, 'PERMISSION_REQUIRED');
    assert.equal(err.permission, 'groups.remove_members');
  }
  assert.equal(removed, false);
  const afterFailedRemove = auth.getGroup(customGroup.id, { includeUsers: true });
  assert.ok(afterFailedRemove.users.some((user) => user.id === operator.id));

  const removeOnly = auth.createUser({
    username: `removeonly-${Date.now()}`,
    fullName: 'Remove Only',
    password: 'removeonly1',
    skipDefaultGroup: true,
  }, admin);
  const removeGroup = auth.createGroup({ name: `Removers ${Date.now()}` });
  auth.updateGroup(removeGroup.id, {
    userIds: [removeOnly.id, reader.id],
    permissions: { 'groups.remove_members': 'allow' },
  });
  const removeActor = auth.getUser(removeOnly.id, { includePermissions: true });
  auth.updateGroup(removeGroup.id, { userIds: [removeOnly.id] }, removeActor);
  let added = false;
  try {
    auth.updateGroup(removeGroup.id, { userIds: [removeOnly.id, operator.id] }, removeActor);
    added = true;
  } catch (err) {
    assert.equal(err.code, 'PERMISSION_REQUIRED');
    assert.equal(err.permission, 'groups.add_members');
  }
  assert.equal(added, false);
  auth.updateGroup(removeGroup.id, { userIds: [removeOnly.id] }, removeActor);
  let invalid = false;
  try {
    auth.updateGroup(removeGroup.id, { userIds: [removeOnly.id, 999999] }, removeActor);
    invalid = true;
  } catch (err) {
    assert.equal(err.status, 400);
  }
  assert.equal(invalid, false);
  assert.equal(auth.getGroup(removeGroup.id, { includeUsers: true }).users.length, 1);

  const v3 = require('../server/services/permissionCatalogMigrationV3');
  const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM group_permissions').get().n;
  db.prepare('DELETE FROM schema_history WHERE migration_key = ?').run(v3.MIGRATION_KEY);
  let failed = false;
  try {
    v3.migrate({ beforeBackup: () => { throw new Error('injected backup failure'); } });
  } catch (err) {
    failed = true;
    assert.equal(err.code, 'PERMISSION_MIGRATION_FAILED');
  }
  assert.equal(failed, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM group_permissions').get().n, beforeCount);
  assert.equal(v3.currentVersion(), '');
  v3.migrate();
  assert.equal(v3.currentVersion(), v3.SCHEMA_VERSION);

  const testPluginDir = path.join(process.env.MC_MANAGER_USER_PLUGINS_DIR || path.join(__dirname, '../data/plugins'), 'test-provider');
  fs.mkdirSync(testPluginDir, { recursive: true });
  fs.writeFileSync(path.join(testPluginDir, 'plugin.json'), JSON.stringify({
    id: 'test-provider',
    name: 'Test Provider',
    permissions: [{
      key: 'manage_feature',
      displayName: 'Manage test feature',
      description: 'Manage the test-provider feature.',
      primaryCategory: 'plugin',
      riskLevel: 'normal',
    }],
  }));
  pluginHost.resetForTests();
  pluginHost.loadPlugins();
  auth.syncDynamicPermissions();
  const testKey = 'plugin.test-provider.manage_feature';
  assert.ok(pluginHost.getDynamicPermissions().some((item) => item.key === testKey));
  const adminGroupUserReloaded = auth.getUser(adminGroupUser.id, { includePermissions: true });
  assert.equal(adminGroupUserReloaded.permissions.includes(testKey), true, 'Administrators-group member receives dynamic plugin permissions');
  assert.equal(auth.getUser(operator.id, { includePermissions: true }).permissions.includes(testKey), false);
  assert.equal(auth.getUser(power.id, { includePermissions: true }).permissions.includes(testKey), false);
  assert.equal(admin.isAdmin && auth.hasPermission(admin, testKey), true);

  const denyPlugin = auth.createGroup({ name: `Deny Plugin ${Date.now()}` });
  auth.updateGroup(denyPlugin.id, {
    userIds: [adminGroupUser.id],
    permissions: { [testKey]: 'deny' },
  });
  assert.equal(auth.getUser(adminGroupUser.id, { includePermissions: true }).permissions.includes(testKey), false, 'group deny overrides Administrators-group grant');
  auth.updateGroup(denyPlugin.id, { userIds: [] });
  auth.updateUser(adminGroupUser.id, { userPermissions: { [testKey]: 'deny' } }, admin);
  assert.equal(auth.getUser(adminGroupUser.id, { includePermissions: true }).permissions.includes(testKey), false, 'direct user deny overrides Administrators-group grant');
  auth.updateUser(adminGroupUser.id, { userPermissions: { [testKey]: null } }, admin);

  await pluginHost.setPluginEnabled('test-provider', false);
  auth.syncDynamicPermissions();
  const inactiveDef = db.prepare('SELECT active FROM permission_defs WHERE key = ?').get(testKey);
  assert.equal(inactiveDef.active, 0);
  const stored = db.prepare('SELECT value FROM group_permissions WHERE permission_key = ? LIMIT 1').get(testKey);
  assert.ok(stored, 'disabled plugin assignments remain stored');
  assert.equal(auth.getUser(adminGroupUser.id, { includePermissions: true }).permissions.includes(testKey), false);
  await pluginHost.setPluginEnabled('test-provider', true);
  auth.syncDynamicPermissions();
  assert.equal(auth.getUser(adminGroupUser.id, { includePermissions: true }).permissions.includes(testKey), true);

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbm-no-plugins-'));
  pluginHost.resetForTests();
  pluginHost.loadPlugins([emptyDir]);
  assert.equal(pluginHost.getDynamicPermissions().filter((item) => item.source === 'first-party-plugin').length, 0);
  pluginHost.resetForTests();
  pluginHost.loadPlugins();
  auth.syncDynamicPermissions();

  const impersonate = pluginHost.parseManifest({
    id: 'hello-world',
    name: 'Hello',
    permissions: [{ key: 'servers.delete', description: 'nope', primaryCategory: 'plugin' }],
  }, 'hello-world', { source: 'user' });
  assert.equal(impersonate.ok !== true || !(impersonate.manifest?.permissions || []).some((item) => item.key === 'servers.delete'), true);

  const adminOnlyPlugin = pluginHost.parseManifest({
    id: 'hello-world',
    name: 'Hello',
    permissions: [{ key: 'secret', description: 'Admin only feature', primaryCategory: 'plugin', riskLevel: 'administrator-only' }],
  }, 'hello-world', { source: 'user' });
  assert.equal(adminOnlyPlugin.ok, false, 'untrusted plugins cannot declare administrator-only permissions');

  void byKey;
}

function itemInformational(key) {
  const item = require('../server/services/permissionCatalog').permissionByKey(key);
  return Boolean(item?.informational);
}

module.exports = { runPermissionCatalogTests };

if (require.main === module) {
  (async () => {
    if (!process.env.MC_MANAGER_DB_PATH) {
      const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-perm-catalog-'));
      process.env.MC_MANAGER_DB_PATH = path.join(testRoot, 'mc_manager.db');
      process.env.MC_MANAGER_USER_PLUGINS_DIR = path.join(testRoot, 'plugins');
      process.env.MC_MANAGER_PLUGIN_DATA_DIR = path.join(testRoot, 'plugin-data');
      process.env.MC_MANAGER_PLUGIN_STATE_PATH = path.join(testRoot, 'plugin-state.json');
    }
    const auth = require('../server/services/authService');
    const catalog = require('../server/services/permissionCatalog');
    const db = require('../server/db/connection');
    const pluginHost = require('../server/services/pluginHost');
    pluginHost.loadPlugins();
    await runPermissionCatalogTests({ auth, catalog, db, pluginHost });
    console.log('permission-catalog-test: ok');
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

