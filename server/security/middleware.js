const catalog = require('../services/permissionCatalog');
const serverManager = require('../services/serverManager');
const errors = require('./errors');

function security() {
  return require('./runtime').getRuntime();
}

function deny(res, status, message) {
  return res.status(status).json({ error: message });
}

function fail(res, err) {
  return deny(res, err.status || 403, err.message);
}

function attachPrincipal(req, res, next) {
  try {
    const { principal, sessionToken } = security().authenticate(req);
    if (!principal) return deny(res, 401, 'Authentication required');
    req.principal = principal;
    req.user = principal;
    req.sessionToken = sessionToken;
    next();
  } catch (err) {
    return fail(res, err);
  }
}

function optionalPrincipal(req, _res, next) {
  const { principal, sessionToken } = security().authenticate(req);
  req.principal = principal || null;
  req.user = principal || null;
  req.sessionToken = sessionToken;
  next();
}

function resolveResource(req, options) {
  if (options == null) return undefined;
  if (typeof options === 'function') return options(req);
  if (typeof options.resource === 'function') return options.resource(req);
  if (Object.prototype.hasOwnProperty.call(options, 'resource')) return options.resource;
  return options;
}

function requirePermission(action, options) {
  return (req, res, next) => {
    try {
      const current = req.principal || req.user;
      if (!current) return deny(res, 401, 'Authentication required');
      const resource = resolveResource(req, options);
      security().requirePermission(current, action, resource, { req, resource });
      next();
    } catch (err) {
      return fail(res, err);
    }
  };
}

function requireAnyPermission(...keys) {
  return (req, res, next) => {
    const current = req.principal || req.user;
    if (!current) return deny(res, 401, 'Authentication required');
    if (keys.some((key) => security().authorize(current, key))) return next();
    return deny(res, 403, 'You do not have permission to do that');
  };
}

function requireAdmin(req, res, next) {
  const current = req.principal || req.user;
  if (!current) return deny(res, 401, 'Authentication required');
  if (!security().isAdministrator(current)) return deny(res, 403, 'Administrator access required');
  next();
}

function requireUserManagement(req, res, next) {
  const runtime = security();
  if (!runtime.supports('userManagement')) {
    return deny(res, 404, 'User management is not available');
  }
  const current = req.principal || req.user;
  if (!current) return deny(res, 401, 'Authentication required');
  const provider = runtime.provider;
  if (typeof provider.canAccessUserManagement === 'function') {
    if (!provider.canAccessUserManagement(current)) {
      return deny(res, 403, 'You do not have permission to manage users');
    }
    return next();
  }
  if (!runtime.isAdministrator(current)) {
    return deny(res, 403, 'You do not have permission to manage users');
  }
  next();
}

function assertPermission(req, key, resource, context) {
  const current = req.principal || req.user;
  if (!current) throw errors.unauthorized();
  require('./runtime').getRuntime().requirePermission(current, key, resource, context);
}

function requireServerStart(req, res, next) {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return deny(res, 404, 'Server not found');
    assertPermission(req, catalog.startPermissionForKind(server.kind), server);
    req.server = server;
    next();
  } catch (err) {
    return deny(res, err.status || 400, err.message);
  }
}

function requireServerStop(req, res, next) {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return deny(res, 404, 'Server not found');
    assertPermission(req, catalog.stopPermissionForKind(server.kind), server);
    req.server = server;
    next();
  } catch (err) {
    return deny(res, err.status || 400, err.message);
  }
}

function requireServerRestart(req, res, next) {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return deny(res, 404, 'Server not found');
    assertPermission(req, catalog.startPermissionForKind(server.kind), server);
    assertPermission(req, catalog.stopPermissionForKind(server.kind), server);
    req.server = server;
    next();
  } catch (err) {
    return deny(res, err.status || 400, err.message);
  }
}

function requireServerUpdate(req, res, next) {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return deny(res, 404, 'Server not found');
    const needed = catalog.requiredServerUpdatePermissions(server, req.body || {});
    for (const key of needed) assertPermission(req, key, server);
    req.server = server;
    next();
  } catch (err) {
    return deny(res, err.status || 400, err.message);
  }
}

function isPublicApiPath(req) {
  const path = req.path || '';
  if (req.method === 'GET' && (path === '/api/health' || path === '/health' || path === '/api/system' || path === '/system')) return true;
  if (req.method === 'GET' && (path === '/api/auth/password-policy' || path === '/auth/password-policy')) return true;
  if (req.method === 'GET' && (path === '/api/auth/security' || path === '/auth/security')) return true;
  if (req.method === 'GET' && (path === '/api/auth/bootstrap-status' || path === '/auth/bootstrap-status')) return true;
  if (req.method === 'POST' && (path === '/api/auth/login' || path === '/auth/login')) return true;
  if (req.method === 'POST' && (path === '/api/auth/bootstrap' || path === '/auth/bootstrap')) return true;
  if (req.method === 'POST' && (path === '/api/auth/logout' || path === '/auth/logout')) return true;
  return false;
}

module.exports = {
  attachPrincipal,
  attachUser: attachPrincipal,
  optionalPrincipal,
  optionalUser: optionalPrincipal,
  requirePermission,
  requireAnyPermission,
  requireAdmin,
  requireUserManagement,
  requireServerStart,
  requireServerStop,
  requireServerRestart,
  requireServerUpdate,
  assertPermission,
  isPublicApiPath,
  deny,
};
