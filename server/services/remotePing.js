const dgram = require('dgram');
const net = require('net');
const logger = require('./logger');

const HEALTHY_INTERVAL_MS = 5 * 60 * 1000;
const RECOVERY_INTERVAL_MS = 30 * 1000;
const HEALTHY_BURST = 3;
const PING_TIMEOUT_MS = 2000;
const RAKNET_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

const monitors = new Map();

function keyFor(serverId) {
  return Number(serverId);
}

function reachable(serverId) {
  const mon = monitors.get(keyFor(serverId));
  if (!mon || typeof mon.reachable !== 'boolean') return null;
  return mon.reachable;
}

function buildUnconnectedPing() {
  const buf = Buffer.alloc(1 + 8 + 16 + 8);
  buf[0] = 0x01;
  buf.writeBigUInt64BE(BigInt(Date.now()), 1);
  RAKNET_MAGIC.copy(buf, 9);
  buf.writeBigUInt64BE(BigInt(process.pid || 1), 25);
  return buf;
}

function isPong(msg) {
  return Buffer.isBuffer(msg) && msg.length > 0 && msg[0] === 0x1c;
}

function probeBedrock(host, port, timeoutMs = PING_TIMEOUT_MS) {
  const target = String(host || '').trim();
  const destPort = Number(port);
  if (!target || target.startsWith('-') || !Number.isInteger(destPort) || destPort < 1 || destPort > 65535) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const type = net.isIP(target) === 6 ? 'udp6' : 'udp4';
    let socket;
    try {
      socket = dgram.createSocket(type);
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      resolve(Boolean(ok));
    };
    const timer = setTimeout(() => finish(false), Math.max(500, Number(timeoutMs) || PING_TIMEOUT_MS));
    socket.once('error', () => finish(false));
    socket.on('message', (msg) => {
      if (isPong(msg)) finish(true);
    });
    const send = () => {
      socket.send(buildUnconnectedPing(), destPort, target, (err) => {
        if (err) finish(false);
      });
    };
    try {
      send();
    } catch {
      finish(false);
    }
  });
}

async function pingBurst(host, port, count) {
  const n = Math.max(1, Number(count) || 1);
  for (let i = 0; i < n; i += 1) {
    if (await probeBedrock(host, port, PING_TIMEOUT_MS)) return true;
  }
  return false;
}

function stop(serverId) {
  const id = keyFor(serverId);
  const mon = monitors.get(id);
  if (!mon) return;
  mon.stopped = true;
  if (mon.timer) clearTimeout(mon.timer);
  monitors.delete(id);
}

function stopAll() {
  for (const id of [...monitors.keys()]) stop(id);
}

function schedule(id, delayMs) {
  const mon = monitors.get(id);
  if (!mon || mon.stopped) return;
  if (mon.timer) clearTimeout(mon.timer);
  mon.timer = setTimeout(() => {
    mon.timer = null;
    runCycle(id).catch((err) => {
      logger.warn(`Remote ping for ${mon.name || id} failed: ${err.message}`);
    });
  }, delayMs);
}

async function runCycle(id) {
  const mon = monitors.get(id);
  if (!mon || mon.stopped || mon.inFlight) return;
  mon.inFlight = true;
  try {
    const count = mon.reachable === false ? 1 : HEALTHY_BURST;
    const nextReachable = await pingBurst(mon.host, mon.port, count);
    if (mon.stopped || monitors.get(id) !== mon) return;
    const changed = mon.reachable !== nextReachable;
    mon.reachable = nextReachable;
    if (changed && typeof mon.onChange === 'function') {
      try { mon.onChange(id, nextReachable); } catch { /* ignore */ }
    }
    schedule(id, nextReachable ? mon.healthyMs : mon.recoveryMs);
  } finally {
    if (monitors.get(id) === mon) mon.inFlight = false;
  }
}

function start(server, options = {}) {
  if (!server) return;
  const id = keyFor(server.id);
  const host = String(server.remote_host || '').trim();
  const port = Number(server.remote_ipv4_port);
  stop(id);
  if (!host || !Number.isInteger(port)) return;
  const mon = {
    host,
    port,
    name: server.name,
    reachable: null,
    timer: null,
    inFlight: false,
    stopped: false,
    healthyMs: Number(options.healthyMs) > 0 ? Number(options.healthyMs) : HEALTHY_INTERVAL_MS,
    recoveryMs: Number(options.recoveryMs) > 0 ? Number(options.recoveryMs) : RECOVERY_INTERVAL_MS,
    onChange: options.onChange,
  };
  monitors.set(id, mon);
  runCycle(id).catch((err) => {
    logger.warn(`Remote ping for ${server.name || id} failed: ${err.message}`);
  });
}

module.exports = {
  HEALTHY_BURST,
  HEALTHY_INTERVAL_MS,
  RECOVERY_INTERVAL_MS,
  pingBurst,
  probeBedrock,
  reachable,
  start,
  stop,
  stopAll,
};
