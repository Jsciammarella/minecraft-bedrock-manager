const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const express = require('express');
const { Server } = require('socket.io');

if (!process.env.MC_MANAGER_DB_PATH) {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-security-'));
  process.env.MC_MANAGER_DB_PATH = path.join(testRoot, 'mc_manager.db');
  process.env.MC_MANAGER_USER_PLUGINS_DIR = path.join(testRoot, 'plugins');
  process.env.MC_MANAGER_PLUGIN_DATA_DIR = path.join(testRoot, 'plugin-data');
  process.env.MC_MANAGER_PLUGIN_STATE_PATH = path.join(testRoot, 'plugin-state.json');
}

const security = require('../server/security');
const catalog = require('../server/services/permissionCatalog');
const { attachPrincipal, requirePermission, isPublicApiPath } = require('../server/security/middleware');
const socketAuth = require('../server/security/socketAuth');
const catalogSettingsPermissions = require('../server/security/catalogSettingsPermissions');
const { CORE_FEATURES } = require('../server/security/features');

function ensureAdmin() {
  const auth = require('../server/services/authService');
  auth.ensureSeed();
  if (auth.needsAdministratorBootstrap()) {
    auth.bootstrapAdministrator({ username: 'admin', password: 'mcadmin' });
  }
  return auth.login('admin', 'mcadmin');
}

function restrictedPrincipal(extra = {}) {
  return {
    id: extra.id || 99,
    username: extra.username || 'restricted',
    type: 'user',
    authenticated: true,
    isAdmin: false,
    isActive: true,
    permissions: extra.permissions || [],
    ...extra,
  };
}

function runContract(runtime, expectedProfile) {
  assert.equal(runtime.profile, expectedProfile);
  const system = runtime.createSystemPrincipal('contract-test');
  assert.equal(system.type, 'system');
  assert.equal(system.authenticated, true);
  assert.ok(system.username);

  const recognized = 'servers.view_details';
  assert.equal(runtime.authorize(system, recognized), true);
  assert.equal(runtime.authorize(system, 'not.a.real.permission'), false);

  const caps = runtime.getCapabilities(system);
  assert.equal(caps.securityProfile, expectedProfile);
  assert.equal(typeof caps.authenticationRequired, 'boolean');
  assert.ok(caps.features);
  assert.equal(caps.features.userManagement, expectedProfile === 'local-rbac');
  assert.equal(caps.features.roleManagement, expectedProfile === 'local-rbac');
  assert.ok(Array.isArray(caps.permissions));
  assert.ok(caps.permissions.includes('servers.start'));
  assert.equal(runtime.supports('userManagement'), expectedProfile === 'local-rbac');
  assert.equal(runtime.supports('authentication'), expectedProfile === 'local-rbac');
  assert.equal(runtime.supports('sessions'), expectedProfile === 'local-rbac');
  assert.equal(runtime.supports('passwordManagement'), expectedProfile === 'local-rbac');
  assert.equal(runtime.supports('roleManagement'), expectedProfile === 'local-rbac');
  assert.equal(runtime.supports('not-a-real-feature'), false);
  assert.equal(runtime.supports('userManagment'), false);
  for (const feature of CORE_FEATURES) {
    assert.equal(runtime.supports(feature), true, `${expectedProfile} should support ${feature}`);
  }
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function testApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (isPublicApiPath(req)) return next();
    return attachPrincipal(req, res, next);
  });
  app.use('/api/auth', require('../server/routes/auth'));
  if (security.supports('userManagement')) {
    app.use('/api/user-management', require('../server/routes/userManagement'));
  } else {
    app.use('/api/user-management', (_req, res) => {
      res.status(404).json({ error: 'User management is not available' });
    });
  }
  app.get('/api/servers', requirePermission('servers.view_details'), (_req, res) => {
    res.json({ servers: [] });
  });
  app.post('/api/servers/1/start', requirePermission('servers.start'), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

async function json(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
}

function restoreSingleton(previous) {
  if (previous) security.setRuntime(previous);
  else security.resetRuntime();
}

function runChild(code, extraEnv = {}) {
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 45000,
  });
  if (result.status !== 0) {
    throw new Error(`isolation child failed (${result.status}): ${result.stderr || ''}\n${result.stdout || ''}`);
  }
  return result.stdout;
}

function runNoAuthIndependenceTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-noauth-indep-'));
  const dbPath = path.join(dir, 'mc_manager.db');
  const code = `
    const assert = require('assert');
    const Module = require('module');
    const orig = Module._resolveFilename;
    const blocked = ['providers/localRbac', 'authService', 'userManagement'];
    Module._resolveFilename = function(request, parent, isMain, options) {
      const normalized = String(request).replace(/\\\\/g, '/');
      if (blocked.some((item) => normalized.includes(item))) {
        const err = new Error("Cannot find module '" + request + "'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return orig.call(this, request, parent, isMain, options);
    };
    const runtime = require('./server/security/runtime');
    const created = runtime.createRuntime({
      version: '0.4.3',
      env: process.env,
    });
    assert.equal(created.profile, 'no-auth');
    const loaded = Object.keys(require.cache).join('\\n');
    assert.equal(/authService\\.js/.test(loaded), false, 'authService must not load');
    assert.equal(/localRbac\\.js/.test(loaded), false, 'localRbac must not load');
    assert.equal(/userManagement\\.js/.test(loaded), false, 'userManagement must not load');
    const db = require('./server/db/connection');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    const principal = created.authenticate({ headers: {} }).principal;
    assert.equal(created.authorize(principal, 'servers.console'), true);
    assert.equal(created.authorize(principal, 'not.a.permission'), false);
    assert.equal(created.supports('plugins'), true);
    assert.equal(created.supports('authentication'), false);
    assert.equal(created.supports('unknown-feature'), false);
    console.log('ok');
  `;
  runChild(code, {
    NODE_ENV: 'test',
    MBM_SECURITY_PROFILE: 'no-auth',
    MC_MANAGER_DB_PATH: dbPath,
    MC_MANAGER_USER_PLUGINS_DIR: path.join(dir, 'plugins'),
    MC_MANAGER_PLUGIN_DATA_DIR: path.join(dir, 'plugin-data'),
    MC_MANAGER_PLUGIN_STATE_PATH: path.join(dir, 'plugin-state.json'),
  });
}

function runMissingRbacFailsClosed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rbac-missing-'));
  const dbPath = path.join(dir, 'mc_manager.db');
  const code = `
    const assert = require('assert');
    const Module = require('module');
    const orig = Module._resolveFilename;
    Module._resolveFilename = function(request, parent, isMain, options) {
      const normalized = String(request).replace(/\\\\/g, '/');
      if (normalized.includes('providers/localRbac') || normalized.includes('authService')) {
        const err = new Error("Cannot find module '" + request + "'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return orig.call(this, request, parent, isMain, options);
    };
    const runtime = require('./server/security/runtime');
    assert.throws(
      () => runtime.createRuntime({
        version: '0.4.9',
        env: { NODE_ENV: 'production' },
      }),
      /missing or invalid|cannot start|No-auth will not be selected/i,
    );
    assert.throws(
      () => runtime.createRuntime({
        version: '0.4.6',
        env: { NODE_ENV: 'production' },
      }),
      /missing or invalid|cannot start|No-auth will not be selected/i,
    );
    const open = runtime.createRuntime({
      version: '0.4.3',
      env: { NODE_ENV: 'production' },
    });
    assert.equal(open.profile, 'no-auth');
    console.log('ok');
  `;
  runChild(code, {
    NODE_ENV: 'production',
    MC_MANAGER_DB_PATH: dbPath,
    MC_MANAGER_USER_PLUGINS_DIR: path.join(dir, 'plugins'),
    MC_MANAGER_PLUGIN_DATA_DIR: path.join(dir, 'plugin-data'),
    MC_MANAGER_PLUGIN_STATE_PATH: path.join(dir, 'plugin-state.json'),
  });
}

function runBootstrapAndUpgradeTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rbac-boot-'));
  const dbPath = path.join(dir, 'mc_manager.db');
  const code = `
    const assert = require('assert');
    const security = require('./server/security');
    const runtime = security.createRuntime({
      version: '0.4.9',
      env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'local-rbac' },
    });
    const auth = require('./server/services/authService');
    const db = require('./server/db/connection');
    assert.equal(auth.needsAdministratorBootstrap(), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
    assert.throws(() => auth.login('admin', 'mcadmin'), /invalid|incorrect|credentials|password/i);
    assert.throws(
      () => auth.bootstrapAdministrator({ username: 'admin' }),
      /password is required/i,
    );
    const created = auth.bootstrapAdministrator({
      username: 'admin',
      password: 'operator-secret-1',
      fullName: 'Operator',
    });
    assert.equal(created.username, 'admin');
    assert.equal(created.isAdmin, true);
    assert.equal(auth.needsAdministratorBootstrap(), false);
    assert.throws(
      () => auth.bootstrapAdministrator({ username: 'other', password: 'another-secret-1' }),
      /not available/i,
    );
    const login = runtime.provider.login('admin', 'operator-secret-1');
    assert.equal(login.user.username, 'admin');
    assert.throws(() => auth.login('admin', 'mcadmin'), /invalid|incorrect|credentials|password/i);
    security.resetRuntime();
    const again = security.createRuntime({
      version: '0.4.9',
      env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'local-rbac' },
    });
    const survived = again.provider.login('admin', 'operator-secret-1');
    assert.equal(survived.user.isAdmin, true);
    assert.ok(survived.user.permissions.includes('servers.start'));
    console.log('ok');
  `;
  runChild(code, {
    NODE_ENV: 'test',
    MBM_SECURITY_PROFILE: 'local-rbac',
    MC_MANAGER_DB_PATH: dbPath,
    MC_MANAGER_USER_PLUGINS_DIR: path.join(dir, 'plugins'),
    MC_MANAGER_PLUGIN_DATA_DIR: path.join(dir, 'plugin-data'),
    MC_MANAGER_PLUGIN_STATE_PATH: path.join(dir, 'plugin-state.json'),
  });
}

