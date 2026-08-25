const db = require('../db/connection');
const pluginAudit = require('./pluginAudit');

function pluginIdForProvider(providerId) {
  try {
    const entry = require('./gatewayRegistry').get(providerId);
    return entry?.pluginId || null;
  } catch {
    return null;
  }
}

function rowFromDb(row) {
  if (!row) return null;
  return {
    ...row,
    primary: Boolean(row.primary_attachment),
    display: (() => {
      try { return row.display_json ? JSON.parse(row.display_json) : null; } catch { return null; }
    })(),
  };
}

function listForServer(serverId) {
  return db.prepare(`
    SELECT * FROM server_plugin_attachments
    WHERE server_id = ?
    ORDER BY primary_attachment DESC, id
  `).all(Number(serverId)).map(rowFromDb);
}

function listAllForPlugin(pluginId) {
  return db.prepare(`
    SELECT * FROM server_plugin_attachments
    WHERE plugin_id = ?
    ORDER BY id
  `).all(String(pluginId)).map(fromDbRow);
}

function findByResource(pluginId, resourceType, resourceId) {
  return rowFromDb(db.prepare(`
    SELECT * FROM server_plugin_attachments
    WHERE plugin_id = ? AND resource_type = ? AND resource_id = ?
  `).get(pluginId, resourceType, String(resourceId)));
}

function findById(id) {
  const num = Number(String(id || '').replace(/^attachment:/, ''));
  if (!Number.isInteger(num) || num < 1) return null;
  return rowFromDb(db.prepare('SELECT * FROM server_plugin_attachments WHERE id = ?').get(num));
}

function hasPrimary(pluginId, providerId, serverId) {
  return Boolean(db.prepare(`
    SELECT id FROM server_plugin_attachments
    WHERE plugin_id = ? AND provider_id = ? AND server_id = ? AND primary_attachment = 1
  `).get(pluginId, providerId, Number(serverId)));
}

function setUnresolved(gatewayId, unresolved, reason = null) {
  db.prepare(`
    UPDATE gateways
    SET unresolved_target = ?, unresolved_reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(unresolved ? 1 : 0, unresolved ? String(reason || 'unresolved').slice(0, 80) : null, gatewayId);
}

function setDisplay(attachmentId, payload) {
  db.prepare(`
    UPDATE server_plugin_attachments
    SET display_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(payload || {}), attachmentId);
}

function detachResource(pluginId, resourceType, resourceId, { actor = 'system' } = {}) {
  const existing = findByResource(pluginId, resourceType, String(resourceId));
  if (!existing) return false;
  db.prepare('DELETE FROM server_plugin_attachments WHERE id = ?').run(existing.id);
  pluginAudit.record('plugin.attachment.remove', {
    actor,
    targetType: 'attachment',
    targetId: String(existing.id),
    detail: {
      pluginId,
      resourceType,
      resourceId: String(resourceId),
      serverId: existing.server_id,
    },
  });
  return true;
}

