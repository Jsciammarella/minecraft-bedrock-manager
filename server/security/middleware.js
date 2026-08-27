const catalog = require('../services/permissionCatalog');
const serverManager = require('../services/serverManager');
const errors = require('./errors');

function security() {
  return require('./runtime').getRuntime();
}

function deny(res, status, message, extra = {}) {
  const body = { error: message };
  if (extra.code) body.code = extra.code;
  if (extra.permission) body.permission = extra.permission;
  return res.status(status).json(body);
}

function fail(res, err) {
  return deny(res, err.status || 403, err.message, {
    code: err.code,
    permission: err.permission,
  });
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
  if (options == null) {
    if (req.resource) return req.resource;
    if (req.server) return req.server;
    return undefined;
  }
  if (typeof options === 'function') return options(req);
  if (typeof options.resource === 'function') return options.resource(req);
  if (Object.prototype.hasOwnProperty.call(options, 'resource')) return options.resource;
  return options;
}

function serverNotFoundBody() {
  return { error: 'Server not found', code: 'NOT_FOUND' };
}

function isHiddenServer(principal, server) {
  if (!server) return true;
  if (!principal) return true;
  try {
    if (security().isAdministrator(principal)) return false;
    return !security().authorize(principal, 'servers.view', server)
      && !security().authorize(principal, 'servers.view_details', server);
  } catch {
    return true;
  }
}

function failServer(res, req, err) {
  const current = req.principal || req.user;
  const server = req.server;
  if (err?.code === 'PERMISSION_REQUIRED' && isHiddenServer(current, server)) {
    return res.status(404).json(serverNotFoundBody());
  }
  if (err?.status === 404) return deny(res, 404, err.message || 'Server not found', { code: err.code || 'NOT_FOUND' });
  return fail(res, err);
}

function attachServerResource(req, server) {
  req.server = server;
  req.resource = { type: 'server', id: server.id, kind: server.kind };
  return server;
}

function lookupServer(req, param = 'id') {
  const raw = req.params?.[param] ?? req.params?.serverId;
  const javaHostingPolicy = require('../services/javaHostingPolicy');
  const server = serverManager.getServer(raw);
  if (!server) return null;
  try {
    javaHostingPolicy.assertServerVisible(server);
  } catch {
    return null;
  }
  return server;
}

function resolveServerResource(param = 'id') {
  return (req, res, next) => {
    try {
      const server = lookupServer(req, param);
      if (!server) return res.status(404).json(serverNotFoundBody());
      attachServerResource(req, server);
      next();
    } catch (err) {
      return failServer(res, req, err);
    }
  };
}

function requireServerVisible(req, res, next) {
  try {
    const current = req.principal || req.user;
    if (!current) return deny(res, 401, 'Authentication required');
    const server = req.server || lookupServer(req);
    if (!server) return res.status(404).json(serverNotFoundBody());
    attachServerResource(req, server);
    if (isHiddenServer(current, server)) return res.status(404).json(serverNotFoundBody());
    next();
  } catch (err) {
    return failServer(res, req, err);
  }
}

function requireServerPermission(action, options = {}) {
  return (req, res, next) => {
    try {
      const current = req.principal || req.user;
      if (!current) return deny(res, 401, 'Authentication required');
      const server = req.server || lookupServer(req, options.param || 'id');
      if (!server) return res.status(404).json(serverNotFoundBody());
      attachServerResource(req, server);
      if (isHiddenServer(current, server)) return res.status(404).json(serverNotFoundBody());
      const key = typeof action === 'function' ? action(req, server) : action;
      if (key) security().requirePermission(current, key, server, { req, resource: server });
      next();
    } catch (err) {
      return failServer(res, req, err);
    }
  };
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
    const resource = resolveResource(req);
    if (keys.some((key) => security().authorize(current, key, resource))) return next();
    return deny(res, 403, 'You do not have permission to do that', {
      code: 'PERMISSION_REQUIRED',
      permission: keys[0],
    });
  };
}

function requireAllPermissions(...keys) {
  return (req, res, next) => {
    try {
      const current = req.principal || req.user;
      if (!current) return deny(res, 401, 'Authentication required');
      const resource = resolveResource(req);
      for (const key of keys) {
        security().requirePermission(current, key, resource, { req, resource });
      }
      next();
    } catch (err) {
      return fail(res, err);
    }
  };
}

const ROUTE_DECLARATIONS = [];

function securedRoute(router, spec, handler) {
  const method = String(spec.method || 'get').toLowerCase();
  const permissions = spec.permissions || (spec.permission ? [spec.permission] : []);
  ROUTE_DECLARATIONS.push({
    method: method.toUpperCase(),
    path: spec.path,
    route: spec.route,
    permissions,
    action: spec.action,
    permissionMode: spec.permissionMode || (permissions.length > 1 ? 'composite' : 'static'),
    permissionResolver: spec.permissionResolver || spec.resolver || null,
    risk: spec.risk || null,
  });
  const middleware = [];
  if (spec.permissionMode !== 'dynamic' && spec.permissionMode !== 'field-mapped' && spec.permissionMode !== 'kind-specific') {
    if (permissions.length === 1) middleware.push(requirePermission(permissions[0]));
    else if (permissions.length > 1) middleware.push(requireAllPermissions(...permissions));
  }
  router[method](spec.path, ...middleware, handler);
  return router;
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
    const javaHostingPolicy = require('../services/javaHostingPolicy');
    const bedrockConnectPolicy = require('../services/bedrockConnectPolicy');
    if (server.kind === 'bedrock_connect') {
      bedrockConnectPolicy.assertAvailable('start');
    } else {
      javaHostingPolicy.assertServerVisible(server);
    }
    attachServerResource(req, server);
    assertPermission(req, catalog.startPermissionForKind(server.kind), server);
    next();
  } catch (err) {
    if (err.code && err.code !== 'PERMISSION_REQUIRED') {
      return res.status(err.status || 409).json({ error: err.message, code: err.code, plugin: err.plugin });
    }
    return failServer(res, req, err);
  }
}

