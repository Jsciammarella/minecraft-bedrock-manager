const express = require('express');
const errors = require('../security/errors');
const {
  resolveServerResource,
  requireServerVisible,
  requireServerPermission,
} = require('../security/middleware');

const router = express.Router();

function registry() {
  return require('../services/resourceAuthorizationRegistry');
}

function provider() {
  return registry().get('server');
}

function unavailable(res) {
  const err = errors.featureUnavailable();
  return res.status(err.status).json({ error: err.message, code: err.code, available: false });
}

function requireProvider(req, res, next) {
  if (!provider()) return unavailable(res);
  next();
}

router.get('/availability', (req, res) => {
  const entry = registry().getEntry('server');
  const userManagement = require('../security').supports('userManagement');
  res.json({
    available: Boolean(entry && userManagement),
    resourceType: 'server',
    authorizationScoped: Boolean(entry),
    userManagement,
  });
});

router.use('/servers/:serverId', requireProvider, resolveServerResource('serverId'), requireServerVisible);

router.get('/servers/:serverId', requireServerPermission('server_access.view'), (req, res) => {
  try {
    const api = provider();
    const serverId = req.server.id;
    res.json({
      server: { id: req.server.id, name: req.server.name, kind: req.server.kind },
      policy: api.ensurePolicy(serverId),
      groups: api.listGroups(serverId),
      users: api.listAssignedUsers(serverId),
      directoryUsers: api.listDirectoryUsers(),
      assignablePermissions: api.listAssignablePermissions(req.server),
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.get('/servers/:serverId/capabilities', requireServerPermission('server_access.view'), (req, res) => {
  try {
    const security = require('../security');
    const principal = req.principal || req.user;
    const map = {};
    for (const item of provider().listAssignablePermissions(req.server)) {
      map[item.key] = security.decide(principal, item.key, req.server);
    }
    res.json({
      serverId: req.server.id,
      capabilities: require('../services/serverSerializer').capabilitiesFor(principal, req.server),
      permissions: map,
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.get('/servers/:serverId/users', requireServerPermission('server_access.view'), (req, res) => {
  try {
    const api = provider();
    res.json({ users: api.listAssignedUsers(req.server.id), directoryUsers: api.listDirectoryUsers() });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.post('/servers/:serverId/users', requireServerPermission('server_access.users.add'), (req, res) => {
  try {
    res.status(201).json(provider().addUser(req.server.id, req.body?.userId, req.principal));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.get('/servers/:serverId/users/:userId', requireServerPermission('server_access.view'), (req, res) => {
  try {
    const user = provider().getAssignedUser(req.server.id, req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.patch('/servers/:serverId/users/:userId', requireServerPermission('server_access.users.assign_permissions'), (req, res) => {
  try {
    res.json(provider().updateUser(req.server.id, req.params.userId, req.body || {}, req.principal));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code, permission: err.permission });
  }
});

router.delete('/servers/:serverId/users/:userId', requireServerPermission('server_access.users.remove'), (req, res) => {
  try {
    res.json(provider().removeUser(req.server.id, req.params.userId, req.principal));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.get('/servers/:serverId/groups', requireServerPermission('server_access.view'), (req, res) => {
  try {
    res.json({ groups: provider().listGroups(req.server.id) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.post('/servers/:serverId/groups', requireServerPermission('server_access.groups.create'), (req, res) => {
  try {
    res.status(201).json(provider().createGroup(req.server.id, req.body || {}, req.principal));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.get('/servers/:serverId/groups/:groupId', requireServerPermission('server_access.view'), (req, res) => {
  try {
    const group = provider().getGroup(req.server.id, req.params.groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json(group);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.patch('/servers/:serverId/groups/:groupId', requireServerPermission('server_access.groups.edit_name'), (req, res) => {
  try {
    const body = req.body || {};
    const security = require('../security');
    const principal = req.principal || req.user;
    if (body.isActive === true) security.requirePermission(principal, 'server_access.groups.activate', req.server);
    if (body.isActive === false) security.requirePermission(principal, 'server_access.groups.deactivate', req.server);
    if (body.userIds) {
      const current = new Set((provider().getGroup(req.server.id, req.params.groupId)?.users || []).map((user) => Number(user.id)));
      const next = new Set((Array.isArray(body.userIds) ? body.userIds : []).map(Number));
      if ([...next].some((id) => !current.has(id))) {
        security.requirePermission(principal, 'server_access.groups.add_members', req.server);
      }
      if ([...current].some((id) => !next.has(id))) {
        security.requirePermission(principal, 'server_access.groups.remove_members', req.server);
      }
    }
    if (body.permissions) security.requirePermission(principal, 'server_access.groups.assign_permissions', req.server);
    res.json(provider().updateGroup(req.server.id, req.params.groupId, body, principal));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code, permission: err.permission });
  }
});

router.delete('/servers/:serverId/groups/:groupId', requireServerPermission('server_access.groups.delete'), (req, res) => {
  try {
    res.json(provider().deleteGroup(req.server.id, req.params.groupId, req.principal));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.get('/servers/:serverId/effective/:userId', requireServerPermission('server_access.view_effective_permissions'), (req, res) => {
  try {
    const db = require('../db/connection');
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.userId));
    if (!row) return res.status(404).json({ error: 'User not found' });
    const loaded = require('../services/authService').getUser(row.id, { includePermissions: true });
    const principal = {
      id: row.id,
      username: row.username,
      isAdmin: row.is_admin === 1,
      isActive: row.is_active === 1,
      authenticated: true,
      type: 'user',
      permissions: loaded?.permissions || [],
    };
    res.json(provider().getEffectivePermissions(principal, req.server));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.patch('/servers/:serverId/mode', requireServerPermission('server_access.mode.change'), (req, res) => {
  try {
    res.json(provider().setAccessMode(req.server.id, req.body?.accessMode, req.principal));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

module.exports = router;
