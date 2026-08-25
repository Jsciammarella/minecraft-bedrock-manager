const crypto = require('crypto');
const path = require('path');
const db = require('../db/connection');
const logger = require('./logger');
const platform = require('./platform');
const processControl = require('./processControl');
const bedrockConnect = require('./bedrockConnect');
const portRanges = require('./portRanges');

const BIND_FAILURE_RE = /address already in use|bind(?:ing)? failed|bindexception|failed to bind|cannot bind|could not bind/i;
const DEFAULTS = {
  gracefulStopMs: 8000,
  forceStopMs: 5000,
  startupBindMs: 15000,
  pollMs: 100,
};

let hooks = {};
let lock = Promise.resolve();
const sessions = new Map();

function sm() {
  return require('./serverManager');
}

function list() {
  return require('./bedrockConnectList');
}

function configure(overrides = {}) {
  hooks = { ...hooks, ...overrides };
}

function resetForTests() {
  hooks = {};
  lock = Promise.resolve();
  sessions.clear();
  try { list().resetForTests(); } catch { /* list optional during isolated tests */ }
}

function sessionKey(serverId) {
  return String(serverId);
}

function currentSession(serverId) {
  if (serverId == null) {
    const first = sessions.values().next();
    return first.done ? null : first.value;
  }
  return sessions.get(sessionKey(serverId)) || null;
}

function isTrackedPty(serverId, pty) {
  const session = currentSession(serverId);
  return Boolean(session && session.pty === pty);
}

function withLock(fn) {
  const run = lock.then(() => fn(), () => fn());
  lock = run.then(() => undefined, () => undefined);
  return run;
}

