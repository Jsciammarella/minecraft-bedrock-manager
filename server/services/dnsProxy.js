const dgram = require('dgram');
const net = require('net');
const logger = require('./logger');
const dnsPacket = require('./dnsPacket');
const dnsSettings = require('./dnsSettings');

const DNS_PORT = 53;
const FORWARD_TIMEOUT_MS = 2000;

class DnsProxy {
  constructor() {
    this.udp = null;
    this.tcp = null;
    this.status = {
      running: false,
      address: '',
      port: DNS_PORT,
      error: '',
    };
    this.syncing = Promise.resolve();
  }

  getStatus() {
    return { ...this.status };
  }

  canRun() {
    try {
      const serverManager = require('./serverManager');
      return Boolean(serverManager.getBedrockConnectServer());
    } catch {
      return false;
    }
  }

  async sync() {
    this.syncing = this.syncing.then(() => this.apply()).catch((err) => {
      logger.warn(`DNS proxy sync failed: ${err.message}`);
    });
    return this.syncing;
  }

  async apply() {
    const config = dnsSettings.getConfig();
    const shouldRun = Boolean(config.enabled && this.canRun());
    if (!shouldRun) {
      await this.stop();
      if (config.enabled && !this.canRun()) {
        this.status.error = 'Create a Bedrock Connect server before enabling DNS';
      }
      return this.getStatus();
    }

    const address = dnsSettings.listenIp() || '0.0.0.0';
    if (this.status.running && this.status.address === address && this.status.port === DNS_PORT) {
      this.status.error = '';
      return this.getStatus();
    }

    await this.stop();
    try {
      await this.start(address, DNS_PORT);
    } catch (err) {
      this.status = {
        running: false,
        address,
        port: DNS_PORT,
        error: this.bindError(err, address),
      };
      logger.error(`DNS proxy failed to bind ${address}:${DNS_PORT}: ${err.message}`);
    }
    return this.getStatus();
  }

  bindError(err, address) {
    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      if (process.platform === 'win32') {
        return `Cannot bind ${address}:53. Run the manager as the Windows service (LocalSystem), or leave DNS off if another program owns port 53.`;
      }
      return `Cannot bind ${address}:53. Docker already runs as root; a native install needs CAP_NET_BIND_SERVICE.`;
    }
    if (err && err.code === 'EADDRINUSE') {
      if (process.platform === 'win32') {
        return `Port 53 is already in use on ${address}. Windows often uses it for Internet Connection Sharing or another DNS service. Stop that service or leave this DNS proxy off.`;
      }
      return `Port 53 is already in use on ${address}. Stop the other DNS service or bind conflict before enabling this proxy.`;
    }
    return err?.message || 'Failed to start the DNS proxy';
  }

  async start(address, port, { udpOnly = false } = {}) {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        udp.off('listening', onListening);
        try { udp.close(); } catch { /* ignore */ }
        reject(err);
      };
      const onListening = () => {
        udp.off('error', onError);
        resolve();
      };
      udp.once('error', onError);
      udp.once('listening', onListening);
      udp.bind(port, address);
    });
    udp.on('message', (msg, rinfo) => {
      this.handleQuery(msg).then((response) => {
        if (response) udp.send(response, rinfo.port, rinfo.address);
      }).catch((err) => {
        logger.warn(`DNS UDP query failed: ${err.message}`);
      });
    });
    udp.on('error', (err) => {
      logger.warn(`DNS UDP socket error: ${err.message}`);
    });

    let tcp = null;
    if (!udpOnly) {
      try {
        tcp = net.createServer((socket) => this.handleTcp(socket));
        await new Promise((resolve, reject) => {
          const onError = (err) => {
            tcp.off('listening', onListening);
            reject(err);
          };
          const onListening = () => {
            tcp.off('error', onError);
            resolve();
          };
          tcp.once('error', onError);
          tcp.once('listening', onListening);
          tcp.listen(port, address);
        });
        tcp.on('error', (err) => {
          logger.warn(`DNS TCP socket error: ${err.message}`);
        });
      } catch (err) {
        logger.warn(`DNS TCP bind failed on ${address}:${port}: ${err.message}`);
        tcp = null;
      }
    }

    this.udp = udp;
    this.tcp = tcp;
    this.status = {
      running: true,
      address,
      port,
      error: tcp ? '' : 'UDP DNS is listening; TCP 53 could not be bound',
    };
    logger.info(`DNS proxy listening on ${address}:${port}`);
    return this.getStatus();
  }

  async stop() {
    const udp = this.udp;
    const tcp = this.tcp;
    this.udp = null;
    this.tcp = null;
    await Promise.all([
      udp ? new Promise((resolve) => udp.close(resolve)) : Promise.resolve(),
      tcp ? new Promise((resolve) => tcp.close(() => resolve())) : Promise.resolve(),
    ]).catch(() => {});
    this.status = {
      running: false,
      address: '',
      port: DNS_PORT,
      error: '',
    };
  }

  handleTcp(socket) {
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const len = pending.readUInt16BE(0);
        if (pending.length < 2 + len) return;
        const query = pending.slice(2, 2 + len);
        pending = pending.slice(2 + len);
        this.handleQuery(query).then((response) => {
          if (!response || socket.destroyed) return;
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(response.length, 0);
          socket.write(Buffer.concat([prefix, response]));
        }).catch((err) => {
          logger.warn(`DNS TCP query failed: ${err.message}`);
        });
      }
    });
    socket.on('error', () => {});
  }

  async handleQuery(buf) {
    let parsed;
    try {
      parsed = dnsPacket.parseQuery(buf);
    } catch {
      return null;
    }
    if (parsed.class !== dnsPacket.CLASS_IN) return null;

    const hostname = dnsSettings.normalizeHostname(parsed.name);
    const ipv4 = dnsSettings.overrideMap().get(hostname);
    if (ipv4) {
      if (parsed.type === dnsPacket.TYPE_A) {
        return dnsPacket.buildAResponse(buf, parsed, ipv4);
      }
      return dnsPacket.buildEmptyResponse(buf, parsed);
    }

    const answer = await this.forward(buf);
    if (answer) return answer;
    return dnsPacket.buildServFail(buf, parsed);
  }

  async forward(buf) {
    const upstreams = dnsSettings.resolveUpstreams();
    for (const nameserver of upstreams) {
      try {
        const answer = await this.queryUpstream(nameserver, buf);
        if (answer && answer.length >= 12) return answer;
      } catch (err) {
        logger.warn(`DNS upstream ${nameserver} failed: ${err.message}`);
      }
    }
    return null;
  }

  queryUpstream(nameserver, buf) {
    return new Promise((resolve, reject) => {
      const text = String(nameserver || '');
      const match = text.match(/^(\d+\.\d+\.\d+\.\d+)(?::(\d+))?$/);
      const host = match ? match[1] : text;
      const port = match && match[2] ? Number(match[2]) : 53;
      const sock = dgram.createSocket('udp4');
      const timer = setTimeout(() => {
        try { sock.close(); } catch { /* ignore */ }
        reject(new Error('timeout'));
      }, FORWARD_TIMEOUT_MS);
      const finish = (err, msg) => {
        clearTimeout(timer);
        try { sock.close(); } catch { /* ignore */ }
        if (err) reject(err);
        else resolve(msg);
      };
      sock.once('message', (msg) => finish(null, msg));
      sock.once('error', (err) => finish(err));
      sock.send(buf, port, host, (err) => {
        if (err) finish(err);
      });
    });
  }
}

module.exports = new DnsProxy();
module.exports.DnsProxy = DnsProxy;
