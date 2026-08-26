const assert = require('assert');
const fs = require('fs');
const path = require('path');

function snapshot(keys) {
  return [...new Set(keys)].sort();
}

function runPermissionCatalogTests({ auth, catalog, db, pluginHost }) {
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
      if (!catalog.permissionByKey(key) && !catalog.ALL_KEYS.includes(key)) missing.add(`${path.relative(frontendRoot, file)}:${key}`);
    }
  }
  assert.deepEqual([...missing], [], `frontend permission keys missing from catalog: ${[...missing].join(', ')}`);

  const mutating = [];
  const routeDir = path.join(__dirname, '../server/routes');
  for (const name of fs.readdirSync(routeDir).filter((item) => item.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(routeDir, name), 'utf8');
    const routeRe = /router\.(post|put|patch|delete)\(([^)]*)\)/g;
    let match;
    while ((match = routeRe.exec(text))) {
      const args = match[2];
      if (!/requirePermission|requireAnyPermission|assertPermission|requireServer|requireAdmin/.test(args) && !text.includes('assertPermission')) {
        mutating.push(`${name}:${match[1]} ${args.split(',')[0]}`);
      }
    }
  }

  const matrix = require('../server/security/actionMatrix');
  assert.ok(matrix.mutatingEntries().every((item) => item.permission), 'action matrix mutating entries declare a permission');

  const duplicate = pluginHost.parseManifest({
    id: 'hello-world',
    name: 'Hello',
    permissions: [
      { key: 'greet', name: 'Greet', description: 'One' },
      { key: 'greet', name: 'Greet again', description: 'Two' },
    ],
  }, 'hello-world');
  assert.equal(duplicate.ok, false, 'duplicate plugin permission keys are rejected');

  pluginHost.resetForTests();
  pluginHost.loadPlugins();
  const bc = pluginHost.getPlugin('server-edition-bedrock-connect');
  assert.ok(bc?.permissions.some((item) => item.key === 'bedrock_connect.view'));

  const defs = auth.listPermissionDefs();
  assert.ok(defs.some((item) => item.key === 'dashboard.view'));
  assert.equal(defs.some((item) => item.key === 'menu.view.dashboard'), false);
  assert.ok(catalog.CORE_PERMISSIONS.every((item) => item.displayName && item.description && item.primaryCategory && item.riskLevel));

  void byKey;
}

module.exports = { runPermissionCatalogTests };
