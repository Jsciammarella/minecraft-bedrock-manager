const catalog = require('../services/permissionCatalog');
const decision = require('./decision');
const { isSystemPrincipal } = require('./principal');

function canonicalKey(action) {
  const key = String(action || '');
  return typeof catalog.canonicalPermission === 'function'
    ? catalog.canonicalPermission(key)
    : key;
}

function isPermissionActive(key) {
  const def = catalog.permissionByKey(key);
  if (def && def.active === false && !def.deprecated) return false;
  return true;
}

function globalSources(principal, key) {
  const auth = require('../services/authService');
  if (typeof auth.collectGlobalSources === 'function') {
    const fromDb = auth.collectGlobalSources(principal, key) || [];
    const hasRow = principal?.id != null && typeof auth.getUserRow === 'function' && auth.getUserRow(principal.id);
    if (hasRow) return fromDb;
    if (fromDb.length) return fromDb;
  }
  const perms = Array.isArray(principal?.permissions) ? principal.permissions : [];
  if (perms.includes(key) || perms.includes(canonicalKey(key))) {
    return [decision.source({
      origin: 'session',
      scope: 'global',
      value: decision.ALLOW,
      permission: key,
    })];
  }
  return [];
}

function decide(principal, action, resource, context = {}) {
  const permission = canonicalKey(action);
  const normalized = decision.normalizeResource(resource);

  if (!principal || principal.authenticated === false || principal.isActive === false) {
    return decision.defaultDeny(permission, normalized);
  }
  if (isSystemPrincipal(principal) || principal.isAdmin) {
    return decision.administrator(permission, normalized);
  }

  const globals = globalSources(principal, permission);
  if (!normalized || normalized.type !== 'server') {
    return decision.finalize(decision.combine(permission, normalized, globals));
  }

  const registry = require('../services/resourceAuthorizationRegistry');
  const state = require('../services/resourceAuthorizationState');
  if (state.failClosed('server', principal)) {
    const src = decision.source({
      origin: 'provider-failure',
      scope: 'server',
      value: decision.DENY,
      permission,
    });
    return decision.result({
      decision: decision.DENY,
      permission,
      resourceType: 'server',
      resourceId: normalized.id,
      sources: [...globals, src],
      winningSource: src,
    });
  }

  const provider = registry.get('server');
  if (!provider) {
    return decision.finalize(decision.combine(permission, normalized, globals));
  }

  const scoped = typeof provider.collectSources === 'function'
    ? (provider.collectSources(principal, permission, normalized, context) || [])
    : [];
  const membership = typeof provider.inspectMembership === 'function'
    ? provider.inspectMembership(principal, normalized, context)
    : { accessMode: 'inherited', assigned: true };

  if (membership && membership.accessMode === 'restricted' && !membership.assigned) {
    const src = decision.source({
      origin: 'restricted-membership',
      scope: 'server',
      value: decision.DENY,
      permission,
    });
    return decision.result({
      decision: decision.DENY,
      permission,
      resourceType: 'server',
      resourceId: normalized.id,
      sources: [...globals, ...scoped, src],
      winningSource: src,
    });
  }

  const combined = decision.combine(permission, normalized, [...globals, ...scoped]);
  if (!isPermissionActive(permission) && combined.decision === decision.ALLOW) {
    return decision.defaultDeny(permission, normalized, combined.sources);
  }
  return decision.finalize(combined);
}

function allowed(principal, action, resource, context) {
  return decide(principal, action, resource, context).decision === decision.ALLOW;
}

module.exports = {
  canonicalKey,
  decide,
  allowed,
  isPermissionActive,
};
