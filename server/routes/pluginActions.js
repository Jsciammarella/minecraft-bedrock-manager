const express = require('express');
const router = express.Router();
const pluginActions = require('../services/pluginActions');

function sendError(res, err) {
  const status = Number(err?.status) || 400;
  res.status(status).json({ error: err.message || String(err), code: err.code || undefined });
}

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await pluginActions.invoke({
      pluginId: body.pluginId,
      actionId: body.actionId,
      attachmentId: body.attachmentId,
      serverId: body.serverId,
      resourceId: body.resourceId,
      url: body.url,
      href: body.href,
      command: body.command,
      endpoint: body.endpoint,
      actor: req.user?.username || 'local',
      user: req.user,
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/servers/:id', async (req, res) => {
  try {
    if (String(req.params.id).startsWith('gateway:')) {
      return res.status(400).json({
        error: 'Gateway identifiers cannot be used with server endpoints. Manage this Geyser server from the Geyser plugin.',
      });
    }
    const body = req.body || {};
    const result = await pluginActions.invoke({
      pluginId: body.pluginId,
      actionId: body.actionId,
      attachmentId: body.attachmentId,
      serverId: req.params.id,
      resourceId: body.resourceId,
      url: body.url,
      href: body.href,
      command: body.command,
      actor: req.user?.username || 'local',
      user: req.user,
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
