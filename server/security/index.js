const runtime = require('./runtime');
const middleware = require('./middleware');
const profiles = require('./profiles');
const principal = require('./principal');
const errors = require('./errors');
const audit = require('./audit');

function getRuntime() {
  return runtime.getRuntime();
}

function auditCall(event, extra) {
  return getRuntime().audit(event, extra);
}
Object.assign(auditCall, audit);

module.exports = {
  getRuntime,
  createRuntime: runtime.createRuntime,
  resetRuntime: runtime.resetRuntime,
  setRuntime: runtime.setRuntime,
  ensureReady: runtime.ensureReady,
  profiles,
  principal,
  errors,
  audit: auditCall,
  ...middleware,
  authenticate(request) {
    return getRuntime().authenticate(request);
  },
  authorize(current, action, resource, context) {
    return getRuntime().authorize(current, action, resource, context);
  },
  requireAction(current, action, resource, context) {
    return getRuntime().requirePermission(current, action, resource, context);
  },
  getCapabilities(current, context) {
    return getRuntime().getCapabilities(current, context);
  },
  getCurrentPrincipal(request) {
    return getRuntime().getCurrentPrincipal(request);
  },
  createSystemPrincipal(reason) {
    return getRuntime().createSystemPrincipal(reason);
  },
  supports(feature) {
    return getRuntime().supports(feature);
  },
  publicInfo() {
    return getRuntime().publicInfo();
  },
  hasPermission(current, action, resource, context) {
    return getRuntime().hasPermission(current, action, resource, context);
  },
  isAdministrator(current) {
    return getRuntime().isAdministrator(current);
  },
  actorName(current) {
    return getRuntime().actorName(current);
  },
  publicPrincipal(current) {
    return getRuntime().publicPrincipal(current);
  },
  syncDynamicPermissions() {
    return getRuntime().syncDynamicPermissions();
  },
  get provider() {
    return getRuntime().provider;
  },
};
