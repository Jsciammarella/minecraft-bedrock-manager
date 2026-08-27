const logger = require('../services/logger');
const productIdentity = require('../services/productIdentity');
const productConfig = require('./productConfig');

const PROFILE_NO_AUTH = 'no-auth';
const PROFILE_LOCAL_RBAC = 'local-rbac';
const KNOWN_PROFILES = new Set([PROFILE_NO_AUTH, PROFILE_LOCAL_RBAC]);

const EDITION_BASELINE = 0;
const EDITION_OPEN_SOURCE = 3;
const EDITION_PRO = 6;
const EDITION_ENTERPRISE = 9;
const SUPPORTED_PATCHES = new Set([
  EDITION_BASELINE,
  EDITION_OPEN_SOURCE,
  EDITION_PRO,
  EDITION_ENTERPRISE,
]);

function parseVersionParts(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return { major: 0, minor: 0, patch: 0 };
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function editionPatch(version = productIdentity.productVersion()) {
  return parseVersionParts(version).patch;
}

function isSupportedEditionPatch(patch) {
  return SUPPORTED_PATCHES.has(Number(patch));
}

function unsupportedEditionError(version) {
  const err = new Error(
    `Unsupported product version "${version}". Trusted editions use patch suffixes .0 (baseline), .3 (open-source), .6 (Pro), or .9 (Enterprise).`
  );
  err.code = 'SECURITY_PROFILE_INVALID';
  return err;
}

function defaultProfileForPatch(patch) {
  if (patch === EDITION_BASELINE || patch === EDITION_OPEN_SOURCE) return PROFILE_NO_AUTH;
  if (patch === EDITION_PRO || patch === EDITION_ENTERPRISE) return PROFILE_LOCAL_RBAC;
  return null;
}

function normalizeProfile(value) {
  const profile = String(value || '').trim().toLowerCase();
  return KNOWN_PROFILES.has(profile) ? profile : null;
}

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function locksProfile(patch) {
  return patch === EDITION_PRO || patch === EDITION_ENTERPRISE;
}

function expectsServerAccessPlugin(patch) {
  return Number(patch) === EDITION_ENTERPRISE;
}

function githubMirrorEligible(patch) {
  return Number(patch) === EDITION_OPEN_SOURCE;
}

function trustedProfile(version = productIdentity.productVersion()) {
  const configured = normalizeProfile(productConfig.securityProfile);
  if (configured) return configured;
  const profile = defaultProfileForPatch(editionPatch(version));
  if (!profile) throw unsupportedEditionError(version);
  return profile;
}

/**
 * Resolve the active security profile from trusted product identity.
 * Development/test may override with MBM_SECURITY_PROFILE when NODE_ENV is
 * not production. Production .6/.9 packages ignore environment overrides
 * and never fall back to no-auth. Unsupported suffixes fail startup.
 */
function resolveProfile({ version = productIdentity.productVersion(), env = process.env } = {}) {
  const patch = editionPatch(version);
  const override = normalizeProfile(env.MBM_SECURITY_PROFILE);
  const production = String(env.NODE_ENV || '').toLowerCase() === 'production';

  if (override && !production) {
    return { profile: override, source: 'development-override', patch, locked: false };
  }

  if (!isSupportedEditionPatch(patch) && !normalizeProfile(productConfig.securityProfile)) {
    throw unsupportedEditionError(version);
  }

  const trusted = trustedProfile(version);
  if (override && production) {
    logger.warn('Ignoring MBM_SECURITY_PROFILE in production; using trusted product security profile');
  }
  return { profile: trusted, source: 'trusted', patch, locked: locksProfile(patch) };
}

function assertProfileStartable(selection, { providers } = {}) {
  const { profile, patch } = selection;
  const known = KNOWN_PROFILES.has(profile);
  const provider = providers && typeof providers.has === 'function' ? providers.get(profile) : null;
  const missing = !known || !provider;

  if (!missing) return;

  const detail = !known
    ? `Unknown security profile "${profile}"`
    : `Security provider "${profile}" is missing or invalid`;

  if (locksProfile(patch) || profile !== PROFILE_NO_AUTH) {
    const err = new Error(
      `${detail}. ${locksProfile(patch) ? 'This edition cannot start without a valid local-rbac provider.' : 'Refusing to start.'} No-auth will not be selected as a fallback.`
    );
    err.code = 'SECURITY_PROFILE_INVALID';
    throw err;
  }

  const err = new Error(`${detail}. Refusing to start.`);
  err.code = 'SECURITY_PROFILE_INVALID';
  throw err;
}

function expectedInventory(version = productIdentity.productVersion()) {
  const patch = editionPatch(version);
  if (!isSupportedEditionPatch(patch)) throw unsupportedEditionError(version);
  const profile = defaultProfileForPatch(patch);
  return {
    version: String(version || '').trim(),
    patch,
    securityProfile: profile,
    authenticationRequired: profile === PROFILE_LOCAL_RBAC,
    userManagement: profile === PROFILE_LOCAL_RBAC,
    serverAccessPlugin: expectsServerAccessPlugin(patch),
    githubMirror: githubMirrorEligible(patch),
    baseline: patch === EDITION_BASELINE,
    productEdition: patch !== EDITION_BASELINE,
  };
}

module.exports = {
  PROFILE_NO_AUTH,
  PROFILE_LOCAL_RBAC,
  KNOWN_PROFILES,
  EDITION_BASELINE,
  EDITION_OPEN_SOURCE,
  EDITION_PRO,
  EDITION_ENTERPRISE,
  SUPPORTED_PATCHES,
  editionPatch,
  defaultProfileForPatch,
  isSupportedEditionPatch,
  normalizeProfile,
  isProduction,
  locksProfile,
  expectsServerAccessPlugin,
  githubMirrorEligible,
  trustedProfile,
  resolveProfile,
  assertProfileStartable,
  expectedInventory,
  unsupportedEditionError,
};
