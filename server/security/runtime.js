const logger = require('../services/logger');
const catalog = require('../services/permissionCatalog');
const profiles = require('./profiles');
const principal = require('./principal');
const errors = require('./errors');
const audit = require('./audit');

const PROVIDER_MODULES = {
  [profiles.PROFILE_NO_AUTH]: './providers/noAuth',
  [profiles.PROFILE_LOCAL_RBAC]: './providers/localRbac',
};

function loadTrustedProvider(profile) {
  const rel = PROVIDER_MODULES[profile];
  if (!rel) return null;
  try {
    return require(rel);
  } catch (err) {
    logger.error(`Could not load security provider "${profile}": ${err.message}`);
    return null;
  }
}

function providerRegistry(profile, options = {}) {
  if (options.providers) return options.providers;
  const map = new Map();
  const Ctor = loadTrustedProvider(profile);
  if (Ctor) map.set(profile, Ctor);
  return map;
}

function createRuntime(options = {}) {
  const selection = options.selection || profiles.resolveProfile({
    version: options.version,
    env: options.env,
  });
  const registry = providerRegistry(selection.profile, options);
  profiles.assertProfileStartable(selection, { providers: registry });

  const Ctor = registry.get(selection.profile);
  if (typeof Ctor !== 'function') {
    const err = new Error(`Security provider "${selection.profile}" is missing or invalid. No-auth will not be selected as a fallback.`);
    err.code = 'SECURITY_PROFILE_INVALID';
    throw err;
  }

  const provider = new Ctor();
  if (!provider || typeof provider.authenticate !== 'function' || typeof provider.authorize !== 'function') {
    const err = new Error(`Security provider "${selection.profile}" is invalid. No-auth will not be selected as a fallback.`);
    err.code = 'SECURITY_PROFILE_INVALID';
    throw err;
  }

  if (typeof provider.init === 'function') provider.init();

  logger.info(`Security profile: ${selection.profile} (source: ${selection.source})`);

  const runtime = {
    profile: selection.profile,
    source: selection.source,
    patch: selection.patch,
    provider,

    authenticate(request) {
      return provider.authenticate(request || {});
    },

    getCurrentPrincipal(request) {
      if (typeof provider.getCurrentPrincipal === 'function') {
        return provider.getCurrentPrincipal(request || {});
      }
      return provider.authenticate(request || {}).principal;
    },

    authorize(current, action, resource, context) {
      return Boolean(provider.authorize(current, action, resource, context));
    },

    requirePermission(current, action, resource, context) {
      if (!current || current.authenticated === false) {
        throw errors.unauthorized();
      }
      if (!provider.authorize(current, action, resource, context)) {
        throw errors.permissionRequired(action);
      }
      return true;
    },

    hasPermission(current, action, resource, context) {
      return runtime.authorize(current, action, resource, context);
    },

    isAdministrator(current) {
      if (!current || current.authenticated === false) return false;
      if (typeof provider.authorize === 'function' && provider.authorize(current, 'admin')) return true;
      return Boolean(current.isAdmin);
    },

    getCapabilities(current, context) {
      if (typeof provider.getCapabilities === 'function') {
        return provider.getCapabilities(current, context);
      }
      return {
        securityProfile: selection.profile,
        authenticationRequired: selection.profile !== profiles.PROFILE_NO_AUTH,
        needsBootstrap: false,
        features: {
          userManagement: Boolean(provider.supports('userManagement')),
          roleManagement: Boolean(provider.supports('roleManagement')),
        },
        permissions: [],
      };
    },

    publicInfo() {
      const caps = runtime.getCapabilities(null);
      return {
        securityProfile: selection.profile,
        authenticationRequired: Boolean(caps.authenticationRequired),
        needsBootstrap: Boolean(caps.needsBootstrap),
        features: caps.features || {
          userManagement: runtime.supports('userManagement'),
          roleManagement: runtime.supports('roleManagement'),
        },
        networkWarning: Boolean(caps.networkWarning),
      };
    },

    supports(feature) {
      return Boolean(provider.supports && provider.supports(feature));
    },

    createSystemPrincipal(reason) {
      return principal.systemPrincipal(reason);
    },

    audit(event, extra = {}) {
      audit.record(event, extra);
    },

    actorName(current) {
      return principal.actorName(current);
    },

    publicPrincipal(current) {
      return principal.publicPrincipal(current);
    },

    startPermissionForKind(kind) {
      return catalog.startPermissionForKind(kind);
    },

    stopPermissionForKind(kind) {
      return catalog.stopPermissionForKind(kind);
    },

    syncDynamicPermissions() {
      if (typeof provider.syncDynamicPermissions === 'function') {
        provider.syncDynamicPermissions();
      }
    },
  };

  return runtime;
}

let singleton = null;

function getRuntime() {
  if (!singleton) singleton = createRuntime();
  return singleton;
}

function setRuntime(runtime) {
  singleton = runtime;
  return singleton;
}

function resetRuntime() {
  singleton = null;
}

function ensureReady() {
  return getRuntime();
}

module.exports = {
  createRuntime,
  getRuntime,
  setRuntime,
  resetRuntime,
  ensureReady,
  loadTrustedProvider,
};
