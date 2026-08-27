const catalog = require('../../services/permissionCatalog');
const { localSystemPrincipal, publicPrincipal } = require('../principal');
const { PROFILE_NO_AUTH } = require('../profiles');
const { isRecognized, denyUnknown } = require('../recognized');
const { supportsCore } = require('../features');

function NoAuthProvider() {
  this.id = PROFILE_NO_AUTH;
  this.principal = localSystemPrincipal();
}

NoAuthProvider.prototype.init = function init() {
  // Schema migrations may retain RBAC tables. This profile must not seed
  // users, groups, permission assignments, sessions, or passwords.
};

NoAuthProvider.prototype.supports = function supports(feature) {
  return supportsCore(feature);
};

NoAuthProvider.prototype.authenticate = function authenticate() {
  return { principal: this.principal, sessionToken: '' };
};

NoAuthProvider.prototype.getCurrentPrincipal = function getCurrentPrincipal() {
  return this.principal;
};

NoAuthProvider.prototype.authorize = function authorize(principal, action) {
  const key = String(action || '');
  if (!principal || principal.authenticated === false) return false;
  if (!isRecognized(key)) {
    return denyUnknown(key, this.id);
  }
  return true;
};

NoAuthProvider.prototype.getCapabilities = function getCapabilities(principal) {
  return {
    securityProfile: this.id,
    authenticationRequired: false,
    needsBootstrap: false,
    features: {
      userManagement: false,
      roleManagement: false,
      passwordManagement: false,
    },
    permissions: catalog.listKeys(),
    principal: publicPrincipal(principal || this.principal),
    networkWarning: true,
  };
};

module.exports = NoAuthProvider;
