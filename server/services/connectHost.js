const fs = require('fs');
const os = require('os');

const SKIP_IFACE = /^(lo\b|Loopback|docker|br-|veth|cni|flannel|virbr|tunl|vEthernet \(WSL|vEthernet \(Default Switch|vEthernet \(Docker)/i;

function isWsl() {
  if (process.env.MC_WSL === '1') return true;
  if (process.env.MC_WSL === '0') return false;
  try {
    return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function configuredHost() {
  return String(process.env.CONNECT_HOST || process.env.PUBLIC_HOST || '').trim();
}

function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '0.0.0.0';
}

function stripHostPort(host) {
  const value = String(host || '').trim();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end >= 0 ? value.slice(1, end) : value;
  }
  if (/^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(value)) {
    return value.replace(/:\d+$/, '');
  }
  if (/^[a-z0-9.-]+:\d+$/i.test(value)) {
    return value.replace(/:\d+$/, '');
  }
  return value;
}

function hostnameFromRequest(req) {
  const forwarded = req?.headers?.['x-forwarded-host'];
  const raw = String(forwarded || req?.headers?.host || req?.hostname || '')
    .split(',')[0]
    .trim();
  return stripHostPort(raw);
}

function isUsableIPv4(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  if (parts[0] === 127 || parts[0] === 0) return false;
  if (parts[0] === 169 && parts[1] === 254) return false;
  return true;
}

function scoreIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts[0] === 192 && parts[1] === 168) return 100;
  if (parts[0] === 10) return 90;
  // Docker's default bridge is 172.17.0.0/16; compose networks often start at 172.18.
  if (parts[0] === 172 && parts[1] === 17) return 1;
  // WSL NAT and Docker Desktop publish paths often land in 172.16/12. Prefer CONNECT_HOST.
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return isWsl() ? 1 : 40;
  return 50;
}

function detectLanIPv4() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets || {})) {
    if (SKIP_IFACE.test(name)) continue;
    for (const addr of addrs || []) {
      const family = String(addr.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (addr.internal || !isUsableIPv4(addr.address)) continue;
      candidates.push({ ip: addr.address, score: scoreIPv4(addr.address) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score <= 1) return '';
  return best.ip;
}

function formatAddress(host, port) {
  const hostname = String(host || '').trim() || '127.0.0.1';
  const display = hostname.includes(':') && !hostname.startsWith('[')
    ? `[${hostname}]`
    : hostname;
  return `${display}:${port}`;
}

function managerHostname() {
  try {
    return String(os.hostname() || '').trim();
  } catch {
    return '';
  }
}

function resolve(_req) {
  const configured = stripHostPort(configuredHost());
  if (configured && isUsableIPv4(configured)) return configured;

  const lan = detectLanIPv4();
  if (lan) return lan;

  const fromRequest = hostnameFromRequest(_req);
  if (fromRequest && isUsableIPv4(fromRequest)) return fromRequest;

  return '127.0.0.1';
}

function isPhantomProxied(server) {
  const lan = server?.lan || server?.stats?.lan;
  return Boolean(lan && lan.enabled && lan.active && !lan.native);
}

function attach(server, req) {
  const connectHost = resolve(req);
  return {
    ...server,
    connectHost,
    lanIp: connectHost,
    managerHostname: managerHostname(),
    connectAddress: formatAddress(connectHost, server.port),
  };
}

module.exports = {
  attach,
  configuredHost,
  detectLanIPv4,
  formatAddress,
  hostnameFromRequest,
  isLoopbackHost,
  isPhantomProxied,
  isUsableIPv4,
  managerHostname,
  resolve,
  stripHostPort,
  isWsl,
  scoreIPv4,
};
