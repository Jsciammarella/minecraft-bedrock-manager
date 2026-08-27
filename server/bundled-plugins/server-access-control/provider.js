const service = require('./service');

function authorize(principal, action, resource, context) {
  return require('../../security/evaluate').decide(principal, action, resource, context);
}

module.exports = {
  id: service.PROVIDER_ID,
  resourceType: 'server',
  authorize,
  getEffectivePermissions: (principal, resource, context) => service.getEffectivePermissions(principal, resource, context),
  listAssignablePermissions: (resource, context) => service.listAssignablePermissions(resource, context),
  getDisableImpact: () => service.getDisableImpact(),
  collectSources: (principal, permission, resource, context) => service.collectSources(principal, permission, resource, context),
  inspectMembership: (principal, resource, context) => service.inspectMembership(principal, resource, context),
  snapshot: (serverId) => service.snapshot(serverId),
  ensurePolicy: (serverId) => service.ensurePolicy(serverId),
  setAccessMode: (...args) => service.setAccessMode(...args),
  listGroups: (...args) => service.listGroups(...args),
  getGroup: (...args) => service.getGroup(...args),
  createGroup: (...args) => service.createGroup(...args),
  updateGroup: (...args) => service.updateGroup(...args),
  deleteGroup: (...args) => service.deleteGroup(...args),
  listAssignedUsers: (...args) => service.listAssignedUsers(...args),
  getAssignedUser: (...args) => service.getAssignedUser(...args),
  addUser: (...args) => service.addUser(...args),
  updateUser: (...args) => service.updateUser(...args),
  removeUser: (...args) => service.removeUser(...args),
  listDirectoryUsers: () => service.listDirectoryUsers(),
};

