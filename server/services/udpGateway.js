const dgram = require('dgram');
const dns = require('dns').promises;
const net = require('net');
const logger = require('./logger');

const MAX_REMOTE_SERVERS = 10;
const IDLE_MS = 90 * 1000;
const MAX_SESSIONS = 128;
const SWEEP_MS = 15 * 1000;

const gateways = new Map();

function normalizeHost(raw) {
  let host = String(raw || '').trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host;
}

function validateRemoteHost(raw) {
  const host = normalizeHost(raw);
  if (!host) throw new Error('Remote IP or hostname is required');
  if (host.length > 253) throw new Error('Remote host is too long');
  if (/[\s/\\@?#]/.test(host)) throw new Error('Remote host contains invalid characters');
  if (net.isIP(host)) return host;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(host)) {
    throw new Error(`Remote host '${host}' is not a valid IP address or hostname`);
  }
  return host;
}

function validateUdpPort(value, label) {
  const port = parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return port;
}

async function resolveRemote(host) {
  const normalized = validateRemoteHost(host);
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return { host: normalized, address4: normalized, address6: null };
  }
  if (ipVersion === 6) {
    return { host: normalized, address4: null, address6: normalized };
  }
  let records;
  try {
    records = await dns.lookup(normalized, { all: true });
  } catch (err) {
    throw new Error(`Could not resolve remote host '${normalized}': ${err.message}`);
  }
  if (!records.length) throw new Error(`Could not resolve remote host '${normalized}'`);
  const v4 = records.find((row) => row.family === 4);
  const v6 = records.find((row) => row.family === 6);
  return {
    host: normalized,
    address4: v4?.address || null,
    address6: v6?.address || null,
  };
}

function bindSocket(type, port, address) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type, reuseAddr: false });
    const fail = (err) => {
      socket.removeAllListeners();
      try { socket.close(); } catch { /* ignore */ }
      reject(err);
    };
    socket.once('error', fail);
    socket.bind(port, address, () => {
      socket.removeListener('error', fail);
      try {
        socket.setRecvBufferSize(1024 * 1024);
        socket.setSendBufferSize(1024 * 1024);
      } catch { /* platform may not allow this */ }
      resolve(socket);
    });
  });
}

class UdpGateway {
  constructor(options) {
    this.serverId = Number(options.serverId);
    this.name = options.name || `server-${this.serverId}`;
    this.localPort = options.localPort;
    this.localIpv6Port = options.localIpv6Port || null;
    this.remoteHost = options.remoteHost;
    this.remoteIpv4Port = options.remoteIpv4Port;
    this.remoteIpv6Port = options.remoteIpv6Port || options.remoteIpv4Port;
    this.resolved = options.resolved;
    this.sessions = new Map();
    this.listen4 = null;
    this.listen6 = null;
    this.sweepTimer = null;
    this.stopped = false;
  }

  upstreamFor(family) {
    if (family === 6 && this.resolved.address6) {
      return { address: this.resolved.address6, port: this.remoteIpv6Port, type: 'udp6' };
    }
    if (this.resolved.address4) {
      return { address: this.resolved.address4, port: this.remoteIpv4Port, type: 'udp4' };
    }
    if (this.resolved.address6) {
      return { address: this.resolved.address6, port: this.remoteIpv6Port, type: 'udp6' };
    }
    throw new Error(`Remote host ${this.remoteHost} has no usable address`);
  }

  async start() {
    this.listen4 = await bindSocket('udp4', this.localPort, '0.0.0.0');
    this.listen4.on('error', (err) => {
      logger.error(`Remote gateway ${this.name} IPv4 error: ${err.message}`);
    });
    this.listen4.on('message', (msg, rinfo) => {
      try {
        this.forward(this.listen4, 4, msg, rinfo);
      } catch (err) {
        logger.warn(`Remote gateway ${this.name} IPv4 forward failed: ${err.message}`);
      }
    });

    if (this.localIpv6Port) {
      try {
        this.listen6 = await bindSocket('udp6', this.localIpv6Port, '::');
        this.listen6.on('error', (err) => {
          logger.error(`Remote gateway ${this.name} IPv6 error: ${err.message}`);
        });
        this.listen6.on('message', (msg, rinfo) => {
          try {
            this.forward(this.listen6, 6, msg, rinfo);
          } catch (err) {
            logger.warn(`Remote gateway ${this.name} IPv6 forward failed: ${err.message}`);
          }
        });
      } catch (err) {
        logger.warn(`Remote gateway ${this.name} could not bind IPv6 ${this.localIpv6Port}: ${err.message}`);
        this.listen6 = null;
      }
    }

    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
    logger.info(
      `Remote gateway ${this.name}: UDP ${this.localPort}`
      + `${this.listen6 ? ` / ${this.localIpv6Port}` : ''} -> ${this.remoteHost}:${this.remoteIpv4Port}`
    );
  }

