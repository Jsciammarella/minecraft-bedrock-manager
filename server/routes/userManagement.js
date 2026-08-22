const express = require('express');
const auth = require('../services/authService');
const catalog = require('../services/permissionCatalog');
const {
  requireUserManagement,
  requirePermission,
  requireAnyPermission,
  requireAdmin,
} = require('../middleware/auth');

const router = express.Router();

router.use(requireUserManagement);

function canViewUsers(user) {
  return user.isAdmin
    || auth.hasPermission(user, 'users.change_password')
    || auth.hasPermission(user, 'users.change_name')
    || auth.hasPermission(user, 'users.change_user_permissions')
    || auth.hasPermission(user, 'users.change_group_membership');
}

function canManageUserAccounts(user) {
  return user.isAdmin || auth.hasPermission(user, 'users.change_user_permissions');
}

router.get('/users', (req, res) => {
  res.json(auth.listUsers());
});

router.post('/users', (req, res) => {
  if (!canManageUserAccounts(req.user)) {
    return res.status(403).json({ error: 'You do not have permission to create users' });
  }
  try {
    const user = auth.createUser(req.body || {}, req.user);
    res.status(201).json(user);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/users/:id', (req, res) => {
  if (!canViewUsers(req.user)) {
    return res.status(403).json({ error: 'You do not have permission to view users' });
  }
  const user = auth.getUser(req.params.id, { includePermissions: true, includeSensitive: true });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const guard = auth.lastAdminGuard(user.id);
  res.json({ ...user, isLastAdmin: guard.isLastAdmin });
});

router.put('/users/:id', (req, res) => {
  try {
    const target = auth.getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const body = req.body || {};
    if (body.fullName != null && body.fullName !== target.fullName) {
      if (!req.user.isAdmin && !auth.hasPermission(req.user, 'users.change_name')) {
        return res.status(403).json({ error: 'You do not have permission to change names' });
      }
    }
    if (body.password) {
      if (!req.user.isAdmin && !auth.hasPermission(req.user, 'users.change_password')) {
        return res.status(403).json({ error: 'You do not have permission to change passwords' });
      }
    }
    if (body.userPermissions) {
      if (!req.user.isAdmin && !auth.hasPermission(req.user, 'users.change_user_permissions')) {
        return res.status(403).json({ error: 'You do not have permission to change user permissions' });
      }
    }
    if (Array.isArray(body.groupIds)) {
      if (!req.user.isAdmin && !auth.hasPermission(req.user, 'users.change_group_membership')) {
        return res.status(403).json({ error: 'You do not have permission to change group membership' });
      }
    }
    if (body.isAdmin != null && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Only administrators can change administrator status' });
    }
    if (body.isActive != null && !canManageUserAccounts(req.user)) {
      return res.status(403).json({ error: 'You do not have permission to activate or deactivate users' });
    }
    if (body.playerId !== undefined && !canManageUserAccounts(req.user)) {
      return res.status(403).json({ error: 'You do not have permission to link players' });
    }
    const user = auth.updateUser(req.params.id, {
      ...body,
      keepSessionId: req.user.id === Number(req.params.id) ? req.user.sessionId : null,
    }, req.user);
    const guard = auth.lastAdminGuard(user.id);
    res.json({ ...user, isLastAdmin: guard.isLastAdmin });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete('/users/:id', (req, res) => {
  if (!canManageUserAccounts(req.user) && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You do not have permission to delete users' });
  }
  try {
    res.json(auth.deleteUser(req.params.id, req.user));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/groups', (req, res) => {
  res.json(auth.listGroups());
});

router.post('/groups', requirePermission('users.add_groups'), (req, res) => {
  try {
    res.status(201).json(auth.createGroup(req.body || {}));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/groups/:id', (req, res) => {
  const group = auth.getGroup(req.params.id, { includePermissions: true, includeUsers: true });
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json(group);
});

router.put('/groups/:id', (req, res) => {
  try {
    const body = req.body || {};
    if (body.permissions && !req.user.isAdmin && !auth.hasPermission(req.user, 'users.change_group_permissions')) {
      return res.status(403).json({ error: 'You do not have permission to change group permissions' });
    }
    if (Array.isArray(body.userIds) && !req.user.isAdmin && !auth.hasPermission(req.user, 'users.change_group_membership')) {
      return res.status(403).json({ error: 'You do not have permission to change group membership' });
    }
    if ((body.name != null || body.isActive != null)
      && !req.user.isAdmin
      && !auth.hasPermission(req.user, 'users.change_group_permissions')
      && !auth.hasPermission(req.user, 'users.add_groups')) {
      return res.status(403).json({ error: 'You do not have permission to update this group' });
    }
    res.json(auth.updateGroup(req.params.id, body));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete('/groups/:id', requirePermission('users.delete_groups'), (req, res) => {
  try {
    res.json(auth.deleteGroup(req.params.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/permissions', requireAnyPermission('users.change_user_permissions', 'users.change_group_permissions'), (req, res) => {
  res.json({
    categories: catalog.CATEGORIES,
    permissions: auth.listPermissionDefs(),
  });
});

router.put('/permissions/:key', requireAnyPermission('users.change_user_permissions', 'users.change_group_permissions'), (req, res) => {
  try {
    res.json(auth.updatePermissionDef(req.params.key, req.body || {}));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/settings', requireAdmin, (_req, res) => {
  res.json(auth.publicSettings());
});

router.put('/settings', requireAdmin, (req, res) => {
  try {
    res.json(auth.saveSettings(req.body || {}));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/catalog', (_req, res) => {
  res.json({
    categories: catalog.CATEGORIES,
    permissions: auth.listPermissionDefs(),
  });
});

module.exports = router;
