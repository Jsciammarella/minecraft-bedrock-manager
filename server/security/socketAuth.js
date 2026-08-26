const JOIN_ERROR = 'join-error';
const COMMAND_ERROR = 'command-error';
const SERVER_ERROR = 'server-error';
const GENERIC_JOIN = 'Unable to subscribe to that server';
const GENERIC_COMMAND = 'Unable to send a command to that server';
const GENERIC_START = 'Unable to start that server';
const GENERIC_STOP = 'Unable to stop that server';
const CONSOLE_DENIED = 'You do not have permission to view this server console';
const COMMAND_DENIED = 'You do not have permission to send console commands';
const START_DENIED = 'You do not have permission to start this server';
const STOP_DENIED = 'You do not have permission to stop this server';

function normalizeServerId(raw) {
  const text = typeof raw === 'number' && Number.isInteger(raw)
    ? String(raw)
    : String(raw ?? '').trim();
  if (!/^[1-9]\d{0,9}$/.test(text)) return null;
  const id = Number(text);
  if (!Number.isSafeInteger(id)) return null;
  return id;
}

function deps(overrides = {}) {
  return {
    authorize: overrides.authorize || ((principal, action, resource) => (
      require('./index').authorize(principal, action, resource)
    )),
    getServer: overrides.getServer || ((id) => require('../services/serverManager').getServer(id)),
    startPermissionForKind: overrides.startPermissionForKind
      || ((kind) => require('../services/permissionCatalog').startPermissionForKind(kind)),
    stopPermissionForKind: overrides.stopPermissionForKind
      || ((kind) => require('../services/permissionCatalog').stopPermissionForKind(kind)),
    startServer: overrides.startServer || ((id) => require('../services/serverManager').startServer(id)),
    stopServer: overrides.stopServer || ((id) => require('../services/serverManager').stopServer(id)),
    sendCommand: overrides.sendCommand || ((id, command) => require('../services/serverManager').sendCommand(id, command)),
  };
}

function canView(authorize, principal, server) {
  return Boolean(server) && Boolean(authorize(principal, 'servers.view_details', server));
}

function fail(event, error, extra = {}) {
  return { ok: false, event, error, ...extra };
}

function authorizeJoin(principal, rawId, overrides) {
  const { authorize, getServer } = deps(overrides);
  const id = normalizeServerId(rawId);
  if (id == null) return fail(JOIN_ERROR, GENERIC_JOIN);
  const server = getServer(id);
  if (!canView(authorize, principal, server)) return fail(JOIN_ERROR, GENERIC_JOIN);
  if (!authorize(principal, 'servers.console.view', server)) {
    return fail(JOIN_ERROR, CONSOLE_DENIED, { serverId: id });
  }
  return { ok: true, room: `server-${id}`, serverId: id, server };
}

function authorizeCommand(principal, rawId, overrides) {
  const { authorize, getServer } = deps(overrides);
  const id = normalizeServerId(rawId);
  if (id == null) return fail(COMMAND_ERROR, GENERIC_COMMAND);
  const server = getServer(id);
  if (!canView(authorize, principal, server)) return fail(COMMAND_ERROR, GENERIC_COMMAND);
  if (!authorize(principal, 'servers.console.send_commands', server)) {
    return fail(COMMAND_ERROR, COMMAND_DENIED, { serverId: id });
  }
  return { ok: true, serverId: id, server };
}

function authorizeStart(principal, rawId, overrides) {
  const { authorize, getServer, startPermissionForKind } = deps(overrides);
  const id = normalizeServerId(rawId);
  if (id == null) return fail(SERVER_ERROR, GENERIC_START);
  const server = getServer(id);
  if (!canView(authorize, principal, server)) return fail(SERVER_ERROR, GENERIC_START, { serverId: id });
  const permission = startPermissionForKind(server.kind);
  if (!authorize(principal, permission, server)) {
    return fail(SERVER_ERROR, START_DENIED, { serverId: id });
  }
  return { ok: true, serverId: id, server };
}

