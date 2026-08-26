const express = require('express');
const auth = require('../services/authService');
const catalog = require('../services/permissionCatalog');
const {
  requireUserManagement,
  requirePermission,
  requireAnyPermission,
  requireAdmin,
  assertPermission,
} = require('../middleware/auth');

const router = express.Router();

router.use(requireUserManagement);

function permissionDenied(res, permission) {
  return res.status(403).json({
    error: 'You do not have permission to do that',
    code: 'PERMISSION_REQUIRED',
    permission,
  });
}

router.get('/users', requirePermission('users.view'), (req, res) => {
  res.json(auth.listUsers());
});

router.post('/users', requirePermission('users.create'), (req, res) => {
  try {
    if (req.body?.isAdmin) assertPermission(req, 'users.set_administrator');
    const user = auth.createUser(req.body || {}, req.user);
    res.status(201).json(user);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/users/:id', requirePermission('users.view_details'), (req, res) => {
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
    const self = req.user.id === Number(req.params.id);
    if (body.fullName != null && body.fullName !== target.fullName) {
      const key = self ? 'account.change_own_name' : 'users.edit_name';
      if (!req.user.isAdmin && !auth.hasPermission(req.user, key)) {
        return permissionDenied(res, key);
      }
    }
    if (body.password) {
      const key = self ? 'account.change_own_password' : 'users.reset_password';
      if (!req.user.isAdmin && !auth.hasPermission(req.user, key)) {
        return permissionDenied(res, key);
      }
    }
    if (body.userPermissions) {
      if (!req.user.isAdmin && !auth.hasPermission(req.user, 'users.assign_permissions')) {
        return permissionDenied(res, 'users.assign_permissions');
      }
    }
    if (Array.isArray(body.groupIds)) {
      if (!req.user.isAdmin && !auth.hasPermission(req.user, 'users.assign_groups')) {
        return permissionDenied(res, 'users.assign_groups');
      }
    }
    if (body.isAdmin != null) {
      if (!req.user.isAdmin) return permissionDenied(res, 'users.set_administrator');
      assertPermission(req, 'users.set_administrator');
    }
    if (body.isActive != null && body.isActive !== target.isActive) {
      const key = body.isActive ? 'users.activate' : 'users.deactivate';
      if (!req.user.isAdmin && !auth.hasPermission(req.user, key)) {
        return permissionDenied(res, key);
      }
    }
    if (body.playerId !== undefined) {
      const key = body.playerId ? 'users.link_player' : 'users.unlink_player';
      if (!req.user.isAdmin && !auth.hasPermission(req.user, key)) {
        return permissionDenied(res, key);
      }
    }
    const user = auth.updateUser(req.params.id, {
      ...body,
      keepSessionId: self ? req.user.sessionId : null,
    }, req.user);
    const guard = auth.lastAdminGuard(user.id);
    res.json({ ...user, isLastAdmin: guard.isLastAdmin });
  } catch (err) {
    res.status(err.status || 400).json({
      error: err.message,
      code: err.code,
      permission: err.permission,
    });
  }
});

router.delete('/users/:id', requirePermission('users.delete'), (req, res) => {
  try {
    res.json(auth.deleteUser(req.params.id, req.user));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/groups', requirePermission('groups.view'), (req, res) => {
  res.json(auth.listGroups());
});

router.post('/groups', requirePermission('groups.create'), (req, res) => {
  try {
    res.status(201).json(auth.createGroup(req.body || {}));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/groups/:id', requirePermission('groups.view_details'), (req, res) => {
  const group = auth.getGroup(req.params.id, { includePermissions: true, includeUsers: true });
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json(group);
});

router.put('/groups/:id', (req, res) => {
  try {
    const body = req.body || {};
    if (body.permissions && !req.user.isAdmin && !auth.hasPermission(req.user, 'groups.assign_permissions')) {
      return permissionDenied(res, 'groups.assign_permissions');
    }
    if (Array.isArray(body.userIds) && !req.user.isAdmin && !auth.hasPermission(req.user, 'groups.add_members') && !auth.hasPermission(req.user, 'groups.remove_members')) {
      return permissionDenied(res, 'groups.add_members');
    }
    if (body.name != null && !req.user.isAdmin && !auth.hasPermission(req.user, 'groups.edit_name')) {
      return permissionDenied(res, 'groups.edit_name');
    }
    if (body.isActive != null) {
      const key = body.isActive ? 'groups.activate' : 'groups.deactivate';
      if (!req.user.isAdmin && !auth.hasPermission(req.user, key)) {
        return permissionDenied(res, key);
      }
    }
    res.json(auth.updateGroup(req.params.id, body));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete('/groups/:id', requirePermission('groups.delete'), (req, res) => {
  try {
    res.json(auth.deleteGroup(req.params.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/groups/:id/reset-defaults', requireAdmin, (req, res) => {
  try {
    const group = auth.getGroup(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json(auth.resetSystemGroupDefaults(group.systemKey || group.slug, req.user));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/permissions', requireAnyPermission('permissions.view_catalog', 'permissions.view_assignments'), (req, res) => {
  res.json({
    categories: catalog.CATEGORIES,
    subcategories: catalog.SUBCATEGORIES,
    permissions: auth.listPermissionDefs({
      includeDeprecated: Boolean(req.query.includeDeprecated) && (
        req.user.isAdmin || auth.hasPermission(req.user, 'permissions.view_deprecated')
      ),
    }),
  });
});

router.put('/permissions/:key', requireAdmin, (req, res) => {
  try {
    assertPermission(req, 'permissions.manage_assignability');
    res.json(auth.updatePermissionDef(req.params.key, req.body || {}));
  } catch (err) {
    res.status(err.status || 400).json({
      error: err.message,
      code: err.code,
      permission: err.permission,
    });
  }
});

router.get('/settings', requirePermission('security.view_settings'), (_req, res) => {
  res.json(auth.publicSettings());
});

router.put('/settings', requireAdmin, (req, res) => {
  try {
    const body = req.body || {};
    if (body.sessionHours != null) assertPermission(req, 'security.configure_session_timeout');
    if (
      body.passwordMinLength != null
      || body.passwordHistory != null
      || body.passwordRequireUpper != null
      || body.passwordRequireLower != null
      || body.passwordRequireNumber != null
      || body.passwordRequireSpecial != null
    ) {
      assertPermission(req, 'security.configure_password_policy');
    }
    res.json(auth.saveSettings(body));
  } catch (err) {
    res.status(err.status || 400).json({
      error: err.message,
      code: err.code,
      permission: err.permission,
    });
  }
});

router.get('/catalog', requirePermission('permissions.view_catalog'), (req, res) => {
  res.json({
    categories: catalog.CATEGORIES,
    subcategories: catalog.SUBCATEGORIES,
    permissions: auth.listPermissionDefs({
      includeDeprecated: Boolean(req.query.includeDeprecated) && (
        req.user.isAdmin || auth.hasPermission(req.user, 'permissions.view_deprecated')
      ),
    }),
  });
});

module.exports = router;