function runSecurityProviderTests() {
  const previous = security.getRuntime();

  try {
    const rbac = security.createRuntime({
      env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'local-rbac' },
      version: '0.4.9',
    });
    runContract(rbac, 'local-rbac');
    ensureAdmin();
    const login = rbac.provider.login('admin', 'mcadmin');
    assert.equal(login.user.username, 'admin');
    assert.equal(rbac.authorize(login.user, 'servers.start'), true);
    assert.equal(rbac.authorize({ ...login.user, isAdmin: false, permissions: [] }, 'servers.start'), false);
    assert.equal(rbac.authorize(login.user, 'totally.unknown'), false);
    assert.equal(rbac.authorize(restrictedPrincipal(), 'plugin.unknown.action'), false);

    const noAuth = security.createRuntime({
      env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'no-auth' },
      version: '0.4.3',
    });
    runContract(noAuth, 'no-auth');
    const anon = noAuth.authenticate({ headers: {} });
    assert.equal(anon.principal.id, 'local-system');
    assert.equal(anon.principal.type, 'system');
    assert.equal(noAuth.authorize(anon.principal, 'servers.delete'), true);
    assert.equal(noAuth.authorize(anon.principal, 'made.up.permission'), false);
    assert.equal(noAuth.supports('userManagement'), false);
    assert.equal(noAuth.getCapabilities(anon.principal).needsBootstrap, false);

    const productionNine = security.profiles.resolveProfile({
      version: '0.4.9',
      env: { NODE_ENV: 'production', MBM_SECURITY_PROFILE: 'no-auth' },
    });
    assert.equal(productionNine.profile, 'local-rbac');
    assert.equal(productionNine.source, 'trusted');

    const productionSix = security.profiles.resolveProfile({
      version: '0.4.6',
      env: { NODE_ENV: 'production', MBM_SECURITY_PROFILE: 'no-auth' },
    });
    assert.equal(productionSix.profile, 'local-rbac');

    const openSource = security.profiles.resolveProfile({
      version: '0.4.3',
      env: { NODE_ENV: 'production' },
    });
    assert.equal(openSource.profile, 'no-auth');

    assert.throws(
      () => security.createRuntime({
        selection: { profile: 'local-rbac', source: 'trusted', patch: 9, locked: true },
        providers: new Map(),
      }),
      /No-auth will not be selected as a fallback|missing or invalid/i,
    );
    assert.throws(
      () => security.createRuntime({
        selection: { profile: 'broken', source: 'trusted', patch: 6, locked: true },
        providers: new Map(),
      }),
      /No-auth will not be selected as a fallback|Unknown security profile/i,
    );
    const noAuthOnly = new Map();
    noAuthOnly.set('no-auth', require('../server/security/providers/noAuth'));
    assert.throws(
      () => security.createRuntime({
        version: '0.4.9',
        env: { NODE_ENV: 'production' },
        providers: noAuthOnly,
      }),
      /No-auth will not be selected as a fallback|missing or invalid/i,
    );

    assert.equal(catalog.CORE_PERMISSIONS.some((item) => item.key === 'servers.create_java'), false);
    assert.ok(require('../server/services/permissionDefinitions').JAVA_PERMISSION_KEYS.includes('servers.create_java'));
    assert.ok(catalog.PERMISSIONS.some((item) => item.administrative === true || item.destructive === true));
    assert.equal(catalog.startPermissionForKind('java'), 'servers.start_java');
    assert.equal(catalog.createPermissionForKind('java'), 'servers.create_java');

    const javaPerms = catalog.requiredServerUpdatePermissions(
      { kind: 'java' },
      { pvp: true, simulation_distance: 8 },
      { pvp: false, simulation_distance: 10 },
    );
    assert.ok(javaPerms.includes('servers.java.pvp'));
    assert.ok(javaPerms.includes('servers.java.simulation_distance'));
    assert.ok(!javaPerms.includes('servers.change_java_settings'));

    runNoAuthIndependenceTests();
    runMissingRbacFailsClosed();
    runBootstrapAndUpgradeTests();

    return { rbac, noAuth };
  } finally {
    restoreSingleton(previous);
  }
}

