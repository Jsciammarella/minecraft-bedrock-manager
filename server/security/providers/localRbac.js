const catalog = require('../../services/permissionCatalog');
const { publicPrincipal, isSystemPrincipal } = require('../principal');
const { PROFILE_LOCAL_RBAC } = require('../profiles');
const { isRecognized, denyUnknown, isPluginAction } = require('../recognized');
const audit = require('../audit');

function auth() {
  return require('../../services/authService');
}

const SETTINGS_KEYS = {
  'catalog-curseforge': 'catalog.set_curseforge_key',
  'catalog-git': 'catalog.enable_git',
  'catalog-file': 'catalog.enable_file',
};

function LocalRbacProvider() {
  this.id = PROFILE_LOCAL_RBAC;
}

LocalRbacProvider.prototype.init = function init() {
  auth().ensureSeed();
  auth().syncDynamicPermissions();
};

LocalRbacProvider.prototype.supports = function supports(feature) {
  return feature === 'userManagement'
    || feature === 'roleManagement'
    || feature === 'authentication'
    || feature === 'sessions'
    || feature === 'passwordManagement';
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

LocalRbacProvider.prototype.authorize = function authorize(principal, action, _resource, context = {}) {
  const key = String(action || '');
  if (!principal || principal.authenticated === false || principal.isActive === false) return false;

  if (!isRecognized(key) && !isPluginAction(key)) {
    return denyUnknown(key, this.id);
  }

  if (isSystemPrincipal(principal)) return true;

  if (key === 'admin') return Boolean(principal.isAdmin);

  if (key === 'gateway:lifecycle') {
    return auth().hasPermission(principal, 'servers.start')
      && auth().hasPermission(principal, 'servers.stop');
  }

  if (key === 'catalog:settings:view') {
    const mapped = SETTINGS_KEYS[String(context.pluginId || '')];
    if (mapped) return auth().hasPermission(principal, mapped);
    return Boolean(principal.isAdmin);
  }

  if (!auth().hasPermission(principal, key)) return false;
  return true;
};

LocalRbacProvider.prototype.getCapabilities = function getCapabilities(principal) {
  const permissions = principal && Array.isArray(principal.permissions)
    ? principal.permissions
    : [];
  const isAdmin = Boolean(principal?.isAdmin);
  return {
    securityProfile: this.id,
    authenticationRequired: true,
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

module.exports = LocalRbacProvider;