function requireServerStop(req, res, next) {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return deny(res, 404, 'Server not found');
    const javaHostingPolicy = require('../services/javaHostingPolicy');
    const bedrockConnectPolicy = require('../services/bedrockConnectPolicy');
    if (server.kind === 'bedrock_connect') {
      bedrockConnectPolicy.assertAvailable('stop');
    } else {
      javaHostingPolicy.assertServerVisible(server);
    }
    attachServerResource(req, server);
    assertPermission(req, catalog.stopPermissionForKind(server.kind), server);
    next();
  } catch (err) {
    if (err.code && err.code !== 'PERMISSION_REQUIRED') {
      return res.status(err.status || 409).json({ error: err.message, code: err.code, plugin: err.plugin });
    }
    return failServer(res, req, err);
  }
}

function requireServerRestart(req, res, next) {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return deny(res, 404, 'Server not found');
    const javaHostingPolicy = require('../services/javaHostingPolicy');
    const bedrockConnectPolicy = require('../services/bedrockConnectPolicy');
    attachServerResource(req, server);
    if (server.kind === 'bedrock_connect') {
      bedrockConnectPolicy.assertAvailable('restart');
      const restartKey = catalog.restartPermissionForKind(server.kind);
      if (restartKey) assertPermission(req, restartKey, server);
    } else {
      javaHostingPolicy.assertServerVisible(server);
      const restartKey = catalog.restartPermissionForKind(server.kind);
      if (restartKey) assertPermission(req, restartKey, server);
    }
    next();
  } catch (err) {
    if (err.code && err.code !== 'PERMISSION_REQUIRED') {
      return res.status(err.status || 409).json({ error: err.message, code: err.code, plugin: err.plugin });
    }
    return failServer(res, req, err);
  }
}

function requireServerRestartWithWarning(req, res, next) {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return deny(res, 404, 'Server not found');
    const javaHostingPolicy = require('../services/javaHostingPolicy');
    const bedrockConnectPolicy = require('../services/bedrockConnectPolicy');
    if (server.kind === 'bedrock_connect') {
      bedrockConnectPolicy.assertAvailable('restart');
    } else {
      javaHostingPolicy.assertServerVisible(server);
    }
    attachServerResource(req, server);
    assertPermission(req, 'servers.restart_with_warning', server);
    next();
  } catch (err) {
    if (err.code && err.code !== 'PERMISSION_REQUIRED') {
      return res.status(err.status || 409).json({ error: err.message, code: err.code, plugin: err.plugin });
    }
    return failServer(res, req, err);
  }
}

function requireServerCancelRestart(req, res, next) {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return deny(res, 404, 'Server not found');
    const javaHostingPolicy = require('../services/javaHostingPolicy');
    if (server.kind !== 'bedrock_connect') javaHostingPolicy.assertServerVisible(server);
    attachServerResource(req, server);
    assertPermission(req, 'servers.cancel_scheduled_restart', server);
    next();
  } catch (err) {
    if (err.code && err.code !== 'PERMISSION_REQUIRED') {
      return res.status(err.status || 409).json({ error: err.message, code: err.code, plugin: err.plugin });
    }
    return failServer(res, req, err);
  }
}

function requireServerUpdate(req, res, next) {
  try {
    const server = serverManager.getServer(req.params.id);
    if (!server) return deny(res, 404, 'Server not found');
    const javaHostingPolicy = require('../services/javaHostingPolicy');
    const bedrockConnectPolicy = require('../services/bedrockConnectPolicy');
    if (server.kind === 'bedrock_connect') {
      bedrockConnectPolicy.assertAvailable('update');
    } else {
      javaHostingPolicy.assertServerVisible(server);
    }
    const needed = catalog.requiredServerUpdatePermissions(
      server,
      req.body || {},
      catalog.currentSettingsSnapshot(server),
    );
    for (const key of needed) assertPermission(req, key, server);
    if (needed.length) {
      require('../services/logger').info(
        `Server ${server.id} settings changed by ${req.user?.username || 'unknown'}: ${needed.join(', ')}`,
      );
    }
    req.server = server;
    next();
  } catch (err) {
    if (err.code) {
      return res.status(err.status || 409).json({ error: err.message, code: err.code, plugin: err.plugin });
    }
    return fail(res, err);
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
  requireAllPermissions,
  securedRoute,
  ROUTE_DECLARATIONS,
  requireAdmin,
  requireUserManagement,
  requireServerStart,
  requireServerStop,
  requireServerRestart,
  requireServerRestartWithWarning,
  requireServerCancelRestart,
  requireServerUpdate,
  resolveServerResource,
  requireServerVisible,
  requireServerPermission,
  isHiddenServer,
  failServer,
  assertPermission,
  isPublicApiPath,
  deny,
};