async function runCatalogSettingsPermissionTests() {
  const previous = security.getRuntime();
  try {
    assert.equal(
      catalogSettingsPermissions.permissionFor('catalog-curseforge', 'save'),
      'catalog.curseforge.configure',
    );
    assert.equal(
      catalogSettingsPermissions.permissionFor('catalog-curseforge', 'test-connection'),
      'catalog.curseforge.configure',
    );
    assert.equal(
      catalogSettingsPermissions.permissionFor('catalog-git', 'sync-now'),
      'catalog.git.sync',
    );
    assert.equal(
      catalogSettingsPermissions.permissionFor('catalog-git', 'download-template'),
      'catalog.download_to_library',
    );
    assert.equal(
      catalogSettingsPermissions.permissionFor('catalog-file', 'test-smb-path'),
      'catalog.file.configure',
    );
    assert.equal(
      catalogSettingsPermissions.permissionFor('catalog-file', 'download-template'),
      'catalog.download_to_library',
    );
    assert.equal(catalogSettingsPermissions.permissionFor('catalog-git', 'not-a-real-action'), null);
    assert.equal(catalogSettingsPermissions.permissionFor('unknown-plugin', 'save'), null);

    const pluginHost = require('../server/services/pluginHost');
    const pluginSettings = require('../server/services/pluginSettings');
    pluginHost.loadPlugins([pluginHost.BUNDLED_PLUGINS_DIR]);

    security.setRuntime(security.createRuntime({
      env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'local-rbac' },
      version: '0.4.9',
    }));
    ensureAdmin();
    const admin = require('../server/services/authService').login('admin', 'mcadmin').user;
    const reader = restrictedPrincipal({ permissions: ['servers.view_details'] });
    const system = security.createSystemPrincipal('catalog-settings-test');

    const cfPage = pluginSettings.publicPage('catalog-curseforge', { user: admin });
    assert.equal(cfPage.renderer, 'native-settings');
    assert.throws(
      () => pluginSettings.publicPage('catalog-curseforge', { user: reader }),
      /permission/,
    );

    await pluginSettings.invokeAction(
      'catalog-curseforge',
      'save',
      { values: { bedrockEnabled: true, javaEnabled: true } },
      { user: admin },
    );
    await assert.rejects(
      () => pluginSettings.invokeAction(
        'catalog-curseforge',
        'save',
        { values: { bedrockEnabled: true } },
        { user: reader },
      ),
      /permission/,
    );
    await assert.rejects(
      () => pluginSettings.invokeAction('catalog-curseforge', 'not-registered', {}, { user: admin }),
      /Unknown settings action/,
    );

    security.setRuntime(security.createRuntime({
      env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'no-auth' },
      version: '0.4.3',
    }));
    const local = security.authenticate({}).principal;
    const viewed = pluginSettings.publicPage('catalog-file', { user: local });
    assert.equal(viewed.renderer, 'native-settings');
    await pluginSettings.invokeAction(
      'catalog-file',
      'save',
      { values: { enabled: true, localEnabled: true } },
      { user: local },
    );
    const download = await pluginSettings.invokeAction('catalog-git', 'download-template', {}, { user: system });
    assert.equal(download.download, true);
    const hostSrc = fs.readFileSync(path.join(__dirname, '../server/services/pluginHost.js'), 'utf8');
    assert.doesNotMatch(hostSrc, /createSystemPrincipal/);
    assert.doesNotMatch(hostSrc, /registerSecurityProvider|securityProvider/);
  } finally {
    restoreSingleton(previous);
  }
}

