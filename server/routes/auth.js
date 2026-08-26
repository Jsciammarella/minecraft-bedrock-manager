const express = require('express');
const security = require('../security');
const { attachPrincipal } = require('../security/middleware');

const router = express.Router();

function sessionPayload(principal) {
  return {
    user: security.publicPrincipal(principal),
    ...security.getCapabilities(principal),
  };
}

router.get('/security', (_req, res) => {
  res.json(security.publicInfo());
});

router.get('/bootstrap-status', (_req, res) => {
  if (!security.supports('authentication')) {
    return res.status(404).json({ error: 'Authentication is not enabled' });
  }
  const needs = typeof security.provider.needsAdministratorBootstrap === 'function'
    && security.provider.needsAdministratorBootstrap();
  res.json({ needsBootstrap: Boolean(needs) });
});

router.post('/bootstrap', (req, res) => {
  if (!security.supports('authentication') || typeof security.provider.bootstrapAdministrator !== 'function') {
    return res.status(404).json({ error: 'Administrator bootstrap is not available' });
  }
  try {
    const { username, password, fullName } = req.body || {};
    const created = security.provider.bootstrapAdministrator({ username, password, fullName });
    const result = security.provider.login(created.username, password);
    res.setHeader('Set-Cookie', security.provider.cookieHeader(result.session.token, result.session.maxAge));
    security.audit('auth.bootstrap.success', {
      principal: { username: result.user.username, id: result.user.id, type: 'user' },
    });
    res.json(sessionPayload({ ...result.user, type: 'user', authenticated: true }));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/login', (req, res) => {
  if (!security.supports('authentication')) {
    return res.status(404).json({ error: 'Authentication is not enabled' });
  }
  try {
    const { username, password } = req.body || {};
    const result = security.provider.login(username, password);
    res.setHeader('Set-Cookie', security.provider.cookieHeader(result.session.token, result.session.maxAge));
    res.json(sessionPayload({ ...result.user, type: 'user', authenticated: true }));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/password-policy', (_req, res) => {
  if (!security.supports('passwordManagement')) {
    return res.status(404).json({ error: 'Password management is not available' });
  }
  res.json(security.provider.getPasswordPolicy());
});

router.post('/logout', (req, res) => {
  if (!security.supports('sessions')) {
    return res.status(404).json({ error: 'Sessions are not enabled' });
  }
  if (typeof security.provider.logout === 'function') {
    const token = security.provider.tokenFromRequest(req);
    security.provider.logout(token);
    res.setHeader('Set-Cookie', security.provider.clearCookieHeader());
  }
  res.json({ success: true });
});

router.get('/me', attachPrincipal, (req, res) => {
  const current = req.principal || req.user;
  res.json(sessionPayload(current));
});

router.put('/password', attachPrincipal, (req, res) => {
  if (!security.supports('passwordManagement')) {
    return res.status(404).json({ error: 'Password management is not available' });
  }
  try {
    const { currentPassword, newPassword } = req.body || {};
    const row = security.provider.getUserRow(req.user.id);
    if (!row || !security.provider.verifyPassword(currentPassword, row.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    security.provider.setPassword(req.user.id, newPassword, {
      invalidateSessions: true,
      keepSessionId: req.user.sessionId,
    });
    security.audit('auth.password.change', { principal: req.principal || req.user });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
