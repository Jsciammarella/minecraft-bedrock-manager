const pluginAudit = require('../services/pluginAudit');
const { actorName } = require('./principal');

const SECRET_KEYS = /password|secret|token|credential|api[_-]?key|session|hash|cookie/i;

function scrub(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (SECRET_KEYS.test(value) && value.length > 8) return '[redacted]';
    return value;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? '[redacted]' : scrub(item);
    }
    return out;
  }
  return value;
}

function record(event, { principal, action, resource, detail } = {}) {
  const name = typeof event === 'string' ? event : (event && event.type) || 'security';
  pluginAudit.record(name, {
    actor: actorName(principal),
    targetType: resource?.type || (typeof event === 'object' && event.resourceType) || '',
    targetId: resource?.id != null ? String(resource.id) : String((typeof event === 'object' && event.resourceId) || ''),
    detail: scrub({
      ...(typeof event === 'object' ? event : {}),
      action: action || undefined,
      ...(detail && typeof detail === 'object' ? detail : detail != null ? { detail } : {}),
      principalType: principal?.type || undefined,
      principalId: principal?.id || undefined,
      reason: principal?.reason || undefined,
    }),
  });
}

module.exports = { record, scrub };
