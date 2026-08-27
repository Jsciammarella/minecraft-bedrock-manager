const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.MC_MANAGER_DB_PATH) {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-server-access-'));
  process.env.MC_MANAGER_DB_PATH = path.join(testRoot, 'mc_manager.db');
  process.env.MC_MANAGER_USER_PLUGINS_DIR = path.join(testRoot, 'plugins');
  process.env.MC_MANAGER_PLUGIN_DATA_DIR = path.join(testRoot, 'plugin-data');
  process.env.MC_MANAGER_PLUGIN_STATE_PATH = path.join(testRoot, 'plugin-state.json');
}

process.env.MBM_SECURITY_PROFILE = process.env.MBM_SECURITY_PROFILE || 'local-rbac';

const decision = require('../server/security/decision');
const evaluate = require('../server/security/evaluate');
const registry = require('../server/services/resourceAuthorizationRegistry');
const state = require('../server/services/resourceAuthorizationState');
const catalog = require('../server/services/permissionCatalog');

function fakePlugin(id = 'server-access-control') {
  return {
    id,
    source: 'bundled',
    capabilities: ['provider:resource-authorization'],
  };
}

function userPrincipal(id, extra = {}) {
  return {
    id,
    username: extra.username || `user${id}`,
    type: 'user',
    authenticated: true,
    isAdmin: Boolean(extra.isAdmin),
    isActive: extra.isActive !== false,
    permissions: extra.permissions || ['servers.view', 'servers.view_details', 'servers.start'],
  };
}

function makeProvider(hooks = {}) {
  return {
    id: 'server-access',
    resourceType: 'server',
    authorize: (principal, action, resource, context) => evaluate.decide(principal, action, resource, context),
    getEffectivePermissions: () => ({}),
    listAssignablePermissions: () => catalog.listServerAssignablePermissions('bedrock'),
    getDisableImpact: () => ({
      required: true,
      configuredServers: 1,
      serverGroups: 0,
      assignedUsers: 1,
      allowAssignments: 0,
      denyAssignments: 1,
      restrictedServers: 0,
    }),
    collectSources: hooks.collectSources || (() => []),
    inspectMembership: hooks.inspectMembership || (() => ({ accessMode: 'inherited', assigned: true })),
  };
}

