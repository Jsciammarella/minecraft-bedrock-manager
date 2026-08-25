const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

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
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
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
  app.get('/api/auth/security', (_req, res) => res.json(security.publicInfo()));
  app.get('/api/auth/me', (req, res) => {
    res.json({
      user: security.publicPrincipal(req.principal || req.user),
      ...security.getCapabilities(req.principal || req.user),
    });
  });
  app.post('/api/auth/login', (req, res) => {
    if (!security.supports('authentication')) {
      return res.status(404).json({ error: 'Authentication is not enabled' });
    }
    try {
      const result = security.provider.login(req.body.username, req.body.password);
      res.setHeader('Set-Cookie', security.provider.cookieHeader(result.session.token, result.session.maxAge));
      res.json({ user: result.user });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });
  app.get('/api/servers', requirePermission('servers.view_details'), (_req, res) => {
    res.json({ servers: [] });
  });
  app.post('/api/servers/1/start', requirePermission('servers.start'), (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/user-management', (req, res) => {
    if (!security.supports('userManagement')) {
      return res.status(404).json({ error: 'User management is not available' });
    }
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

function runSecurityProviderTests() {
  const previous = security.getRuntime();

  try {
    const rbac = security.createRuntime({
      env: { NODE_ENV: 'test', MBM_SECURITY_PROFILE: 'local-rbac' },
      version: '0.4.9',
    });
    runContract(rbac, 'local-rbac');
    const login = rbac.provider.login('admin', 'mcadmin');
    assert.equal(login.user.username, 'admin');
    assert.equal(rbac.authorize(login.user, 'servers.start'), true);
    assert.equal(rbac.authorize({ ...login.user, isAdmin: false, permissions: [] }, 'servers.start'), false);
    assert.equal(rbac.authorize(login.user, 'totally.unknown'), false);

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

    assert.ok(catalog.PERMISSIONS.some((item) => item.key === 'servers.create_java'));
    assert.ok(catalog.PERMISSIONS.some((item) => item.administrative === true || item.destructive === true));
    assert.equal(catalog.startPermissionForKind('java'), 'servers.start_java');
    assert.equal(catalog.createPermissionForKind('java'), 'servers.create_java');

    const javaPerms = catalog.requiredServerUpdatePermissions(
      { kind: 'java' },
      { pvp: true, simulation_distance: 8 },
    );
    assert.ok(javaPerms.includes('servers.change_java_settings'));

    return { rbac, noAuth };
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
    await withServer(testApp(), async (origin) => {
      const anon = await json(`${origin}/api/servers`);
      assert.equal(anon.status, 401);

      const info = await json(`${origin}/api/auth/security`);
      assert.equal(info.status, 200);
      assert.equal(info.body.authenticationRequired, true);
      assert.equal(info.body.features.userManagement, true);

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

      const restricted = security.getRuntime().provider.login
        ? null
        : null;
      void restricted;
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
    });
  } finally {
    restoreSingleton(previous);
  }
}

function runSecurityRouteCatalogTests() {
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
  const special = new Set(['admin', 'gateway:lifecycle', 'catalog:settings:view']);
  const missing = [...keys].filter((key) => !known.has(key) && !special.has(key) && !String(key).startsWith('plugin.'));
  assert.deepEqual(missing, [], `Route permissions missing from catalog: ${missing.join(', ')}`);
}

async function runAllSecurityTests() {
  runSecurityProviderTests();
  runSecurityRouteCatalogTests();
  await runSecurityHttpTests();
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
