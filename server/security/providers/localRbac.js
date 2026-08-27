const catalog = require('../../services/permissionCatalog');
const { publicPrincipal, isSystemPrincipal } = require('../principal');
const { PROFILE_LOCAL_RBAC } = require('../profiles');
const { isRecognized, denyUnknown } = require('../recognized');
const { supportsCore, supportsRbac } = require('../features');
const audit = require('../audit');

function auth() {
  return require('../../services/authService');
}

function LocalRbacProvider() {
  this.id = PROFILE_LOCAL_RBAC;
}

LocalRbacProvider.prototype.init = function init() {
  const service = auth();
  service.ensureSeed();
  service.syncDynamicPermissions();
  if (service.needsAdministratorBootstrap()) {
    const logger = require('../../services/logger');
    logger.warn('No administrator account exists. Complete /api/auth/bootstrap before signing in.');
  }
};

LocalRbacProvider.prototype.supports = function supports(feature) {
  return supportsCore(feature) || supportsRbac(feature);
};

LocalRbacProvider.prototype.authenticate = function authenticate(request) {
  const token = auth().tokenFromRequest(request || {});
  const user = auth().getSessionUser(token);
  if (!user) return { principal: null, sessionToken: token || '' };
  return {
    principal: {
      ...user,
      type: 'user',
      authenticated: true,
    },
    sessionToken: token,
  };
};

LocalRbacProvider.prototype.getCurrentPrincipal = function getCurrentPrincipal(request) {
  return this.authenticate(request).principal;
};

LocalRbacProvider.prototype.decide = function decide(principal, action, resource, context = {}) {
  const evaluate = require('../evaluate');
  const decision = require('../decision');
  const key = String(action || '');
  if (!principal || principal.authenticated === false || principal.isActive === false) {
    return decision.defaultDeny(key, resource);
  }
  if (!isRecognized(key)) {
    denyUnknown(key, this.id);
    return decision.defaultDeny(key, resource);
  }
  if (isSystemPrincipal(principal)) return decision.administrator(key, resource);
  if (key === 'admin') {
    return principal.isAdmin
      ? decision.administrator(key, resource)
      : decision.defaultDeny(key, resource);
  }
  if (key === 'gateway:lifecycle') {
    const start = evaluate.decide(principal, 'servers.start_java', resource, context);
    const stop = evaluate.decide(principal, 'servers.stop_java', resource, context);
    return start.decision === 'allow' && stop.decision === 'allow'
      ? start
      : decision.defaultDeny(key, resource, [...start.sources, ...stop.sources]);
  }
  return evaluate.decide(principal, key, resource, context);
};

LocalRbacProvider.prototype.authorize = function authorize(principal, action, resource, context = {}) {
  return this.decide(principal, action, resource, context).decision === 'allow';
};

LocalRbacProvider.prototype.getCapabilities = function getCapabilities(principal) {
  const permissions = principal && Array.isArray(principal.permissions)
    ? principal.permissions
    : [];
  const isAdmin = Boolean(principal?.isAdmin);
  return {
    securityProfile: this.id,
    authenticationRequired: true,
    needsBootstrap: auth().needsAdministratorBootstrap(),
    features: {
      userManagement: true,
      roleManagement: true,
      passwordManagement: true,
    },
    permissions: isAdmin ? catalog.listKeys() : permissions,
    principal: publicPrincipal(principal),
  };
};

LocalRbacProvider.prototype.login = function login(username, password) {
  try {
    const result = auth().login(username, password);
    audit.record('auth.login.success', {
      principal: { username: result.user.username, id: result.user.id, type: 'user' },
    });
    return result;
  } catch (err) {
    audit.record('auth.login.failure', {
      principal: { username: String(username || ''), type: 'user' },
      detail: { error: err.message },
    });
    throw err;
  }
};

LocalRbacProvider.prototype.logout = function logout(token) {
  auth().destroySession(token);
};

LocalRbacProvider.prototype.syncDynamicPermissions = function syncDynamicPermissions() {
  auth().syncDynamicPermissions();
};

LocalRbacProvider.prototype.cookieHeader = function cookieHeader(token, maxAge) {
  return auth().cookieHeader(token, maxAge);
};

LocalRbacProvider.prototype.clearCookieHeader = function clearCookieHeader() {
  return auth().clearCookieHeader();
};

LocalRbacProvider.prototype.tokenFromRequest = function tokenFromRequest(req) {
  return auth().tokenFromRequest(req);
};

LocalRbacProvider.prototype.getPasswordPolicy = function getPasswordPolicy() {
  return auth().getPasswordPolicy();
};

LocalRbacProvider.prototype.setPassword = function setPassword(userId, password, opts) {
  return auth().setPassword(userId, password, opts);
};

LocalRbacProvider.prototype.getUserRow = function getUserRow(id) {
  return auth().getUserRow(id);
};

LocalRbacProvider.prototype.verifyPassword = function verifyPassword(password, stored) {
  return auth().verifyPassword(password, stored);
};

LocalRbacProvider.prototype.canAccessUserManagement = function canAccessUserManagement(principal) {
  return auth().canAccessUserManagement(principal);
};

LocalRbacProvider.prototype.needsAdministratorBootstrap = function needsAdministratorBootstrap() {
  return auth().needsAdministratorBootstrap();
};

LocalRbacProvider.prototype.bootstrapAdministrator = function bootstrapAdministrator(input) {
  return auth().bootstrapAdministrator(input);
};

module.exports = LocalRbacProvider;