function run() {
  assert.equal(catalog.isServerAssignable('servers.view', 'bedrock'), true);
  assert.equal(catalog.isServerAssignable('servers.create_bedrock', 'bedrock'), false);
  assert.equal(catalog.isServerAssignable('users.create', 'bedrock'), false);
  assert.equal(catalog.isServerAssignable('servers.remote.start_proxy', 'bedrock'), false);
  assert.equal(catalog.isServerAssignable('servers.remote.start_proxy', 'remote'), true);

  const combinedDeny = decision.combine('servers.start', { type: 'server', id: 1 }, [
    decision.source({ origin: 'global-group', value: 'allow' }),
    decision.source({ origin: 'server-user', scope: 'server', value: 'deny' }),
  ]);
  assert.equal(combinedDeny.decision, 'deny');
  assert.equal(combinedDeny.winningSource.origin, 'server-user');

  const combinedAllow = decision.combine('servers.start', { type: 'server', id: 1 }, [
    decision.source({ origin: 'server-group', scope: 'server', value: 'allow' }),
  ]);
  assert.equal(combinedAllow.decision, 'allow');

  const globalDenyWins = decision.combine('servers.start', { type: 'server', id: 1 }, [
    decision.source({ origin: 'global-user', value: 'deny' }),
    decision.source({ origin: 'server-user', scope: 'server', value: 'allow' }),
  ]);
  assert.equal(globalDenyWins.decision, 'deny');

  registry.resetForTests();
  assert.throws(
    () => registry.register({ id: 'evil', source: 'user', capabilities: ['provider:resource-authorization'] }, makeProvider()),
    /bundled first-party/,
  );

  registry.register(fakePlugin(), makeProvider({
    collectSources: () => [decision.source({ origin: 'server-user', scope: 'server', value: 'deny', permission: 'servers.start' })],
  }));
  const principal = userPrincipal(2);
  const serverA = { type: 'server', id: 11, kind: 'bedrock' };
  const denied = evaluate.decide(principal, 'servers.start', serverA);
  assert.equal(denied.decision, 'deny');

  registry.resetForTests();
  registry.register(fakePlugin(), makeProvider({
    collectSources: (_p, _perm, resource) => {
      if (Number(resource.id) !== 11) return [];
      return [decision.source({ origin: 'server-user', scope: 'server', value: 'allow' })];
    },
  }));
  const allowedA = evaluate.decide(principal, 'servers.console.view', { type: 'server', id: 11, kind: 'bedrock' });
  const otherB = evaluate.decide(principal, 'servers.console.view', { type: 'server', id: 22, kind: 'bedrock' });
  assert.equal(allowedA.decision, 'allow');
  assert.equal(otherB.decision, 'deny');

  registry.resetForTests();
  registry.register(fakePlugin(), makeProvider({
    inspectMembership: () => ({ accessMode: 'restricted', assigned: false }),
  }));
  const hidden = evaluate.decide(principal, 'servers.view', { type: 'server', id: 11, kind: 'bedrock' });
  assert.equal(hidden.decision, 'deny');
  const admin = evaluate.decide(userPrincipal(1, { isAdmin: true }), 'servers.view', { type: 'server', id: 11, kind: 'bedrock' });
  assert.equal(admin.decision, 'allow');

  registry.resetForTests();
  state.markActive('server', 'server-access', 'server-access-control');
  assert.equal(state.unexpectedMissing('server'), true);
  const closed = evaluate.decide(principal, 'servers.view', { type: 'server', id: 11, kind: 'bedrock' });
  assert.equal(closed.decision, 'deny');
  const adminRepair = evaluate.decide(userPrincipal(1, { isAdmin: true }), 'servers.view', { type: 'server', id: 11, kind: 'bedrock' });
  assert.equal(adminRepair.decision, 'allow');
  state.markSuspended('server');
  assert.equal(state.unexpectedMissing('server'), false);

  const coreFiles = [
    'server/services/resourceAuthorizationRegistry.js',
    'server/security/evaluate.js',
    'server/routes/serverAccess.js',
    'server/services/resourceAuthorizationState.js',
  ];
  for (const rel of coreFiles) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.equal(text.includes('server-access-control'), false, `${rel} must not hardcode the plugin id`);
  }

  const pluginDir = path.join(__dirname, '../server/bundled-plugins/server-access-control');
  const pluginPresent = fs.existsSync(path.join(pluginDir, 'plugin.json'));
  const db = require('../server/db/connection');
  if (pluginPresent) {
    const schema = require('../server/bundled-plugins/server-access-control/schema');
    const first = schema.migrate(db);
    const second = schema.migrate(db);
    assert.equal(second.skipped, true);
    assert.ok(first.version === 1);
  } else {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'server_access%'
    `).all();
    assert.deepEqual(tables, [], 'core must not create server-access tables when the plugin is absent');
  }

  registry.resetForTests();
  registry.register(fakePlugin(), makeProvider({
    collectSources: () => [decision.source({ origin: 'server-group', scope: 'server', value: 'allow' })],
  }));
  const groupAllow = evaluate.decide(principal, 'servers.view_details', { type: 'server', id: 11, kind: 'bedrock' });
  assert.equal(groupAllow.decision, 'allow');

  registry.resetForTests();
  registry.register(fakePlugin(), makeProvider({
    collectSources: () => [
      decision.source({ origin: 'server-group', scope: 'server', value: 'allow' }),
      decision.source({ origin: 'server-user', scope: 'server', value: 'deny' }),
    ],
  }));
  const conflict = evaluate.decide(principal, 'servers.start', { type: 'server', id: 11, kind: 'bedrock' });
  assert.equal(conflict.decision, 'deny');

  registry.resetForTests();
  registry.register(fakePlugin(), makeProvider({
    collectSources: () => [decision.source({ origin: 'server-group', scope: 'server', value: 'allow' })],
    inspectMembership: () => ({ accessMode: 'inherited', assigned: true }),
  }));
  const inheritedUnset = evaluate.decide(
    userPrincipal(9, { permissions: [] }),
    'servers.console.send_commands',
    { type: 'server', id: 11, kind: 'bedrock' },
  );
  assert.equal(inheritedUnset.decision, 'allow');

  const socketAuth = require('../server/security/socketAuth');
  const left = [];
  const emitted = [];
  const fakeIo = {
    sockets: {
      sockets: new Map([
        ['s1', {
          principal: principal,
          rooms: new Set(['server-11']),
          leave(room) { left.push(room); },
          emit(event, payload) { emitted.push({ event, payload }); },
        }],
      ]),
    },
  };
  registry.resetForTests();
  registry.register(fakePlugin(), makeProvider({
    inspectMembership: () => ({ accessMode: 'restricted', assigned: false }),
  }));
  socketAuth.revalidateSubscriptions(fakeIo, {
    getServer: () => ({ id: 11, kind: 'bedrock' }),
    authorize: (user, action, resource) => evaluate.allowed(user, action, resource),
  });
  assert.deepEqual(left, ['server-11']);
  assert.equal(emitted[0]?.event, 'server-access-revoked');

  registry.resetForTests();
  if (pluginPresent) runServiceMutationTests();
  console.log('server-access-test: ok');
}

function insertServer(db, name, port, kind = 'bedrock') {
  return db.prepare(`
    INSERT INTO servers (name, version, port, data_path, kind)
    VALUES (?, 'test', ?, ?, ?)
  `).run(name, port, path.join(os.tmpdir(), name), kind).lastInsertRowid;
}

function insertUser(db, username, { isAdmin = 0, isActive = 1 } = {}) {
  return db.prepare(`
    INSERT INTO users (username, full_name, password_hash, is_admin, is_active)
    VALUES (?, ?, 'x', ?, ?)
  `).run(username, username, isAdmin ? 1 : 0, isActive ? 1 : 0).lastInsertRowid;
}

function countUserPerms(db, serverId, userId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM server_access_user_permissions WHERE server_id = ? AND user_id = ?
  `).get(Number(serverId), Number(userId)).n;
}