async function runSecurityHttpTests() {
  const previous = security.getRuntime();
  try {
    security.setRuntime(security.createRuntime({
      env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'local-rbac' },
      version: '0.4.9',
    }));
    ensureAdmin();
    await withServer(testApp(), async (origin) => {
      const anon = await json(`${origin}/api/servers`);
      assert.equal(anon.status, 401);

      const info = await json(`${origin}/api/auth/security`);
      assert.equal(info.status, 200);
      assert.equal(info.body.authenticationRequired, true);
      assert.equal(info.body.features.userManagement, true);
      assert.equal(info.body.needsBootstrap, false);

      const badLogin = await json(`${origin}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'wrong' }),
      });
      assert.ok(badLogin.status === 400 || badLogin.status === 401);

      const login = await json(`${origin}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'mcadmin' }),
      });
      assert.equal(login.status, 200);
      const cookieHeader = login.headers.get('set-cookie') || '';
      const cookie = cookieHeader.split(';')[0];
      const authed = await json(`${origin}/api/servers/1/start`, {
        method: 'POST',
        headers: cookie ? { cookie } : {},
        body: '{}',
      });
      assert.equal(authed.status, 200);

      const users = await json(`${origin}/api/user-management/users`, {
        headers: cookie ? { cookie } : {},
      });
      assert.equal(users.status, 200);
    });

    const auth = require('../server/services/authService');
    const groups = auth.listGroups();
    const readOnly = groups.find((group) => group.name === 'Read-only');
    const admin = auth.login('admin', 'mcadmin').user;
    const reader = auth.createUser({
      username: `sec-reader-${Date.now()}`,
      fullName: 'Security Reader',
      password: 'readonly1',
      groupIds: [readOnly.id],
    }, admin);

    security.setRuntime(security.createRuntime({
      env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'local-rbac' },
      version: '0.4.9',
    }));
    const forbidden = security.getRuntime().authorize(reader, 'servers.start');
    assert.equal(forbidden, false);
    const pluginDenied = security.getRuntime().authorize(reader, 'plugin.gateway-geyser.lifecycle');
    assert.equal(pluginDenied, false);
    assert.equal(security.getRuntime().authorize(reader, 'catalog.set_curseforge_key'), false);

    await withServer(testApp(), async (origin) => {
      const login = await json(`${origin}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ username: reader.username, password: 'readonly1' }),
      });
      assert.equal(login.status, 200);
      const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
      const start = await json(`${origin}/api/servers/1/start`, {
        method: 'POST',
        headers: cookie ? { cookie } : {},
        body: '{}',
      });
      assert.equal(start.status, 403);
    });

    security.setRuntime(security.createRuntime({
      env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'no-auth' },
      version: '0.4.3',
    }));
    await withServer(testApp(), async (origin) => {
      const me = await json(`${origin}/api/auth/me`);
      assert.equal(me.status, 200);
      assert.equal(me.body.user.id, 'local-system');
      assert.equal(me.body.authenticationRequired, false);
      const start = await json(`${origin}/api/servers/1/start`, { method: 'POST', body: '{}' });
      assert.equal(start.status, 200);
      const users = await json(`${origin}/api/user-management/users`);
      assert.equal(users.status, 404);
      const login = await json(`${origin}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'mcadmin' }),
      });
      assert.equal(login.status, 404);
      const password = await json(`${origin}/api/auth/password-policy`);
      assert.equal(password.status, 404);
      const logout = await json(`${origin}/api/auth/logout`, { method: 'POST', body: '{}' });
      assert.equal(logout.status, 404);
      const bootstrap = await json(`${origin}/api/auth/bootstrap`, {
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'anything1' }),
      });
      assert.equal(bootstrap.status, 404);
    });
  } finally {
    restoreSingleton(previous);
  }
}

