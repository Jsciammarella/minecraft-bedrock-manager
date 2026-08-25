const listeners = new Set();

function subscribe(fn) {
  if (typeof fn === 'function') listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(type, payload = {}) {
  const event = { type: String(type || ''), at: new Date().toISOString(), ...payload };
  for (const fn of listeners) {
    try { fn(event); } catch { /* ignore listener failures */ }
  }
  try {
    require('./bedrockConnectList').scheduleSync();
  } catch { /* Bedrock Connect may be unavailable in tests */ }
  try {
    if (global.io) global.io.emit('dashboard-refresh', { type: event.type });
  } catch { /* sockets optional */ }
}

module.exports = { emit, emit: emit, subscribe };
