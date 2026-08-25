const catalog = require('../../services/permissionCatalog');
const { localSystemPrincipal, publicPrincipal } = require('../principal');
const { PROFILE_NO_AUTH } = require('../profiles');
const { isRecognized, denyUnknown, isPluginAction } = require('../recognized');

function auth() {
  return require('../../services/authService');
}

function NoAuthProvider() {
  this.id = PROFILE_NO_AUTH;
  this.principal = localSystemPrincipal();
}

NoAuthProvider.prototype.init = function init() {
  // Keep user/role schema for upgrades; do not expose management APIs.
  auth().ensureSeed();
};

NoAuthProvider.prototype.supports = function supports(feature) {
  return feature !== 'userManagement'
    && feature !== 'roleManagement'
    && feature !== 'authentication'
    && feature !== 'sessions'
    && feature !== 'passwordManagement';
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
  if (!isRecognized(key) && !isPluginAction(key)) {
    return denyUnknown(key, this.id);
  }
  return true;
};

NoAuthProvider.prototype.getCapabilities = function getCapabilities(principal) {
  return {
    securityProfile: this.id,
    authenticationRequired: false,
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