function countGroupMembers(db, groupId) {
  return db.prepare('SELECT COUNT(*) AS n FROM server_access_group_members WHERE group_id = ?')
    .get(Number(groupId)).n;
}

function runServiceMutationTests() {
  const security = require('../server/security');
  const previous = security.getRuntime && security.getRuntime();
  try {
  security.createRuntime({
    env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'local-rbac' },
    version: '0.5.9',
  });
  const db = require('../server/db/connection');
  const schema = require('../server/bundled-plugins/server-access-control/schema');
  const service = require('../server/bundled-plugins/server-access-control/service');
  schema.migrate(db);

  const serverA = Number(insertServer(db, `access-a-${Date.now()}`, 20000 + Math.floor(Math.random() * 20000)));
  const serverB = Number(insertServer(db, `access-b-${Date.now()}`, 40000 + Math.floor(Math.random() * 20000)));
  const userId = Number(insertUser(db, `sac-user-${Date.now()}`));
  const otherUser = Number(insertUser(db, `sac-other-${Date.now()}`));
  const inactiveGlobal = Number(insertUser(db, `sac-inactive-${Date.now()}`, { isActive: 0 }));
  const adminActor = userPrincipal(1, { isAdmin: true, username: 'admin' });

  service.addUser(serverA, userId, adminActor);
  service.applyUserPermissions(serverA, userId, { 'servers.start': 'allow' }, adminActor);
  let sources = service.collectSources(userPrincipal(userId), 'servers.start', { type: 'server', id: serverA, kind: 'bedrock' });
  assert.ok(sources.some((item) => item.origin === 'server-user' && item.value === 'allow'), 'active direct allow');

  service.applyUserPermissions(serverA, userId, { 'servers.start': 'deny' }, adminActor);
  sources = service.collectSources(userPrincipal(userId), 'servers.start', { type: 'server', id: serverA, kind: 'bedrock' });
  assert.ok(sources.some((item) => item.origin === 'server-user' && item.value === 'deny'), 'active direct deny');

  service.updateUser(serverA, userId, { isActive: false }, adminActor);
  sources = service.collectSources(userPrincipal(userId), 'servers.start', { type: 'server', id: serverA, kind: 'bedrock' });
  assert.equal(sources.some((item) => item.origin === 'server-user'), false, 'inactive direct deny contributes nothing');
  assert.equal(countUserPerms(db, serverA, userId) >= 1, true, 'inactive assignment preserves stored permissions');
  const membership = service.inspectMembership(userPrincipal(userId), { type: 'server', id: serverA });
  assert.equal(membership.assigned, false, 'inactive explicit assignment does not satisfy membership');

  const group = service.createGroup(serverA, { name: `ops-${Date.now()}` }, adminActor);
  service.applyGroupMembers(serverA, group.id, [userId], adminActor);
  service.applyGroupPermissions(serverA, group.id, { 'servers.console.view': 'allow' }, adminActor);
  const grouped = service.inspectMembership(userPrincipal(userId), { type: 'server', id: serverA });
  assert.equal(grouped.assigned, true, 'active server-group membership satisfies restricted membership independently');
  const groupSources = service.collectSources(userPrincipal(userId), 'servers.console.view', { type: 'server', id: serverA, kind: 'bedrock' });
  assert.ok(groupSources.some((item) => item.origin === 'server-group' && item.value === 'allow'));
  const inactiveDirect = service.collectSources(userPrincipal(userId), 'servers.start', { type: 'server', id: serverA, kind: 'bedrock' });
  assert.equal(inactiveDirect.some((item) => item.origin === 'server-user'), false);

  service.updateUser(serverA, userId, { isActive: true }, adminActor);
  const restored = service.collectSources(userPrincipal(userId), 'servers.start', { type: 'server', id: serverA, kind: 'bedrock' });
  assert.ok(restored.some((item) => item.origin === 'server-user' && item.value === 'deny'), 'reactivation restores stored direct permissions');

  service.addUser(serverB, userId, adminActor);
  service.applyUserPermissions(serverB, userId, { 'servers.stop': 'allow' }, adminActor);
  const fromA = service.collectSources(userPrincipal(userId), 'servers.stop', { type: 'server', id: serverA, kind: 'bedrock' });
  const fromB = service.collectSources(userPrincipal(userId), 'servers.stop', { type: 'server', id: serverB, kind: 'bedrock' });
  assert.equal(fromA.some((item) => item.origin === 'server-user'), false, 'server A assignment must not affect server B');
  assert.ok(fromB.some((item) => item.origin === 'server-user' && item.value === 'allow'));

  const inactivePrincipal = userPrincipal(inactiveGlobal, { isActive: false, permissions: ['servers.start'] });
  const globalInactive = evaluate.decide(inactivePrincipal, 'servers.start', { type: 'server', id: serverA, kind: 'bedrock' });
  assert.equal(globalInactive.decision, 'deny');

  const beforePerms = countUserPerms(db, serverA, userId);
  assert.throws(() => service.applyUserPermissions(serverA, userId, { 'not.a.permission': 'allow' }, adminActor), /Unknown permission/);
  assert.equal(countUserPerms(db, serverA, userId), beforePerms);

  assert.throws(() => service.applyUserPermissions(serverA, userId, { 'users.create': 'allow' }, adminActor), /cannot be assigned at server scope/);
  assert.equal(countUserPerms(db, serverA, userId), beforePerms);

  assert.throws(() => service.applyUserPermissions(serverA, userId, { 'servers.start': 'maybe' }, adminActor), /Invalid assignment/);
  assert.equal(countUserPerms(db, serverA, userId), beforePerms);

  assert.throws(() => service.applyUserPermissions(serverA, userId, { 'servers.remote.start_proxy': 'allow' }, adminActor), /not compatible|cannot be assigned/);
  assert.equal(countUserPerms(db, serverA, userId), beforePerms);

  const beforeMembers = countGroupMembers(db, group.id);
  assert.throws(() => service.applyGroupMembers(serverA, group.id, [999999], adminActor), /Unknown user/);
  assert.equal(countGroupMembers(db, group.id), beforeMembers);

  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/INSERT INTO server_access_user_permissions/.test(String(sql))) {
      return { run: () => { throw new Error('simulated insertion failure'); } };
    }
    return origPrepare(sql);
  };
  try {
    assert.throws(
      () => service.applyUserPermissions(serverA, userId, { 'servers.console.view': 'allow' }, adminActor),
      /simulated insertion failure/,
    );
    assert.equal(countUserPerms(db, serverA, userId), beforePerms, 'failed insert must roll back existing permission rows');
  } finally {
    db.prepare = origPrepare;
  }

  const operator = userPrincipal(otherUser, { isAdmin: false, permissions: [] });
  assert.throws(
    () => service.applyUserPermissions(serverA, userId, { 'servers.start': 'allow' }, operator),
    (err) => err && err.status === 403,
  );

  service.removeUser(serverA, userId, adminActor);
  assert.equal(countUserPerms(db, serverA, userId), 0, 'removing the assignment deletes direct permission rows');
  assert.equal(service.getAssignedUser(serverA, userId).assignmentActive, false);
  } finally {
    if (previous) security.setRuntime(previous);
    else security.resetRuntime();
  }
}

function runServerAccessTests() {
  run();
}

if (require.main === module) {
  runServerAccessTests();
}

module.exports = { runServerAccessTests };
