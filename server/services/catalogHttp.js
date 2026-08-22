const axios = require('axios');
const settingsStore = require('./settingsStore');
const pluginAudit = require('./pluginAudit');
const controlledDownload = require('./controlledDownload');

const CURSEFORGE_API_ORIGIN = 'https://api.curseforge.com';
const CURSEFORGE_HOSTS = ['api.curseforge.com'];

function sanitizeMessage(value) {
  return String(value || 'Catalog request failed')
    .replace(/x-api-key[:\s]*\S+/ig, '[redacted]')
    .replace(/api[_-]?key[:\s]*\S+/ig, '[redacted]')
    .replace(/authorization[:\s]*\S+/ig, '[redacted]');
}

function publicError(err, fallback) {
  const status = err.response?.status || err.status || 502;
  if (status === 401 || status === 403) {
    return Object.assign(
      new Error('CurseForge rejected the catalog request. Check the API key in Catalog Settings.'),
      { status }
    );
  }
  const message = sanitizeMessage(err.response?.data?.error || err.message || fallback);
  return Object.assign(new Error(message), { status });
}

function isConfigured(profile) {
  if (profile !== 'curseforge') return false;
  return Boolean(settingsStore.getCurseForgeApiKey());
}

function assertCurseforgeUrl(rawUrl) {
  const parsed = controlledDownload.assertHttpsUrl(rawUrl, CURSEFORGE_HOSTS);
  if (parsed.origin !== CURSEFORGE_API_ORIGIN) {
    throw Object.assign(new Error('Catalog requests must use the official CurseForge API host'), { status: 400 });
  }
  return parsed;
}

async function request({ credentialProfile, url, params, method = 'GET' } = {}) {
  if (credentialProfile !== 'curseforge') {
    throw Object.assign(new Error('Unknown catalog credential profile'), { status: 400 });
  }
  if (!isConfigured('curseforge')) {
    pluginAudit.record('catalog.search.unconfigured', {
      targetType: 'catalog-source',
      targetId: 'curseforge',
    });
    throw Object.assign(
      new Error('CurseForge Java requires the existing CurseForge API key. Open Catalog Settings to add it.'),
      { status: 400, code: 'CURSEFORGE_API_KEY_REQUIRED' }
    );
  }
  const parsed = assertCurseforgeUrl(url);
  const verb = String(method || 'GET').toUpperCase();
  if (verb !== 'GET') {
    throw Object.assign(new Error('Catalog HTTP is limited to GET requests'), { status: 400 });
  }
  const headers = {
    Accept: 'application/json',
    'User-Agent': controlledDownload.USER_AGENT,
    'X-API-Key': settingsStore.getCurseForgeApiKey(),
  };
  try {
    const response = await axios.get(parsed.toString(), {
      params: params && typeof params === 'object' ? params : undefined,
      headers,
      timeout: 20000,
      maxRedirects: 3,
    });
    return { data: response.data, status: response.status };
  } catch (err) {
    throw publicError(err, 'CurseForge catalog request failed');
  }
}

function forPlugin() {
  return {
    isConfigured: (profile = 'curseforge') => isConfigured(profile),
    request: (opts) => request(opts),
  };
}

module.exports = {
  CURSEFORGE_HOSTS,
  forPlugin,
  isConfigured,
  request,
  sanitizeMessage,
};