  forward(listenSocket, family, msg, rinfo) {
    if (this.stopped) return;
    const key = `${family}|${rinfo.address}|${rinfo.port}`;
    let session = this.sessions.get(key);
    if (!session) {
      if (this.sessions.size >= MAX_SESSIONS) {
        throw new Error(`too many UDP sessions (max ${MAX_SESSIONS})`);
      }
      const upstream = this.upstreamFor(family);
      const sock = dgram.createSocket(upstream.type);
      try {
        sock.setRecvBufferSize(1024 * 1024);
        sock.setSendBufferSize(1024 * 1024);
      } catch { /* platform may not allow this */ }
      session = {
        sock,
        listenSocket,
        client: rinfo,
        upstream,
        lastSeen: Date.now(),
      };
      sock.on('message', (reply) => {
        session.lastSeen = Date.now();
        listenSocket.send(reply, rinfo.port, rinfo.address, (err) => {
          if (err) logger.warn(`Remote gateway ${this.name} reply failed: ${err.message}`);
        });
      });
      sock.on('error', (err) => {
        logger.warn(`Remote gateway ${this.name} session ${key}: ${err.message}`);
        this.dropSession(key);
      });
      this.sessions.set(key, session);
    }
    session.lastSeen = Date.now();
    session.sock.send(msg, session.upstream.port, session.upstream.address);
  }

  dropSession(key) {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    try { session.sock.close(); } catch { /* ignore */ }
  }

  sweep() {
    const cutoff = Date.now() - IDLE_MS;
    for (const [key, session] of this.sessions) {
      if (session.lastSeen < cutoff) this.dropSession(key);
    }
  }

  stop() {
    this.stopped = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const key of [...this.sessions.keys()]) this.dropSession(key);
    for (const socket of [this.listen4, this.listen6]) {
      if (!socket) continue;
      try { socket.close(); } catch { /* ignore */ }
    }
    this.listen4 = null;
    this.listen6 = null;
  }
}

async function start(server) {
  const id = Number(server.id);
  await stop(id);
  const resolved = await resolveRemote(server.remote_host);
  const gateway = new UdpGateway({
    serverId: id,
    name: server.name,
    localPort: Number(server.port),
    localIpv6Port: server.ipv6_port != null ? Number(server.ipv6_port) : null,
    remoteHost: resolved.host,
    remoteIpv4Port: validateUdpPort(server.remote_ipv4_port, 'Remote IPv4 port'),
    remoteIpv6Port: server.remote_ipv6_port != null && server.remote_ipv6_port !== ''
      ? validateUdpPort(server.remote_ipv6_port, 'Remote IPv6 port')
      : validateUdpPort(server.remote_ipv4_port, 'Remote IPv4 port'),
    resolved,
  });
  try {
    await gateway.start();
  } catch (err) {
    gateway.stop();
    throw err;
  }
  gateways.set(id, gateway);
  return gateway;
}

async function stop(serverId) {
  const id = Number(serverId);
  const gateway = gateways.get(id);
  if (!gateway) return;
  gateway.stop();
  gateways.delete(id);
}

function stopAll() {
  for (const id of [...gateways.keys()]) stop(id);
}

function isActive(serverId) {
  return gateways.has(Number(serverId));
}

module.exports = {
  IDLE_MS,
  MAX_REMOTE_SERVERS,
  MAX_SESSIONS,
  isActive,
  normalizeHost,
  resolveRemote,
  start,
  stop,
  stopAll,
  validateRemoteHost,
  validateUdpPort,
};
