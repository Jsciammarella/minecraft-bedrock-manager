const fs = require('fs');
const dns = require('dns');
const settingsStore = require('./settingsStore');
const connectHost = require('./connectHost');

const MAX_OVERRIDES = 20;
const MAX_UPSTREAMS = 3;
const REPO_URL = 'https://github.com/Pugmatt/BedrockConnect';

const KNOWN_SERVERS = [
  {
    name: 'The Hive',
    hostname: 'geo.hivebedrock.network',
    examplePublicIp: '104.238.130.180',
    notes: 'Redirect-compatible featured server. Some consoles may still skip this name because of DNSSEC.',
  },
  {
    name: 'The Hive',
    hostname: 'hivebedrock.network',
    examplePublicIp: '104.238.130.180',
    notes: 'Redirect-compatible featured server.',
  },
  {
    name: 'Mineville',
    hostname: 'play.inpvp.net',
    examplePublicIp: '104.238.130.180',
    notes: 'Redirect-compatible featured server.',
  },
  {
    name: 'Lifeboat',
    hostname: 'mco.lbsg.net',
    examplePublicIp: '104.238.130.180',
    notes: 'Redirect-compatible featured server.',
  },
  {
    name: 'Galaxite',
    hostname: 'play.galaxite.net',
    examplePublicIp: '104.238.130.180',
    notes: 'Redirect-compatible featured server.',
  },
  {
    name: 'Enchanted Dragons',
    hostname: 'play.enchanted.gg',
    examplePublicIp: '104.238.130.180',
    notes: 'Redirect-compatible featured server.',
  },
];

function isValidIPv4(ip) {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isUnicastIPv4(ip) {
  if (!isValidIPv4(ip)) return false;
  const [a, b] = String(ip).trim().split('.').map(Number);
  if (a === 0 || a === 255) return false;
  if (a >= 224) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

function normalizeHostname(value) {
  return String(value || '').trim().replace(/\.$/, '').toLowerCase();
}

function isValidHostname(value) {
  const name = normalizeHostname(value);
  if (!name || name.length > 253 || name === 'localhost') return false;
  if (isValidIPv4(name)) return false;
  const labels = name.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => (
    label.length >= 1
    && label.length <= 63
    && !label.startsWith('-')
    && !label.endsWith('-')
    && /^[a-z0-9-]+$/.test(label)
  ));
}

function parseJson(raw, fallback) {
  try {
    const value = JSON.parse(raw || '');
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function hostNameservers() {
  const found = [];
  const add = (value) => {
    const ip = String(value || '').trim().replace(/^\[|\]$/g, '').split('%')[0];
    const host = ip.includes(':') && !/^\d+\.\d+\.\d+\.\d+$/.test(ip)
      ? ip.replace(/:\d+$/, '')
      : ip.replace(/:53$/, '');
    if (!isValidIPv4(host) || found.includes(host)) return;
    found.push(host);
  };

  try {
    for (const server of dns.getServers() || []) add(server);
  } catch {
    // ignore
  }

  try {
    if (fs.existsSync('/etc/resolv.conf')) {
      for (const line of fs.readFileSync('/etc/resolv.conf', 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*nameserver\s+(\S+)/i);
        if (match) add(match[1]);
      }
    }
  } catch {
    // ignore
  }

  return found;
}

function listenIp() {
  return connectHost.detectLanIPv4() || connectHost.resolve() || '';
}

function readOverrides() {
  const rows = parseJson(settingsStore.get(settingsStore.KEYS.BEDROCK_DNS_OVERRIDES), []);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      hostname: normalizeHostname(row?.hostname),
      ipv4: String(row?.ipv4 || '').trim(),
    }))
    .filter((row) => isValidHostname(row.hostname) && isUnicastIPv4(row.ipv4))
    .slice(0, MAX_OVERRIDES);
}

function readUpstreams() {
  const rows = parseJson(settingsStore.get(settingsStore.KEYS.BEDROCK_DNS_UPSTREAMS), []);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((value) => String(value || '').trim())
    .filter((value) => isValidIPv4(value) && value !== '0.0.0.0')
    .slice(0, MAX_UPSTREAMS);
}

