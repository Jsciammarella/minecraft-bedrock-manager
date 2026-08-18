const logger = require('./logger');
const platform = require('./platform');

const HEALTHY_INTERVAL_MS = 5 * 60 * 1000;
const RECOVERY_INTERVAL_MS = 30 * 1000;
const HEALTHY_BURST = 3;
const PING_TIMEOUT_MS = 2000;

const monitors = new Map();

function keyFor(serverId) {
  return Number(serverId);
}

function reachable(serverId) {
  const mon = monitors.get(keyFor(serverId));
  if (!mon || typeof mon.reachable !== 'boolean') return null;
  return mon.reachable;
}

async function pingBurst(host, count) {
  const n = Math.max(1, Number(count) || 1);
  for (let i = 0; i < n; i += 1) {
    if (await platform.pingHost(host, PING_TIMEOUT_MS)) return true;
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
    const nextReachable = await pingBurst(mon.host, count);
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
  stop(id);
  if (!host) return;
  const mon = {
    host,
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
  reachable,
  start,
  stop,
  stopAll,
};