function option(name, fallback) {
  const value = hooks[name];
  return value == null ? fallback : value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function persistStatus(serverId, status, { pid, reason, started } = {}) {
  const sets = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const params = [status];
  if (pid === null) {
    sets.push('pid = NULL');
  } else if (pid !== undefined) {
    sets.push('pid = ?');
    params.push(pid);
  }
  if (reason !== undefined) {
    sets.push('pending_restart_reason = ?');
    params.push(reason);
  }
  if (status === 'running') {
    sets.push('pending_restart = 0', 'pending_restart_reason = NULL', 'pending_restart_at = NULL', 'restart_scheduled_at = NULL');
  }
  if (status === 'starting' && started !== false) {
    sets.push('started_at = CURRENT_TIMESTAMP');
  }
  if (status === 'stopped') {
    sets.push('started_at = NULL');
    if (pid === undefined) sets.push('pid = NULL');
  }
  params.push(serverId);
  db.prepare(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  sm().invalidateServerCache(serverId);
  sm().broadcastServerStatus(serverId);
}

function occupiedPortsFor(pid) {
  const owned = [];
  return Promise.all([
    processControl.pidOwnsUdpPort(pid, portRanges.DISCOVERY_IPV4),
    processControl.pidOwnsUdpPort(pid, portRanges.DISCOVERY_IPV6),
  ]).then(([v4, v6]) => {
    if (v4 === true) owned.push(portRanges.DISCOVERY_IPV4);
    if (v6 === true) owned.push(portRanges.DISCOVERY_IPV6);
    return owned;
  });
}

async function isUdpAvailable(port, family = 'ipv4') {
  if (family === 'ipv6') {
    if (typeof hooks.isUdp6Available === 'function') return hooks.isUdp6Available(port);
    return sm().isUdp6PortAvailable(port);
  }
  if (typeof hooks.isUdpAvailable === 'function') return hooks.isUdpAvailable(port);
  return sm().isUdpPortAvailable(port);
}

function pidAlive(pid) {
  if (typeof hooks.isPidAlive === 'function') return hooks.isPidAlive(pid);
  return processControl.isPidAlive(pid);
}

async function waitPid(pid, timeoutMs) {
  if (typeof hooks.waitForPidExit === 'function') return hooks.waitForPidExit(pid, timeoutMs);
  return processControl.waitForPidExit(pid, timeoutMs, option('pollMs', DEFAULTS.pollMs));
}

async function ownsPort(pid, port) {
  if (typeof hooks.pidOwnsUdpPort === 'function') return hooks.pidOwnsUdpPort(pid, port);
  return processControl.pidOwnsUdpPort(pid, port);
}

async function ownerPids(port) {
  if (typeof hooks.udpOwnerPids === 'function') return hooks.udpOwnerPids(port);
  return processControl.udpOwnerPids(port);
}

async function terminateTree(opts) {
  if (typeof hooks.terminateProcessTree === 'function') return hooks.terminateProcessTree(opts);
  return processControl.terminateProcessTree(opts);
}

function dropSession(session, { keepPty = false } = {}) {
  if (!session) return;
  const key = sessionKey(session.serverId);
  const current = sessions.get(key);
  if (current && current.token !== session.token) return;
  sessions.delete(key);
  if (!keepPty) {
    const ptyMap = sm().ptySessions;
    if (ptyMap.get(key) === session.pty) ptyMap.delete(key);
  }
}

function handlePtyExit(serverId, pty) {
  const session = currentSession(serverId);
  if (!session || session.pty !== pty) {
    logger.info('Ignoring stale Bedrock Connect PTY exit', { serverId, token: session?.token });
    return;
  }
  session.exited = true;
  if (session.lifecycleStatus === 'stopping') return;
  if (currentSession(serverId)?.token !== session.token) {
    logger.info('Ignoring stale Bedrock Connect PTY exit', { serverId, token: session.token });
    return;
  }
  dropSession(session);
  if (session.lifecycleStatus === 'starting') {
    persistStatus(serverId, 'failed', {
      pid: null,
      reason: 'Bedrock Connect exited before UDP 19132 was bound',
    });
    return;
  }
  persistStatus(serverId, 'stopped', { pid: null });
  logger.info(`Server process for ${serverId} exited; status changed to stopped`);
  sm().restoreLanBroadcasts().catch((err) => {
    logger.warn(`LAN broadcast restore after Bedrock Connect exit failed: ${err.message}`);
  });
}

function looksLikeBindFailure(text) {
  return BIND_FAILURE_RE.test(String(text || ''));
}

async function waitForTrackedBind(session) {
  const timeoutMs = option('startupBindMs', DEFAULTS.startupBindMs);
  const pollMs = option('pollMs', DEFAULTS.pollMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.exited || !pidAlive(session.pid)) {
      throw new Error('Bedrock Connect exited before UDP 19132 was bound');
    }
    if (looksLikeBindFailure(session.output)) {
      throw new Error('Bedrock Connect failed to bind UDP 19132');
    }
    const busy = !(await isUdpAvailable(portRanges.DISCOVERY_IPV4, 'ipv4'));
    if (busy) {
      const owns = await ownsPort(session.pid, portRanges.DISCOVERY_IPV4);
      if (owns === true) {
        logger.info('Successful port ownership validation', {
          pid: session.pid,
          port: portRanges.DISCOVERY_IPV4,
          token: session.token,
          verified: true,
        });
        return { verified: true };
      }
      if (owns === false) {
        const owners = await ownerPids(portRanges.DISCOVERY_IPV4);
        throw new Error(
          `UDP 19132 is occupied by PID ${owners.join(', ') || 'unknown'}, not tracked BedrockConnect PID ${session.pid}`
        );
      }
      logger.info('Successful port ownership validation', {
        pid: session.pid,
        port: portRanges.DISCOVERY_IPV4,
        token: session.token,
        verified: false,
      });
      return { verified: false };
    }
    await sleep(pollMs);
  }
  throw new Error('Startup timeout waiting for UDP 19132');
}

async function stopUnlocked(server, { failedStart = false } = {}) {
  const key = sessionKey(server.id);
  const session = currentSession(server.id);
  if (!session) {
    if (server.status === 'stopped' && !failedStart) {
      throw new Error('Server already stopped');
    }
    persistStatus(server.id, 'stopped', { pid: null, reason: failedStart ? server.pending_restart_reason : null });
    return { success: true, message: 'Server stopped' };
  }

  session.lifecycleStatus = 'stopping';
  persistStatus(server.id, 'stopping', { pid: session.pid });
  logger.info('PID receiving graceful termination', {
    pid: session.pid,
    token: session.token,
    serverId: server.id,
  });

  const gracefulMs = option('gracefulStopMs', DEFAULTS.gracefulStopMs);
  const exitWait = new Promise((resolve) => {
    if (session.exited) return resolve('exit');
    const timer = setTimeout(() => resolve('timeout'), gracefulMs);
    try {
      session.pty.once('exit', () => {
        clearTimeout(timer);
        resolve('exit');
      });
    } catch {
      resolve('timeout');
    }
  });

  try { session.pty.kill(); } catch { /* ignore */ }
  if (typeof hooks.signalPid === 'function') hooks.signalPid(session.pid, 'SIGTERM');
  else processControl.signalPid(session.pid, 'SIGTERM');

  const outcome = await exitWait;
  let gone = !pidAlive(session.pid);
  if (!gone) gone = await waitPid(session.pid, option('pollMs', DEFAULTS.pollMs) * 4);

  if (!gone && outcome === 'timeout') {
    logger.warn('Graceful termination timeout', { pid: session.pid, token: session.token });
    const term = await terminateTree({
      pid: session.pid,
      identity: {
        pid: session.pid,
        jarPath: session.jarPath,
        mustInclude: ['BedrockConnect'],
      },
      gracefulMs: option('forceStopMs', DEFAULTS.forceStopMs),
      forceMs: option('forceStopMs', DEFAULTS.forceStopMs),
      verify: true,
    });
    if (!term.ok) {
      const ports = await occupiedPortsFor(session.pid);
      logger.error('Bedrock Connect termination failed', {
        pid: session.pid,
        token: session.token,
        ports,
      });
      persistStatus(server.id, 'failed', {
        pid: session.pid,
        reason: `Previous BedrockConnect process remains active (PID ${session.pid}${ports.length ? `, ports ${ports.join('/')}` : ''})`,
      });
      throw new Error(
        `Previous BedrockConnect process remains active (PID ${session.pid}${ports.length ? `, ports ${ports.join('/')}` : ''}). Replacement was not launched.`
      );
    }
    gone = await waitPid(session.pid, option('forceStopMs', DEFAULTS.forceStopMs));
  }

  if (pidAlive(session.pid)) {
    const ports = await occupiedPortsFor(session.pid);
    logger.error('Bedrock Connect termination failed', { pid: session.pid, ports });
    persistStatus(server.id, 'failed', {
      pid: session.pid,
      reason: `Previous BedrockConnect process remains active (PID ${session.pid})`,
    });
    throw new Error(
      `Previous BedrockConnect process remains active (PID ${session.pid}). Replacement was not launched.`
    );
  }

  const stillOwned = [];
  if (await ownsPort(session.pid, portRanges.DISCOVERY_IPV4) === true) stillOwned.push(portRanges.DISCOVERY_IPV4);
  if (await ownsPort(session.pid, portRanges.DISCOVERY_IPV6) === true) stillOwned.push(portRanges.DISCOVERY_IPV6);
  if (stillOwned.length) {
    logger.error('UDP ports remained owned after Bedrock Connect exit', {
      pid: session.pid,
      ports: stillOwned,
    });
    persistStatus(server.id, 'failed', {
      pid: session.pid,
      reason: `BedrockConnect PID ${session.pid} still owns UDP ${stillOwned.join('/')}`,
    });
    throw new Error(
      `Previous BedrockConnect process remains active (PID ${session.pid}, ports ${stillOwned.join('/')}). Replacement was not launched.`
    );
  }

  logger.info('Confirmed process exit', { pid: session.pid, token: session.token });
  logger.info('UDP port release', { pid: session.pid, ports: [portRanges.DISCOVERY_IPV4, portRanges.DISCOVERY_IPV6] });

  if (currentSession(server.id)?.token === session.token) {
    dropSession(session);
  }

  if (!failedStart) {
    persistStatus(server.id, 'stopped', { pid: null, reason: null });
    logger.info(`Server ${server.name} stopped`);
  }
  sm().restoreLanBroadcasts().catch((err) => {
    logger.warn(`LAN broadcast restore after Bedrock Connect stop failed: ${err.message}`);
  });
  return { success: true, message: 'Server stopped' };
}

async function startUnlocked(server) {
  const key = sessionKey(server.id);
  const existing = currentSession(server.id);
  if (existing && pidAlive(existing.pid)) {
    throw new Error(
      `A replacement is not launched while the old BedrockConnect PID ${existing.pid} remains alive`
    );
  }
  if (existing) dropSession(existing);

  if (typeof hooks.releaseDiscoveryPorts === 'function') {
    await hooks.releaseDiscoveryPorts();
  } else {
    await sm().releaseDiscoveryPortsForBedrockConnect();
  }

  const v4Free = await isUdpAvailable(portRanges.DISCOVERY_IPV4, 'ipv4');
  const v6Free = await isUdpAvailable(portRanges.DISCOVERY_IPV6, 'ipv6');
  if (!v4Free || !v6Free) {
    const owners = [
      ...(await ownerPids(portRanges.DISCOVERY_IPV4)),
      ...(await ownerPids(portRanges.DISCOVERY_IPV6)),
    ];
    const unique = [...new Set(owners)];
    const message = `UDP 19132/19133 remain occupied${unique.length ? ` (PIDs ${unique.join(', ')})` : ''}. Bedrock Connect was not launched.`;
    persistStatus(server.id, 'failed', { pid: null, reason: message });
    throw new Error(message);
  }

  if (typeof hooks.assertJava === 'function') await hooks.assertJava();
  else await bedrockConnect.assertJavaAvailable();

  const installed = typeof hooks.installedJar === 'function'
    ? hooks.installedJar(server.data_path)
    : (bedrockConnect.installedJar(server.data_path) || bedrockConnect.installJarInto(server.data_path, server.version));
  if (!installed?.jarPath) {
    throw new Error('Bedrock Connect JAR is not available');
  }

  const written = list().writeList();
  const token = `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
  const spawnPty = hooks.spawnPty || require('node-pty').spawn;
  const javaBin = hooks.javaCommand || platform.javaCommand();
  const args = ['-jar', installed.jarPath, ...list().spawnArgs(server.data_path)];

  let pty;
  try {
    pty = spawnPty(javaBin, args, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: server.data_path,
      env: { ...process.env },
    });
  } catch (err) {
    persistStatus(server.id, 'failed', { pid: null, reason: err.message });
    throw new Error(`Failed to start Bedrock Connect: ${err.message}`);
  }

  const pid = Number(pty.pid);
  pty.__bcToken = token;
  const session = {
    serverId: server.id,
    pty,
    pid,
    token,
    startedAt: Date.now(),
    listGeneration: written.generation,
    listHash: written.hash,
    jarPath: path.resolve(installed.jarPath),
    lifecycleStatus: 'starting',
    output: '',
    exited: false,
  };
  sessions.set(key, session);
  sm().ptySessions.set(key, pty);
  logger.info('PID launched', {
    pid,
    token,
    listGeneration: written.generation,
    hash: written.hash,
    count: written.servers.length,
    path: written.path,
    jarPath: session.jarPath,
  });

  sm().setupPtyOutputBroadcast(server.id, pty);
  pty.on('data', (chunk) => {
    if (currentSession(server.id)?.token !== token) return;
    session.output = `${session.output}${chunk}`.slice(-8000);
  });

  persistStatus(server.id, 'starting', { pid, reason: null });

  try {
    const bind = await waitForTrackedBind(session);
    if (currentSession(server.id)?.token !== token) {
      throw new Error('Bedrock Connect session was replaced during startup');
    }
    session.lifecycleStatus = 'running';
    persistStatus(server.id, 'running', { pid });
    list().recordLoaded(written.generation, written.hash);
    logger.info('Bedrock Connect started', {
      pid,
      token,
      listGeneration: written.generation,
      hash: written.hash,
      portVerified: bind.verified,
    });
    return { success: true, message: 'Bedrock Connect started', pid, token };
  } catch (err) {
    logger.error(`Startup timeout or bind failure: ${err.message}`, {
      pid,
      token,
      listGeneration: written.generation,
    });
    try {
      await stopUnlocked(server, { failedStart: true });
    } catch (stopErr) {
      logger.error(`Failed start cleanup: ${stopErr.message}`, { pid, token });
      throw new Error(`Failed to start Bedrock Connect: ${err.message}. ${stopErr.message}`);
    }
    persistStatus(server.id, 'failed', { pid: null, reason: err.message });
    throw new Error(`Failed to start Bedrock Connect: ${err.message}`);
  }
}

async function restartUnlocked(server) {
  const latest = sm().getServer(server.id) || server;
  try {
    if (currentSession(latest.id) || !['stopped', 'failed'].includes(latest.status)) {
      await stopUnlocked(latest);
    }
  } catch (err) {
    throw err;
  }
  return startUnlocked(sm().getServer(server.id) || latest);
}

async function start(server) {
  return withLock(() => {
    const latest = sm().getServer(server.id) || server;
    const session = currentSession(latest.id);
    if (session && pidAlive(session.pid) && latest.status === 'running') {
      throw new Error('Server already running');
    }
    if (latest.status === 'starting') throw new Error('Server is already starting');
    if (latest.status === 'stopping') throw new Error('Server is stopping');
    return startUnlocked(latest);
  });
}

async function stop(server) {
  return withLock(() => stopUnlocked(server));
}

async function restart(serverOrId) {
  return withLock(async () => {
    const server = typeof serverOrId === 'object' && serverOrId
      ? serverOrId
      : sm().getServer(serverOrId);
    if (!server) throw new Error('Server not found');
    return restartUnlocked(server);
  });
}

async function syncRunningProcess(written) {
  return withLock(async () => {
    const server = sm().getBedrockConnectServer();
    if (!server) return { skipped: true };
    if (server.status === 'stopped' || server.status === 'failed' || server.status === 'stopping') {
      return { skipped: true, retained: true };
    }
    const session = currentSession(server.id);
    if (session && session.lifecycleStatus === 'running' && session.listHash === written.hash) {
      list().recordLoaded(written.generation, written.hash);
      return { skipped: true, current: true };
    }
    if (!session || !pidAlive(session.pid)) {
      return { skipped: true };
    }
    if (list().snapshot().restartInProgress) {
      logger.info('Restart coalesced because one is already active', {
        pid: session.pid,
        generation: written.generation,
      });
      return { coalesced: true };
    }
    logger.info('Restart requested', {
      pid: session.pid,
      fromGeneration: session.listGeneration,
      toGeneration: written.generation,
      path: written.path,
      count: written.servers.length,
    });
    list().setRestartInProgress(true);
    try {
      await restartUnlocked(server);
    } finally {
      list().setRestartInProgress(false);
    }
    return { restarted: true };
  });
}

async function afterJarUpdate(serverId) {
  return withLock(async () => {
    const server = sm().getServer(serverId);
    if (!server) return;
    const session = currentSession(serverId);
    if (session && pidAlive(session.pid)) {
      logger.info('Restart requested', { reason: 'jar-update', pid: session.pid, serverId });
      await restartUnlocked(server);
    }
  });
}

async function reconcileOnStartup() {
  const server = sm().getBedrockConnectServer();
  const jarPath = server
    ? (bedrockConnect.installedJar(server.data_path)?.jarPath || path.join(server.data_path, bedrockConnect.ASSET_NAME))
    : '';
  const owners = await ownerPids(portRanges.DISCOVERY_IPV4);
  if (!owners.length) {
    const busy = !(await isUdpAvailable(portRanges.DISCOVERY_IPV4, 'ipv4'));
    if (busy) {
      logger.error('UDP 19132 is occupied but ownership could not be verified; not terminating an unrelated service');
    }
    return { owners: [], adopted: false };
  }

  const killed = [];
  const unknown = [];
  for (const pid of owners) {
    const identity = typeof hooks.processIdentity === 'function'
      ? await hooks.processIdentity(pid)
      : await processControl.processIdentity(pid);
    if (processControl.isOurBedrockConnectIdentity(identity, jarPath)) {
      logger.warn('Found orphaned BedrockConnect process; terminating for a clean start', { pid });
      const result = await terminateTree({
        pid,
        identity: { pid, jarPath, mustInclude: ['BedrockConnect'] },
        verify: true,
      });
      if (result.ok) killed.push(pid);
      else unknown.push(pid);
    } else {
      logger.error('UDP 19132 is occupied by an unverified process; not terminating', {
        pid,
        cmdline: identity?.cmdline || '',
      });
      unknown.push(pid);
    }
  }
  return { owners, killed, unknown, adopted: false };
}

async function shutdown() {
  return withLock(async () => {
    const server = sm().getBedrockConnectServer();
    const session = server ? currentSession(server.id) : null;
    if (!server || !session) return { stopped: false };
    await stopUnlocked(server);
    return { stopped: true, pid: session.pid };
  });
}

module.exports = {
  afterJarUpdate,
  configure,
  currentSession,
  handlePtyExit,
  isTrackedPty,
  reconcileOnStartup,
  resetForTests,
  restart,
  shutdown,
  start,
  stop,
  syncRunningProcess,
  withLock,
};
