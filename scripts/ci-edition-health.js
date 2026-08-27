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

function request(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE);
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

  if (expected.securityProfile === profiles.PROFILE_NO_AUTH) {
    assert(bootstrap.status === 404, 'no-auth must not expose bootstrap-status');
    assert(users.status === 404, 'no-auth must not expose user-management');
    assert(me.status === 200 || dashboard.status === 200, 'no-auth dashboard/me should load as the local system principal');
    const db = require('../server/db/connection');
    assert(db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0, 'no-auth database must have no users');
    assert(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n === 0, 'no-auth database must have no sessions');
  } else {
    assert(bootstrap.status === 200, 'local-rbac must expose bootstrap-status');
    assert(typeof bootstrap.json?.needsBootstrap === 'boolean', 'bootstrap-status body is invalid');
    assert(me.status === 401 || me.status === 403, `unauthenticated /api/auth/me returned ${me.status}`);
    assert(dashboard.status === 401 || dashboard.status === 403, `unauthenticated /api/dashboard returned ${dashboard.status}`);
  }

  const pluginPath = path.join(ROOT, family.PLUGIN_DIR);
  const present = fs.existsSync(path.join(pluginPath, 'plugin.json'));
  assert(present === expected.serverAccessPlugin, `Server Access Control present=${present} expected=${expected.serverAccessPlugin}`);

  if (expected.serverAccessPlugin) {
    const availability = await request('/api/server-access/availability');
    assert(availability.status === 200, `/api/server-access/availability returned ${availability.status}`);
  } else {
    const availability = await request('/api/server-access/availability');
    if (availability.status === 200) {
      assert(availability.json?.available === false, 'Server Access Control must be unavailable when the plugin is absent');
    }
  }

  process.stdout.write(`ci-edition-health: ${expected.version} ${expected.securityProfile} ok\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`ci-edition-health: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { main };
