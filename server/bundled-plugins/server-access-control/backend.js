const service = require('./service');
const provider = require('./provider');

function register(api) {
  const security = require('../../security');
  if (!security.supports('userManagement')) return;

  service.ensureMigrated();
  if (typeof api.registerResourceAuthorizationProvider === 'function') {
    api.registerResourceAuthorizationProvider(provider);
  }
}

function onEnable() {
  service.ensureMigrated();
}

function onDisable() {
  /* configuration is preserved; registry unregisters on reload */
}

module.exports = { register, onEnable, onDisable };
