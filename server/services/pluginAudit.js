const logger = require('./logger');

const SECRET_RE = /(floodgate|password|secret|token|credential|private[_-]?key|api[_-]?key)/i;

function db() {
  return require('../db/connection');
}

function scrub(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (SECRET_RE.test(value) && value.length > 12) return '[redacted]';
    return value;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_RE.test(key) ? '[redacted]' : scrub(item);
    }
    return out;
  }
  return value;
}

function record(action, { actor = 'system', targetType = '', targetId = '', detail = null } = {}) {
  const safe = scrub(detail);
  try {
    db().prepare(`
      INSERT INTO audit_log (action, actor, target_type, target_id, detail)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      String(action || '').slice(0, 120),
      String(actor || 'system').slice(0, 80),
      String(targetType || '').slice(0, 80),
      String(targetId || '').slice(0, 80),
      safe == null ? null : JSON.stringify(safe)
    );
  } catch (err) {
    logger.warn(`audit log write failed: ${err.message}`);
  }
  logger.info(`[audit] ${action}`, { actor, targetType, targetId, detail: safe });
}

module.exports = { record, scrub };
