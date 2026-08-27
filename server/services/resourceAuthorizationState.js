const db = require('../db/connection');
const logger = require('./logger');
const pluginAudit = require('./pluginAudit');

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_authorization_expectations (
      resource_type TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      plugin_id TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'suspended')),
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function markActive(resourceType, providerId, pluginId) {
  ensureTable();
  const type = String(resourceType || '').trim();
  const id = String(providerId || '').trim();
  if (!type || !id) return;
  db.prepare(`
    INSERT INTO resource_authorization_expectations (resource_type, provider_id, plugin_id, status, updated_at)
    VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP)
    ON CONFLICT(resource_type) DO UPDATE SET
      provider_id = excluded.provider_id,
      plugin_id = excluded.plugin_id,
      status = 'active',
      updated_at = CURRENT_TIMESTAMP
  `).run(type, id, pluginId ? String(pluginId) : null);
}

function markSuspended(resourceType) {
  ensureTable();
  const type = String(resourceType || '').trim();
  if (!type) return;
  db.prepare(`
    UPDATE resource_authorization_expectations
    SET status = 'suspended', updated_at = CURRENT_TIMESTAMP
    WHERE resource_type = ?
  `).run(type);
}

function getExpectation(resourceType) {
  ensureTable();
  return db.prepare(`
    SELECT resource_type AS resourceType, provider_id AS providerId, plugin_id AS pluginId, status
    FROM resource_authorization_expectations
    WHERE resource_type = ?
  `).get(String(resourceType || '').trim()) || null;
}

function unexpectedMissing(resourceType) {
  const expected = getExpectation(resourceType);
  if (!expected || expected.status !== 'active') return false;
  const registry = require('./resourceAuthorizationRegistry');
  return !registry.get(resourceType);
}

const lastFailureAudit = new Map();

function failClosed(resourceType, principal) {
  if (!unexpectedMissing(resourceType)) return false;
  if (principal && (principal.isAdmin || principal.type === 'system')) return false;
  const expected = getExpectation(resourceType);
  const now = Date.now();
  const previous = lastFailureAudit.get(resourceType) || 0;
  if (now - previous > 30_000) {
    lastFailureAudit.set(resourceType, now);
    logger.error(`Resource-authorization provider for "${resourceType}" is expected but not loaded`);
    pluginAudit.record('provider.failure', {
      targetType: 'resource-authorization',
      targetId: expected?.providerId || resourceType,
      detail: {
        resourceType,
        providerId: expected?.providerId || null,
        pluginId: expected?.pluginId || null,
        status: 'unexpected-missing',
      },
    });
  }
  return true;
}

module.exports = {
  ensureTable,
  markActive,
  markSuspended,
  getExpectation,
  unexpectedMissing,
  failClosed,
};
