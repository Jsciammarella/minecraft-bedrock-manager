#!/usr/bin/env node
/**
 * Validate a 0.5.x-style edition against trusted product identity.
 *
 * Usage:
 *   node scripts/verify-release-family.js
 *   node scripts/verify-release-family.js --version 0.5.9
 *   node scripts/verify-release-family.js --print-profile
 *   node scripts/verify-release-family.js --print-json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const productConfig = require('../server/security/productConfig');
const profiles = require('../server/security/profiles');

const PLUGIN_DIR = 'server/bundled-plugins/server-access-control';

function parseArgs(argv) {
  const out = { version: null, printProfile: false, printJson: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version' || arg === '-v') {
      out.version = String(argv[i + 1] || '').trim();
      i += 1;
    } else if (arg.startsWith('--version=')) {
      out.version = arg.slice('--version='.length).trim();
    } else if (arg === '--print-profile') {
      out.printProfile = true;
    } else if (arg === '--print-json' || arg === '--json') {
      out.printJson = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function fail(message) {
  const err = new Error(message);
  err.code = 'RELEASE_FAMILY_INVALID';
  throw err;
}

function releaseBranchVersion(branch) {
  const match = String(branch || '').trim().match(/^release\/(\d+\.\d+\.\d+)$/);
  return match ? match[1] : null;
}

function pluginPresent() {
  return fs.existsSync(path.join(ROOT, PLUGIN_DIR, 'plugin.json'));
}

function configuredProfile() {
  return profiles.normalizeProfile(productConfig.securityProfile);
}

function inventoryFor(version) {
  let expected;
  try {
    expected = profiles.expectedInventory(version);
  } catch (err) {
    fail(err.message);
  }
  return expected;
}

function validate(version, { branch, versionOverridden = false } = {}) {
  const expected = inventoryFor(version);
  const errors = [];
  const packageVersion = String(pkg.version || '').trim();

  if (!versionOverridden && packageVersion !== expected.version) {
    errors.push(`package.json version ${packageVersion} does not match inventory version ${expected.version}`);
  }

  const branchVersion = releaseBranchVersion(branch);
  if (branchVersion && !versionOverridden && branchVersion !== packageVersion) {
    errors.push(`release branch ${branch} does not match package version ${packageVersion}`);
  }
  if (branchVersion && versionOverridden && branchVersion !== expected.version) {
    errors.push(`release branch ${branch} does not match requested version ${expected.version}`);
  }

  const configured = configuredProfile();
  if (configured && configured !== expected.securityProfile) {
    errors.push(`productConfig.securityProfile is ${configured} but ${expected.version} requires ${expected.securityProfile}`);
  }

  if (expected.securityProfile === 'no-auth' && configured === 'local-rbac') {
    errors.push(`${expected.version} cannot use Local RBAC`);
  }
  if (expected.securityProfile === 'local-rbac' && configured === 'no-auth') {
    errors.push(`${expected.version} cannot use no-auth`);
  }

  const hasPlugin = pluginPresent();
  if (expected.serverAccessPlugin && !hasPlugin) {
    errors.push(`${expected.version} must include ${PLUGIN_DIR}`);
  }
  if (!expected.serverAccessPlugin && hasPlugin) {
    errors.push(`${expected.version} must not include the Enterprise Server Access Control plugin`);
  }

  if (expected.patch === profiles.EDITION_OPEN_SOURCE && expected.securityProfile !== 'no-auth') {
    errors.push('.3 editions must use the no-auth profile');
  }
  if (expected.patch === profiles.EDITION_PRO && expected.securityProfile !== 'local-rbac') {
    errors.push('.6 editions must use Local RBAC');
  }
  if (expected.patch === profiles.EDITION_ENTERPRISE && expected.securityProfile !== 'local-rbac') {
    errors.push('.9 editions must use Local RBAC');
  }
  if (expected.patch === profiles.EDITION_PRO && hasPlugin) {
    errors.push('.6 must not contain Server Access Control');
  }
  if (expected.patch === profiles.EDITION_ENTERPRISE && !hasPlugin) {
    errors.push('.9 must contain Server Access Control');
  }
  if (expected.githubMirror && expected.patch !== profiles.EDITION_OPEN_SOURCE) {
    errors.push('only .3 editions are eligible for GitHub mirroring');
  }
  if (!expected.githubMirror && expected.patch === profiles.EDITION_OPEN_SOURCE) {
    errors.push('.3 must be eligible for GitHub mirroring');
  }

  if (errors.length) fail(errors.join('\n'));
  return {
    ...expected,
    packageVersion: pkg.version,
    productConfigProfile: configured,
    serverAccessPluginPresent: hasPlugin,
    branch: branch || null,
    ok: true,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].trim()}\n`);
    return;
  }
  const versionOverridden = Boolean(args.version);
  const version = args.version || pkg.version;
  const branch = process.env.CI_COMMIT_BRANCH || process.env.MBM_RELEASE_BRANCH || '';
  const result = validate(version, { branch, versionOverridden });
  if (args.printProfile) {
    process.stdout.write(`${result.securityProfile}\n`);
    return;
  }
  if (args.printJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`verify-release-family: ${result.version} ${result.securityProfile} ok\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`verify-release-family: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  PLUGIN_DIR,
  pluginPresent,
  inventoryFor,
  validate,
  releaseBranchVersion,
};
