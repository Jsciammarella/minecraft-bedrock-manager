const LOCAL_SYSTEM_ID = 'local-system';
const SYSTEM_ID = 'system';

function localSystemPrincipal() {
  return Object.freeze({
    id: LOCAL_SYSTEM_ID,
    username: LOCAL_SYSTEM_ID,
    type: 'system',
    authenticated: true,
    isAdmin: true,
    isActive: true,
    permissions: Object.freeze([]),
    groups: Object.freeze([]),
    fullName: 'Local system',
  });
}

function systemPrincipal(reason) {
  return Object.freeze({
    id: SYSTEM_ID,
    username: SYSTEM_ID,
    type: 'system',
    authenticated: true,
    isAdmin: true,
    isActive: true,
    permissions: Object.freeze([]),
    groups: Object.freeze([]),
    fullName: 'System',
    reason: String(reason || 'background').slice(0, 120),
  });
}

function isSystemPrincipal(principal) {
  return Boolean(principal) && principal.type === 'system';
}

function publicPrincipal(principal) {
  if (!principal) return null;
  return {
    id: principal.id,
    username: principal.username,
    fullName: principal.fullName || principal.username,
    type: principal.type || 'user',
    authenticated: principal.authenticated !== false,
    isAdmin: Boolean(principal.isAdmin),
    isActive: principal.isActive !== false,
    permissions: Array.isArray(principal.permissions) ? principal.permissions : [],
    groups: Array.isArray(principal.groups) ? principal.groups : [],
    playerId: principal.playerId || null,
    player: principal.player || null,
    createdAt: principal.createdAt,
    updatedAt: principal.updatedAt,
  };
}

function actorName(principal) {
  if (!principal) return 'anonymous';
  if (principal.reason) return `${principal.username}:${principal.reason}`;
  return String(principal.username || principal.id || 'unknown');
}

module.exports = {
  LOCAL_SYSTEM_ID,
  SYSTEM_ID,
  localSystemPrincipal,
  systemPrincipal,
  isSystemPrincipal,
  publicPrincipal,
  actorName,
};
