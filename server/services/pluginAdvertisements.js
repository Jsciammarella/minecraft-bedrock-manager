const db = require('../db/connection');
const gatewayRegistry = require('./gatewayRegistry');
const connectHost = require('./connectHost');

function strip(value, max = 80) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, max);
}

function isUnadvertisableHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value) return true;
  if (connectHost.isLoopbackHost(value)) return true;
  if (value === '0.0.0.0' || value === '::' || value === '[::]') return true;
  if (value.endsWith('.internal') || value.endsWith('.local') && value.includes('docker')) return true;
  if (value === 'host.docker.internal' || value === 'gateway.docker.internal') return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(value) && value.startsWith('172.17.')) return true;
  return false;
}

function sanitizeEndpoint(raw) {
  const name = strip(raw?.name, 80);
  const address = strip(raw?.address, 253);
  const port = Number(raw?.port);
  if (!name || !address || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (isUnadvertisableHost(address)) return null;
  if (raw?.internal === true) return null;
  if (Number(raw?.viaproxyBindPort) && Number(raw.viaproxyBindPort) === port) return null;
  return { name, address, port };
}

function list() {
  const pluginHost = require('./pluginHost');
  const enabled = new Set(
    (pluginHost.getPlugins() || []).filter((plugin) => plugin.enabled).map((plugin) => plugin.id)
  );
  const rows = db.prepare('SELECT * FROM gateways').all();
  const endpoints = [];
  const seen = new Set();
  for (const row of rows) {
    if (Number(row.advertise_in_bedrock_connect) === 0) continue;
    const entry = gatewayRegistry.get(row.provider_id);
    if (!entry?.pluginId || !enabled.has(entry.pluginId)) continue;
    let raw = {
      name: `${strip(row.name, 60)} — Geyser`,
      address: connectHost.resolve(),
      port: Number(row.bedrock_udp_port),
      internal: false,
    };
    if (typeof entry.provider.getAdvertisedEndpoint === 'function') {
      try {
        raw = { ...raw, ...(entry.provider.getAdvertisedEndpoint(row) || {}) };
      } catch { /* ignore */ }
    }
    raw.port = Number(row.bedrock_udp_port);
    raw.address = connectHost.resolve();
    delete raw.viaproxyBindPort;
    delete raw.internalPort;
    delete raw.targetTcpPort;
    const endpoint = sanitizeEndpoint(raw);
    if (!endpoint) continue;
    const key = `${endpoint.address.toLowerCase()}:${endpoint.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push(endpoint);
  }
  return endpoints;
}

module.exports = {
  isUnadvertisableHost,
  list,
  sanitizeEndpoint,
};