function runSocketAuthorizationTests() {
  const server = { id: 7, kind: 'bedrock', name: 'alpha' };
  const getServer = (id) => (Number(id) === 7 ? server : null);
  const allow = (keys) => (principal, action) => Boolean(principal) && keys.includes(action);
  const adminKeys = ['servers.view_details', 'servers.console.view', 'servers.console.send_commands', 'servers.start', 'servers.stop'];
  const viewOnly = ['servers.view_details'];
  const none = [];

  const joined = socketAuth.authorizeJoin({ id: 1 }, 7, {
    getServer,
    authorize: allow(adminKeys),
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.room, 'server-7');

  const noConsole = socketAuth.authorizeJoin({ id: 2 }, 7, {
    getServer,
    authorize: allow(viewOnly),
  });
  assert.equal(noConsole.ok, false);
  assert.equal(noConsole.error, socketAuth.CONSOLE_DENIED);

  const hidden = socketAuth.authorizeJoin({ id: 3 }, 7, {
    getServer,
    authorize: allow(none),
  });
  assert.equal(hidden.ok, false);
  assert.equal(hidden.error, socketAuth.GENERIC_JOIN);

  const missing = socketAuth.authorizeJoin({ id: 1 }, 404, {
    getServer,
    authorize: allow(adminKeys),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, socketAuth.GENERIC_JOIN);

  const malformed = socketAuth.authorizeJoin({ id: 1 }, 'not-an-id', {
    getServer,
    authorize: allow(adminKeys),
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, socketAuth.GENERIC_JOIN);

  const commandOk = socketAuth.authorizeCommand({ id: 1 }, 7, {
    getServer,
    authorize: allow(adminKeys),
  });
  assert.equal(commandOk.ok, true);

  const commandDenied = socketAuth.authorizeCommand({ id: 2 }, 7, {
    getServer,
    authorize: allow(viewOnly),
  });
  assert.equal(commandDenied.ok, false);
  assert.match(commandDenied.error, /console/i);

  const java = { id: 8, kind: 'java', name: 'java' };
  const startDenied = socketAuth.authorizeStart({ id: 2 }, 8, {
    getServer: (id) => (Number(id) === 8 ? java : null),
    authorize: allow(['servers.view_details', 'servers.start']),
    startPermissionForKind: catalog.startPermissionForKind,
  });
  assert.equal(startDenied.ok, false);
  assert.equal(startDenied.error, socketAuth.START_DENIED);

  const startOk = socketAuth.authorizeStart({ id: 1 }, 8, {
    getServer: (id) => (Number(id) === 8 ? java : null),
    authorize: allow(['servers.view_details', 'servers.start_java']),
    startPermissionForKind: catalog.startPermissionForKind,
  });
  assert.equal(startOk.ok, true);

  const stopHidden = socketAuth.authorizeStop({ id: 3 }, 8, {
    getServer: (id) => (Number(id) === 8 ? java : null),
    authorize: allow(none),
    stopPermissionForKind: catalog.stopPermissionForKind,
  });
  assert.equal(stopHidden.error, socketAuth.GENERIC_STOP);
}

function loadSocketClient() {
  try {
    return require('socket.io-client');
  } catch {
    /* fall through */
  }
  try {
    const socketIoDir = path.dirname(require.resolve('socket.io/package.json'));
    return require(require.resolve('socket.io-client', { paths: [socketIoDir] }));
  } catch {
    return null;
  }
}

async function connectClient(origin, extra = {}) {
  const clientLib = loadSocketClient();
  if (!clientLib) return null;
  const ioClient = clientLib.io || clientLib;
  const socket = ioClient(origin, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    withCredentials: true,
    ...extra,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return socket;
}

function once(socket, event) {
  return new Promise((resolve) => {
    socket.once(event, (payload) => resolve(payload));
  });
}

async function runSocketIntegrationTests() {
  const clientLib = loadSocketClient();
  if (!clientLib) {
    console.warn('security-provider-test: socket.io-client not installed; skipping live socket tests');
    return;
  }
  const previous = security.getRuntime();
  const serverRow = { id: 7, kind: 'bedrock', name: 'alpha', status: 'stopped' };
  const options = {
    getServer: (id) => (Number(id) === 7 ? serverRow : null),
    authorize: (principal, action) => {
      if (!principal) return false;
      if (principal.isAdmin) return true;
      return Array.isArray(principal.permissions) && principal.permissions.includes(action);
    },
    startPermissionForKind: catalog.startPermissionForKind,
    stopPermissionForKind: catalog.stopPermissionForKind,
    startServer: async () => { serverRow.status = 'running'; },
    stopServer: async () => { serverRow.status = 'stopped'; },
    sendCommand: async () => {},
  };

  try {
    security.setRuntime(security.createRuntime({
      env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'no-auth' },
      version: '0.4.3',
    }));
    const app = express();
    const httpServer = http.createServer(app);
    const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
    socketAuth.attach(io, options);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${httpServer.address().port}`;
    const local = await connectClient(origin);
    const joined = once(local, 'join-error');
    local.emit('join-server', 7);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(local.connected, true);
    local.emit('join-server', 'bad-id');
    const bad = await Promise.race([joined, new Promise((resolve) => setTimeout(() => resolve('timeout'), 500))]);
    if (bad !== 'timeout') {
      assert.match(String(bad.error || ''), /subscribe|permission/i);
    }
    local.close();
    await new Promise((resolve) => httpServer.close(resolve));

    security.setRuntime(security.createRuntime({
      env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'local-rbac' },
      version: '0.4.9',
    }));
    ensureAdmin();
    const adminLogin = require('../server/services/authService').login('admin', 'mcadmin');
    const httpServer2 = http.createServer(express());
    const io2 = new Server(httpServer2, { cors: { origin: true, credentials: true } });
    const liveOptions = {
      ...options,
      authorize: (principal, action, resource) => security.authorize(principal, action, resource),
    };
    socketAuth.attach(io2, liveOptions);
    await new Promise((resolve) => httpServer2.listen(0, '127.0.0.1', resolve));
    const origin2 = `http://127.0.0.1:${httpServer2.address().port}`;
    const adminSock = await connectClient(origin2, {
      auth: { token: adminLogin.session.token },
    });
    const joinErr = once(adminSock, 'join-error');
    adminSock.emit('join-server', 7);
    const maybeErr = await Promise.race([
      joinErr,
      new Promise((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    assert.equal(maybeErr, null);
    adminSock.emit('join-server', 404);
    const hiddenJoin = await once(adminSock, 'join-error');
    assert.equal(hiddenJoin.error, socketAuth.GENERIC_JOIN);
    adminSock.close();

    const groups = require('../server/services/authService').listGroups();
    const readOnly = groups.find((group) => group.name === 'Read-only');
    const adminUser = adminLogin.user;
    const viewer = require('../server/services/authService').createUser({
      username: `ws-viewer-${Date.now()}`,
      fullName: 'WS Viewer',
      password: 'readonly1',
      groupIds: [readOnly.id],
    }, adminUser);
    require('../server/services/authService').updateUser(viewer.id, {
      userPermissions: { 'servers.view_details': 'allow' },
    }, adminUser);
    const viewerLogin = require('../server/services/authService').login(viewer.username, 'readonly1');
    const viewerSock = await connectClient(origin2, {
      auth: { token: viewerLogin.session.token },
    });
    viewerSock.emit('join-server', 7);
    const viewerJoin = await once(viewerSock, 'join-error');
    assert.equal(viewerJoin.error, socketAuth.CONSOLE_DENIED);
    viewerSock.emit('start-server', 7);
    const startErr = await once(viewerSock, 'server-error');
    assert.match(String(startErr.error || ''), /permission|Unable to start/i);
    viewerSock.close();
    await new Promise((resolve) => httpServer2.close(resolve));
  } finally {
    restoreSingleton(previous);
  }
}

function runSecurityRouteCatalogTests() {
  const pluginHost = require('../server/services/pluginHost');
  if (!pluginHost.getPlugins().length) pluginHost.loadPlugins();
  const roots = [
    path.join(__dirname, '../server/routes'),
    path.join(__dirname, '../server/index.js'),
  ];
  const files = [];
  for (const root of roots) {
    const stat = fs.statSync(root);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(root)) {
        if (name.endsWith('.js')) files.push(path.join(root, name));
      }
    } else {
      files.push(root);
    }
  }
  const pattern = /requirePermission\(\s*['"]([^'"]+)['"]|assertPermission\(\s*\w+\s*,\s*['"]([^'"]+)['"]/g;
  const keys = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let match = pattern.exec(text);
    while (match) {
      keys.add(match[1] || match[2]);
      match = pattern.exec(text);
    }
  }
  const known = new Set(catalog.listKeys());
  const special = new Set(['admin', 'gateway:lifecycle']);
  const missing = [...keys].filter((key) => !known.has(key) && !special.has(key) && !String(key).startsWith('plugin.'));
  assert.deepEqual(missing, [], `Route permissions missing from catalog: ${missing.join(', ')}`);
}

async function runAllSecurityTests() {
  runSecurityProviderTests();
  runSecurityRouteCatalogTests();
  runSocketAuthorizationTests();
  await runSecurityHttpTests();
  await runCatalogSettingsPermissionTests();
  await runSocketIntegrationTests();
}

module.exports = {
  runSecurityProviderTests,
  runSecurityHttpTests,
  runSecurityRouteCatalogTests,
  runAllSecurityTests,
};

if (require.main === module) {
  runAllSecurityTests()
    .then(() => {
      console.log('security-provider-test: ok');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
