const express = require('express');
const auth = require('../services/authService');
const { attachUser } = require('../middleware/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = auth.login(username, password);
    res.setHeader('Set-Cookie', auth.cookieHeader(result.session.token, result.session.maxAge));
    res.json({ user: result.user });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/password-policy', (_req, res) => {
  res.json(auth.getPasswordPolicy());
});

router.post('/logout', (req, res) => {
  const token = auth.tokenFromRequest(req);
  auth.destroySession(token);
  res.setHeader('Set-Cookie', auth.clearCookieHeader());
  res.json({ success: true });
});

router.get('/me', attachUser, (req, res) => {
  res.json({ user: req.user });
});

router.put('/password', attachUser, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const row = auth.getUserRow(req.user.id);
    if (!row || !auth.verifyPassword(currentPassword, row.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    auth.setPassword(req.user.id, newPassword, {
      invalidateSessions: true,
      keepSessionId: req.user.sessionId,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
