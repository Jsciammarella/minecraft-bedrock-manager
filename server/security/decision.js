const ALLOW = 'allow';
const DENY = 'deny';
const UNSET = 'unset';

function source({
  origin,
  scope = 'global',
  value,
  groupId = null,
  groupName = null,
  userId = null,
  permission = null,
} = {}) {
  return {
    origin: String(origin || 'default'),
    scope: scope === 'server' ? 'server' : 'global',
    value: value === ALLOW || value === DENY ? value : UNSET,
    groupId,
    groupName,
    userId,
    permission,
  };
}

function result({
  decision = UNSET,
  permission = '',
  resourceType = null,
  resourceId = null,
  sources = [],
  winningSource = null,
} = {}) {
  const resolved = decision === ALLOW || decision === DENY ? decision : UNSET;
  return {
    decision: resolved,
    allowed: resolved === ALLOW,
    permission: String(permission || ''),
    resourceType: resourceType || null,
    resourceId: resourceId == null ? null : resourceId,
    sources: Array.isArray(sources) ? sources : [],
    winningSource: winningSource || null,
  };
}

function fromBoolean(allowed, permission, resource) {
  const normalized = normalizeResource(resource);
  return result({
    decision: allowed ? ALLOW : DENY,
    permission,
    resourceType: normalized?.type || null,
    resourceId: normalized?.id ?? null,
    sources: [source({
      origin: allowed ? 'compatibility' : 'default',
      value: allowed ? ALLOW : DENY,
      permission,
    })],
    winningSource: allowed ? 'compatibility' : 'default',
  });
}

function administrator(permission, resource) {
  const normalized = normalizeResource(resource);
  const src = source({
    origin: 'administrator',
    scope: normalized ? 'server' : 'global',
    value: ALLOW,
    permission,
  });
  return result({
    decision: ALLOW,
    permission,
    resourceType: normalized?.type || null,
    resourceId: normalized?.id ?? null,
    sources: [src],
    winningSource: src,
  });
}

function defaultDeny(permission, resource, extraSources = []) {
  const normalized = normalizeResource(resource);
  const src = source({ origin: 'default', value: DENY, permission });
  return result({
    decision: DENY,
    permission,
    resourceType: normalized?.type || null,
    resourceId: normalized?.id ?? null,
    sources: [...extraSources, src],
    winningSource: src,
  });
}

function combine(permission, resource, sources) {
  const list = (sources || []).filter((item) => item && (item.value === ALLOW || item.value === DENY));
  const denyHit = list.find((item) => item.value === DENY);
  if (denyHit) {
    return result({
      decision: DENY,
      permission,
      resourceType: normalizeResource(resource)?.type || null,
      resourceId: normalizeResource(resource)?.id ?? null,
      sources: list,
      winningSource: denyHit,
    });
  }
  const allowHit = list.find((item) => item.value === ALLOW);
  if (allowHit) {
    return result({
      decision: ALLOW,
      permission,
      resourceType: normalizeResource(resource)?.type || null,
      resourceId: normalizeResource(resource)?.id ?? null,
      sources: list,
      winningSource: allowHit,
    });
  }
  return result({
    decision: UNSET,
    permission,
    resourceType: normalizeResource(resource)?.type || null,
    resourceId: normalizeResource(resource)?.id ?? null,
    sources: list,
    winningSource: null,
  });
}

function finalize(partial) {
  if (!partial || partial.decision === ALLOW) return partial;
  if (partial.decision === DENY) return partial;
  return defaultDeny(partial.permission, {
    type: partial.resourceType,
    id: partial.resourceId,
  }, partial.sources);
}

function normalizeResource(resource) {
  if (resource == null || resource === '') return null;
  if (typeof resource === 'string' || typeof resource === 'number') {
    return { type: 'server', id: resource, kind: null };
  }
  if (typeof resource !== 'object') return null;
  if (resource.type && resource.id != null) {
    return {
      type: String(resource.type),
      id: resource.id,
      kind: resource.kind || resource.edition || null,
    };
  }
  if (resource.id != null && (resource.kind || resource.name || resource.status != null || resource.port != null)) {
    return {
      type: 'server',
      id: resource.id,
      kind: resource.kind || resource.edition || null,
    };
  }
  if (resource.serverId != null) {
    return { type: 'server', id: resource.serverId, kind: resource.kind || null };
  }
  return null;
}

module.exports = {
  ALLOW,
  DENY,
  UNSET,
  source,
  result,
  fromBoolean,
  administrator,
  defaultDeny,
  combine,
  finalize,
  normalizeResource,
};
