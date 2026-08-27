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

  const db = require('../server/db/connection');
  const schema = require('../server/bundled-plugins/server-access-control/schema');
  const first = schema.migrate(db);
  const second = schema.migrate(db);
  assert.equal(second.skipped, true);
  assert.ok(first.version === 1);

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
  console.log('server-access-test: ok');
}

function runServerAccessTests() {
  run();
}

if (require.main === module) {
  runServerAccessTests();
}

module.exports = { runServerAccessTests };