function getConfig() {
  return {
    enabled: settingsStore.isTruthy(settingsStore.get(settingsStore.KEYS.BEDROCK_DNS_ENABLED)),
    upstreams: readUpstreams(),
    overrides: readOverrides(),
  };
}

function resolveUpstreams(custom = readUpstreams()) {
  const listen = listenIp();
  const source = custom.length > 0 ? custom : hostNameservers();
  return source.filter((ip) => ip && ip !== listen);
}

function saveConfig({ enabled, upstreams, overrides } = {}) {
  const nextUpstreams = [];
  for (const value of Array.isArray(upstreams) ? upstreams : []) {
    const ip = String(value || '').trim();
    if (!ip) continue;
    if (!isValidIPv4(ip) || ip === '0.0.0.0' || ip === '255.255.255.255') {
      throw new Error(`Upstream DNS must be an IPv4 address: ${ip}`);
    }
    if (!nextUpstreams.includes(ip)) nextUpstreams.push(ip);
    if (nextUpstreams.length > MAX_UPSTREAMS) {
      throw new Error(`At most ${MAX_UPSTREAMS} upstream DNS servers can be set`);
    }
  }

  const nextOverrides = [];
  const seen = new Set();
  for (const row of Array.isArray(overrides) ? overrides : []) {
    const hostname = normalizeHostname(row?.hostname);
    const ipv4 = String(row?.ipv4 || '').trim();
    if (!hostname && !ipv4) continue;
    if (!isValidHostname(hostname)) {
      throw new Error(`Override hostname is invalid: ${row?.hostname || '(empty)'}`);
    }
    if (!isUnicastIPv4(ipv4)) {
      throw new Error(`Override IPv4 is invalid: ${ipv4 || '(empty)'}`);
    }
    if (seen.has(hostname)) {
      throw new Error(`Duplicate DNS override for ${hostname}`);
    }
    seen.add(hostname);
    nextOverrides.push({ hostname, ipv4 });
    if (nextOverrides.length > MAX_OVERRIDES) {
      throw new Error(`At most ${MAX_OVERRIDES} DNS overrides can be stored`);
    }
  }

  settingsStore.set(settingsStore.KEYS.BEDROCK_DNS_ENABLED, enabled ? '1' : '0');
  settingsStore.set(settingsStore.KEYS.BEDROCK_DNS_UPSTREAMS, JSON.stringify(nextUpstreams));
  settingsStore.set(settingsStore.KEYS.BEDROCK_DNS_OVERRIDES, JSON.stringify(nextOverrides));
  return getConfig();
}

function overrideMap() {
  const map = new Map();
  for (const row of readOverrides()) map.set(row.hostname, row.ipv4);
  return map;
}

function publicConfig() {
  const config = getConfig();
  const listen = listenIp();
  const host = hostNameservers();
  const resolvedUpstreams = resolveUpstreams(config.upstreams);
  return {
    repoUrl: REPO_URL,
    maxOverrides: MAX_OVERRIDES,
    maxUpstreams: MAX_UPSTREAMS,
    listenIp: listen,
    hostNameservers: host,
    resolvedUpstreams,
    secondaryDns: resolvedUpstreams[0] || host[0] || '8.8.8.8',
    knownServers: KNOWN_SERVERS,
    knownServersNote: 'These hostnames and example addresses come from the Bedrock Connect documentation. They are not live lookups. Public IPs change, some names use DNSSEC, and CubeCraft is intentionally omitted. Verify current records before relying on a redirect.',
    ...config,
  };
}

module.exports = {
  MAX_OVERRIDES,
  MAX_UPSTREAMS,
  REPO_URL,
  KNOWN_SERVERS,
  getConfig,
  saveConfig,
  publicConfig,
  hostNameservers,
  listenIp,
  resolveUpstreams,
  overrideMap,
  isValidIPv4,
  isUnicastIPv4,
  isValidHostname,
  normalizeHostname,
};
