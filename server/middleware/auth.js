const auth = require('../services/authService');
const catalog = require('../services/permissionCatalog');
const serverManager = require('../services/serverManager');

function deny(res, status, message) {
  return res.status(status).json({ error: message });
}

function attachUser(req, res, next) {
  const token = auth.tokenFromRequest(req);
  const user = auth.getSessionUser(token);
  if (!user) return deny(res, 401, 'Authentication required');
  req.user = user;
  req.sessionToken = token;
  next();
}

function optionalUser(req, _res, next) {
  const token = auth.tokenFromRequest(req);
  req.user = auth.getSessionUser(token);
  req.sessionToken = token;
  next();
}

function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user) return deny(res, 401, 'Authentication required');
    if (!auth.hasPermission(req.user, key)) {
      return deny(res, 403, 'You do not have permission to do that');
    }
    next();
  };
}

function requireAnyPermission(...keys) {
  return (req, res, next) => {
    if (!req.user) return deny(res, 401, 'Authentication required');
    if (keys.some((key) => auth.hasPermission(req.user, key))) return next();
    return deny(res, 403, 'You do not have permission to do that');
  };
}

function requireAdmin(req, res, next) {
  if (!req.user) return deny(res, 401, 'Authentication required');
  if (!req.user.isAdmin) return deny(res, 403, 'Administrator access required');
  next();
}

function requireUserManagement(req, res, next) {
  if (!req.user) return deny(res, 401, 'Authentication required');
  if (!auth.canAccessUserManagement(req.user)) {
    return deny(res, 403, 'You do not have permission to manage users');
  }
  next();
}

function assertPermission(req, key) {
  if (!auth.hasPermission(req.user, key)) {
    const err = new Error('You do not have permission to do that');
    err.status = 403;
    throw err;
  }
}

function requireServerStart(req, res, next) {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return deny(res, 404, 'Server not found');
    assertPermission(req, catalog.startPermissionForKind(server.kind));
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
    assertPermission(req, catalog.stopPermissionForKind(server.kind));
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
    assertPermission(req, catalog.startPermissionForKind(server.kind));
    assertPermission(req, catalog.stopPermissionForKind(server.kind));
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
    for (const key of needed) assertPermission(req, key);
    req.server = server;
    next();
  } catch (err) {
    return deny(res, err.status || 400, err.message);
  }
}

function isPublicApiPath(req) {
  const path = req.path || '';
  if (req.method === 'GET' && (path === '/api/health' || path === '/health')) return true;
  if (req.method === 'POST' && (path === '/api/auth/login' || path === '/auth/login')) return true;
  return false;
}

module.exports = {
  attachUser,
  optionalUser,
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