function attach({
  pluginId,
  providerId,
  serverId,
  resourceType,
  resourceId,
  makePrimaryIfNone = true,
  actor = 'system',
  display = null,
} = {}) {
  const pid = String(pluginId || '').trim();
  const provider = String(providerId || '').trim();
  const sid = Number(serverId);
  const type = String(resourceType || '').trim();
  const rid = String(resourceId || '').trim();
  if (!pid || !provider || !type || !rid || !Number.isInteger(sid) || sid < 1) {
    throw Object.assign(new Error('Invalid plugin attachment'), { status: 400 });
  }
  const server = db.prepare('SELECT id, kind FROM servers WHERE id = ?').get(sid);
  if (!server || server.kind !== 'java') {
    throw Object.assign(new Error('Attachments can only target a managed Java server'), { status: 400 });
  }
  const existing = findByResource(pid, type, rid);
  const primaryExists = hasPrimary(pid, provider, sid);
  const wantPrimary = makePrimaryIfNone && !primaryExists;
  if (existing) {
    const moved = Number(existing.server_id) !== sid;
    if (moved) {
      const becomePrimary = wantPrimary;
      db.prepare(`
        UPDATE server_plugin_attachments
        SET server_id = ?, primary_attachment = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(sid, becomePrimary ? 1 : 0, existing.id);
      pluginAudit.record('plugin.attachment.reassign', {
        actor,
        targetType: 'attachment',
        targetId: String(existing.id),
        detail: { pluginId: pid, fromServerId: existing.server_id, serverId: sid, resourceId: rid },
      });
    }
    return findById(existing.id);
  }
  const result = db.prepare(`
    INSERT INTO server_plugin_attachments (
      plugin_id, provider_id, server_id, resource_type, resource_id, primary_attachment, display_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(pid, provider, sid, type, rid, wantPrimary ? 1 : 0, display ? JSON.stringify(display) : null);
  pluginAudit.record('plugin.attachment.create', {
    actor,
    targetType: 'attachment',
    targetId: String(result.lastInsertRowid),
    detail: { pluginId: pid, providerId: provider, serverId: sid, resourceType: type, resourceId: rid, primary: wantPrimary },
  });
  return findById(result.lastInsertRowid);
}

function setPrimary(attachmentId, { actor = 'system' } = {}) {
  const att = findById(attachmentId);
  if (!att) throw Object.assign(new Error('Attachment not found'), { status: 404 });
  db.transaction(() => {
    db.prepare(`
      UPDATE server_plugin_attachments
      SET primary_attachment = 0, updated_at = CURRENT_TIMESTAMP
      WHERE plugin_id = ? AND provider_id = ? AND server_id = ? AND primary_attachment = 1
    `).run(att.plugin_id, att.provider_id, att.server_id);
    db.prepare(`
      UPDATE server_plugin_attachments
      SET primary_attachment = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(att.id);
  })();
  pluginAudit.record('plugin.attachment.primary', {
    actor,
    targetType: 'attachment',
    targetId: String(att.id),
    detail: { pluginId: att.plugin_id, serverId: att.server_id, resourceId: att.resource_id },
  });
  try { require('./pluginEvents').emit('plugin.attachment.primary', { attachmentId: att.id, serverId: att.server_id }); } catch { /* ignore */ }
  return findById(att.id);
}

function syncForGateway(row, { actor = 'system' } = {}) {
  if (!row) return null;
  const pluginId = pluginIdForProvider(row.provider_id) || 'gateway-geyser';
  if (row.target_type === 'local-server' && row.target_server_id) {
    const server = db.prepare('SELECT id, kind FROM servers WHERE id = ?').get(row.target_server_id);
    if (server && server.kind === 'java') {
      const att = attach({
        pluginId,
        providerId: row.provider_id,
        serverId: server.id,
        resourceType: 'gateway',
        resourceId: String(row.id),
        makePrimaryIfNone: true,
        actor,
      });
      setUnresolved(row.id, false);
      return att;
    }
    detachResource(pluginId, 'gateway', String(row.id), { actor });
    setUnresolved(row.id, true, server ? 'target-not-java' : 'target-missing');
    return null;
  }
  detachResource(pluginId, 'gateway', String(row.id), { actor });
  setUnresolved(row.id, false);
  return null;
}

function migrateGateways() {
  const rows = db.prepare('SELECT * FROM gateways ORDER BY id').all();
  let attached = 0;
  let unresolved = 0;
  let projected = 0;
  for (const row of rows) {
    const result = syncForGateway(row, { actor: 'migration' });
    if (result) attached += 1;
    else if (row.target_type === 'local-server') unresolved += 1;
    else projected += 1;
  }
  return { attached, unresolved, projected, total: rows.length };
}

function javaServerOf(serverId) {
  if (!serverId) return null;
  return db.prepare('SELECT * FROM servers WHERE id = ? AND kind = ?').get(Number(serverId), 'java') || null;
}

function resolveActionTarget({ pluginId, resourceType, serverId, attachmentId, resourceId } = {}) {
  const pid = String(pluginId || '').trim();
  const type = String(resourceType || 'gateway').trim();
  const rawAtt = String(attachmentId || '');
  const requestedResource = resourceId != null ? String(resourceId) : '';

  if (rawAtt.startsWith('gateway:') || (!serverId && requestedResource)) {
    const gid = rawAtt.startsWith('gateway:')
      ? Number(rawAtt.slice(8))
      : Number(requestedResource);
    if (!Number.isInteger(gid) || gid < 1) {
      return { ok: false, status: 400, error: 'Invalid gateway resource' };
    }
    const gateway = db.prepare('SELECT * FROM gateways WHERE id = ?').get(gid);
    if (!gateway) return { ok: false, status: 404, error: 'Gateway not found' };
    const owner = pluginIdForProvider(gateway.provider_id);
    if (owner !== pid) return { ok: false, status: 403, error: 'That resource is not owned by this plugin' };
    const attached = findByResource(pid, type, String(gid));
    if (attached) {
      if (serverId != null && Number(attached.server_id) !== Number(serverId)) {
        return { ok: false, status: 403, error: 'That attachment does not belong to this server' };
      }
      return {
        ok: true,
        attachment: attached,
        serverId: attached.server_id,
        resourceId: String(gid),
        javaServer: javaServerOf(attached.server_id),
      };
    }
    if (serverId != null) {
      return { ok: false, status: 403, error: 'That plugin action cannot target another server or gateway' };
    }
    return {
      ok: true,
      attachment: null,
      serverId: null,
      resourceId: String(gid),
      javaServer: null,
    };
  }

  let att = null;
  if (rawAtt && !rawAtt.startsWith('gateway:')) att = findById(rawAtt);
  if (!att && requestedResource) att = findByResource(pid, type, requestedResource);
  if (!att && serverId && requestedResource) {
    att = listForServer(serverId).find((item) => (
      item.plugin_id === pid && item.resource_type === type && item.resource_id === String(requestedResource)
    )) || null;
  }
  if (!att) return { ok: false, status: 404, error: 'Plugin attachment not found' };
  if (att.plugin_id !== pid) return { ok: false, status: 403, error: 'That attachment is not owned by this plugin' };
  if (att.resource_type !== type) return { ok: false, status: 403, error: 'Resource type mismatch' };
  if (serverId != null && Number(att.server_id) !== Number(serverId)) {
    return { ok: false, status: 403, error: 'That attachment does not belong to this server' };
  }
  const resourceStillExists = type === 'gateway'
    ? Boolean(db.prepare('SELECT id FROM gateways WHERE id = ?').get(Number(att.resource_id)))
    : true;
  if (!resourceStillExists) return { ok: false, status: 404, error: 'Attached resource no longer exists' };
  return {
    ok: true,
    attachment: att,
    serverId: att.server_id,
    resourceId: att.resource_id,
    javaServer: javaServerOf(att.server_id),
  };
}

function attachmentsBlockingDelete(serverId) {
  return listForServer(serverId);
}

function detachServer(serverId, { actor = 'system', stopGateways = true } = {}) {
  const rows = listForServer(serverId);
  const gatewayManager = require('./gatewayManager');
  for (const att of rows) {
    if (att.resource_type === 'gateway') {
      const gid = Number(att.resource_id);
      if (stopGateways) {
        try { gatewayManager.stop(gid); } catch { /* ignore */ }
      }
      db.prepare(`
        UPDATE gateways
        SET target_server_id = NULL, unresolved_target = 1, unresolved_reason = 'server-deleted', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(gid);
      pluginAudit.record('gateway.target.reassign', {
        actor,
        targetType: 'gateway',
        targetId: String(gid),
        detail: { fromServerId: Number(serverId), to: 'unresolved' },
      });
    }
    detachResource(att.plugin_id, att.resource_type, att.resource_id, { actor });
  }
  return rows.length;
}

function deleteAttachedResources(serverId, { actor = 'system' } = {}) {
  const rows = listForServer(serverId);
  const gatewayManager = require('./gatewayManager');
  for (const att of rows) {
    if (att.resource_type === 'gateway') {
      try { gatewayManager.remove(Number(att.resource_id)); } catch { /* ignore */ }
    } else {
      detachResource(att.plugin_id, att.resource_type, att.resource_id, { actor });
    }
  }
  return rows.length;
}

module.exports = {
  attach,
  attachmentsBlockingDelete,
  deleteAttachedResources,
  detachResource,
  detachServer,
  findById,
  findByResource,
  hasPrimary,
  listAllForPlugin,
  listForServer,
  migrateGateways,
  pluginIdForProvider,
  resolveActionTarget,
  setDisplay,
  setPrimary,
  setUnresolved,
  syncForGateway,
};
