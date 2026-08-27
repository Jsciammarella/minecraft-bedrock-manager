#!/usr/bin/env node
/**
 * Edition-aware health checks for a running manager process.
 * Intended to run inside the application container with scripts mounted.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const profiles = require('../server/security/profiles');
const family = require('./verify-release-family');

const BASE = process.env.MBM_HEALTH_BASE || 'http://127.0.0.1:3000';
const BOOTSTRAP_USERNAME = process.env.MBM_CI_BOOTSTRAP_USERNAME || 'ci-admin';
const BOOTSTRAP_PASSWORD = process.env.MBM_CI_BOOTSTRAP_PASSWORD || 'Ci-Admin-0.5x-Test!';
const BOOTSTRAP_FULL_NAME = process.env.MBM_CI_BOOTSTRAP_FULL_NAME || 'CI Administrator';

const cookies = new Map();

function redact(value) {
  let text = String(value == null ? '' : value);
  const secrets = [BOOTSTRAP_PASSWORD, ...cookies.values()];
  for (const secret of secrets) {
    if (!secret) continue;
    text = text.split(String(secret)).join('[redacted]');
  }
  return text;
}

function storeCookies(header) {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  for (const item of list) {
    const pair = String(item || '').split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    const maxAge = /(?:^|;\s*)Max-Age=(\d+)/i.exec(String(item));
    if ((maxAge && Number(maxAge[1]) === 0) || !value) {
      cookies.delete(name);
      continue;
    }
    cookies.set(name, value);
  }
}

function cookieHeader() {
  if (!cookies.size) return '';
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function request(pathname, { method = 'GET', headers = {}, json, body, auth = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE);
    const nextHeaders = { ...headers };
    let payload = body;
    if (json !== undefined) {
      payload = JSON.stringify(json);
      if (!nextHeaders['content-type'] && !nextHeaders['Content-Type']) {
        nextHeaders['Content-Type'] = 'application/json';
      }
    }
    if (auth) {
      const cookie = cookieHeader();
      if (cookie) nextHeaders.Cookie = cookie;
    }
    const req = http.request(url, { method, headers: nextHeaders }, (res) => {
      storeCookies(res.headers['set-cookie']);
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, json: parsed, raw });
      });
    });
    req.on('error', (err) => reject(new Error(redact(err.message))));
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(redact(message));
}

async function authenticateLocalRbac(bootstrap) {
  assert(bootstrap.status === 200, 'local-rbac must expose bootstrap-status');
  assert(typeof bootstrap.json?.needsBootstrap === 'boolean', 'bootstrap-status body is invalid');
  if (bootstrap.json.needsBootstrap) {
    const created = await request('/api/auth/bootstrap', {
      method: 'POST',
      json: {
        username: BOOTSTRAP_USERNAME,
        password: BOOTSTRAP_PASSWORD,
        fullName: BOOTSTRAP_FULL_NAME,
      },
    });
    assert(created.status === 200, `administrator bootstrap failed (${created.status})`);
  }
  if (!cookies.has('mbm_session')) {
    const login = await request('/api/auth/login', {
      method: 'POST',
      json: { username: BOOTSTRAP_USERNAME, password: BOOTSTRAP_PASSWORD },
    });
    assert(login.status === 200, `administrator login failed (${login.status})`);
  }
  assert(cookies.has('mbm_session'), 'authenticated session cookie was not established');
}

async function main() {
  const expected = family.validate(require(path.join(ROOT, 'package.json')).version);
  const health = await request('/api/health');
  assert(health.status === 200, `/api/health returned ${health.status}`);
  assert(health.json?.status === 'ok', '/api/health status is not ok');
  assert(health.json?.securityProfile === expected.securityProfile, `health profile ${health.json?.securityProfile} != ${expected.securityProfile}`);
  assert(health.json?.authenticationRequired === expected.authenticationRequired, 'health authenticationRequired mismatch');
  if (health.json?.version) {
    assert(String(health.json.version).startsWith(expected.version.split('.').slice(0, 3).join('.')), `health version ${health.json.version} does not match ${expected.version}`);
  }

  const info = await request('/api/auth/security');
  assert(info.status === 200, `/api/auth/security returned ${info.status}`);
  assert(info.json?.securityProfile === expected.securityProfile, 'security endpoint profile mismatch');
  assert(info.json?.authenticationRequired === expected.authenticationRequired, 'security endpoint authenticationRequired mismatch');

  const bootstrap = await request('/api/auth/bootstrap-status');
  const me = await request('/api/auth/me');
  const users = await request('/api/user-management/users');
  const dashboard = await request('/api/dashboard');
  const unauthAvailability = await request('/api/server-access/availability');

  if (expected.securityProfile === profiles.PROFILE_NO_AUTH) {
    assert(bootstrap.status === 404, 'no-auth must not expose bootstrap-status');
    assert(users.status === 404, 'no-auth must not expose user-management');
    assert(me.status === 200 || dashboard.status === 200, 'no-auth dashboard/me should load as the local system principal');
    const db = require('../server/db/connection');
    assert(db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0, 'no-auth database must have no users');
    assert(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n === 0, 'no-auth database must have no sessions');
    assert(unauthAvailability.status === 200, `/api/server-access/availability returned ${unauthAvailability.status}`);
    assert(unauthAvailability.json?.available === false, 'Server Access Control must be unavailable on no-auth editions');
  } else {
    assert(bootstrap.status === 200, 'local-rbac must expose bootstrap-status');
    assert(typeof bootstrap.json?.needsBootstrap === 'boolean', 'bootstrap-status body is invalid');
    assert(me.status === 401 || me.status === 403, `unauthenticated /api/auth/me returned ${me.status}`);
    assert(dashboard.status === 401 || dashboard.status === 403, `unauthenticated /api/dashboard returned ${dashboard.status}`);
    assert(unauthAvailability.status === 401 || unauthAvailability.status === 403, `unauthenticated /api/server-access/availability returned ${unauthAvailability.status}`);
    await authenticateLocalRbac(bootstrap);
    const availability = await request('/api/server-access/availability', { auth: true });
    assert(availability.status === 200, `/api/server-access/availability returned ${availability.status}`);
    assert(
      availability.json?.available === expected.serverAccessPlugin,
      `Server Access Control available=${availability.json?.available} expected=${expected.serverAccessPlugin}`,
    );
  }

  const pluginPath = path.join(ROOT, family.PLUGIN_DIR);
  const present = fs.existsSync(path.join(pluginPath, 'plugin.json'));
  assert(present === expected.serverAccessPlugin, `Server Access Control present=${present} expected=${expected.serverAccessPlugin}`);

  process.stdout.write(`ci-edition-health: ${expected.version} ${expected.securityProfile} ok\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`ci-edition-health: ${redact(err.message)}\n`);
    process.exit(1);
  });
}

module.exports = { main };