function authorizeStop(principal, rawId, overrides) {
  const { authorize, getServer, stopPermissionForKind } = deps(overrides);
  const id = normalizeServerId(rawId);
  if (id == null) return fail(SERVER_ERROR, GENERIC_STOP);
  const server = getServer(id);
  if (!canView(authorize, principal, server)) return fail(SERVER_ERROR, GENERIC_STOP, { serverId: id });
  const permission = stopPermissionForKind(server.kind);
  if (!authorize(principal, permission, server)) {
    return fail(SERVER_ERROR, STOP_DENIED, { serverId: id });
  }
  return { ok: true, serverId: id, server };
}

function emitServerStatus(io, payload, overrides) {
  if (!io || !payload) return;
  const { authorize, getServer } = deps(overrides);
  const id = normalizeServerId(payload.serverId);
  const server = id == null ? null : getServer(id);
  const sockets = io.sockets && io.sockets.sockets;
  if (!sockets) return;
  for (const sock of sockets.values()) {
    if (!sock.principal) continue;
    if (canView(authorize, sock.principal, server)) {
      sock.emit('server-status', payload);
    }
  }
}

function attach(io, options = {}) {
  const security = require('./index');
  const logger = require('../services/logger');

  io.use((socket, next) => {
    try {
      const { principal } = security.authenticate({
        headers: {
          cookie: socket.handshake.headers?.cookie || '',
          authorization: socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : '',
        },
      });
      if (!principal) return next(new Error('Authentication required'));
      socket.principal = principal;
      socket.user = principal;
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id} (${socket.user?.username || 'unknown'})`);

    socket.on('join-server', (serverId) => {
      const result = authorizeJoin(socket.principal, serverId, options);
      if (!result.ok) {
        socket.emit(result.event, { error: result.error, serverId: result.serverId });
        return;
      }
      socket.join(result.room);
      logger.info(`Client ${socket.id} joined ${result.room}`);
    });

    socket.on('leave-server', (serverId) => {
      const id = normalizeServerId(serverId);
      if (id == null) return;
      socket.leave(`server-${id}`);
    });

    socket.on('send-command', async ({ serverId, command } = {}) => {
      try {
        const result = authorizeCommand(socket.principal, serverId, options);
        if (!result.ok) {
          socket.emit(result.event, { error: result.error, serverId: result.serverId });
          return;
        }
        const { sendCommand } = deps(options);
        await sendCommand(result.serverId, command);
        socket.emit('command-sent', { success: true, command });
      } catch (err) {
        socket.emit(COMMAND_ERROR, { error: err.message });
      }
    });

    socket.on('start-server', async (serverId) => {
      try {
        const result = authorizeStart(socket.principal, serverId, options);
        if (!result.ok) {
          socket.emit(result.event, { error: result.error, serverId: serverId });
          return;
        }
        const { startServer } = deps(options);
        await startServer(result.serverId);
        const status = result.server?.status || 'running';
        emitServerStatus(io, { serverId: result.serverId, status }, options);
      } catch (err) {
        socket.emit(SERVER_ERROR, { serverId, error: err.message });
      }
    });

    socket.on('stop-server', async (serverId) => {
      try {
        const result = authorizeStop(socket.principal, serverId, options);
        if (!result.ok) {
          socket.emit(result.event, { error: result.error, serverId: serverId });
          return;
        }
        const { stopServer } = deps(options);
        await stopServer(result.serverId);
        const status = result.server?.status || 'stopped';
        emitServerStatus(io, { serverId: result.serverId, status }, options);
      } catch (err) {
        socket.emit(SERVER_ERROR, { serverId, error: err.message });
      }
    });

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });
}

module.exports = {
  JOIN_ERROR,
  COMMAND_ERROR,
  SERVER_ERROR,
  GENERIC_JOIN,
  GENERIC_COMMAND,
  GENERIC_START,
  GENERIC_STOP,
  CONSOLE_DENIED,
  COMMAND_DENIED,
  START_DENIED,
  STOP_DENIED,
  normalizeServerId,
  authorizeJoin,
  authorizeCommand,
  authorizeStart,
  authorizeStop,
  emitServerStatus,
  attach,
};
