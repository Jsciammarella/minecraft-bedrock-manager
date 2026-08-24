const axios = require('axios');
const settingsStore = require('./settingsStore');
const pluginAudit = require('./pluginAudit');
const controlledDownload = require('./controlledDownload');
const productIdentity = require('./productIdentity');

const CURSEFORGE_API_ORIGIN = 'https://api.curseforge.com';
const CURSEFORGE_HOSTS = ['api.curseforge.com'];
const MODRINTH_API_ORIGIN = 'https://api.modrinth.com';
const MODRINTH_HOSTS = ['api.modrinth.com'];
const MODRINTH_MAX_WAIT_MS = 30000;
const REQUEST_TIMEOUT_MS = 20000;

const inflight = new Map();
const rateLimitedUntil = new Map();

function sanitizeMessage(value) {
  return String(value || 'Catalog request failed')
    .replace(/x-api-key[:\s]*\S+/ig, '[redacted]')
    .replace(/api[_-]?key[:\s]*\S+/ig, '[redacted]')
    .replace(/authorization[:\s]*\S+/ig, '[redacted]');
}

function publicError(err, fallback, { curseforgeAuth = false } = {}) {
  const status = err.response?.status || err.status || 502;
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || /timeout/i.test(String(err.message || ''))) {
    return Object.assign(new Error('Search timeout'), { status: 504, code: 'TIMEOUT' });
  }
  if (status === 429 || err.code === 'RATE_LIMITED') {
    return Object.assign(new Error(
      curseforgeAuth
        ? 'CurseForge rate limit reached. Try again in a moment.'
        : 'Modrinth rate limit reached. Try again in a moment.'
    ), {
      status: 429,
      code: 'RATE_LIMITED',
    });
  }
  if (curseforgeAuth && (status === 401 || status === 403)) {
    return Object.assign(
      new Error('CurseForge rejected the catalog request. Check the API key in the CurseForge Catalog plugin settings.'),
      { status }
    );
  }
  const message = sanitizeMessage(err.response?.data?.error || err.response?.data?.description || err.message || fallback);
  return Object.assign(new Error(message), { status: status === 404 ? 404 : status, code: err.code });
}

function isConfigured(profile) {
  if (profile === 'modrinth') return true;
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

function assertModrinthUrl(rawUrl) {
  const parsed = controlledDownload.assertHttpsUrl(rawUrl, MODRINTH_HOSTS);
  if (parsed.origin !== MODRINTH_API_ORIGIN) {
    throw Object.assign(new Error('Catalog requests must use the official Modrinth API host'), { status: 400 });
  }
  return parsed;
}

function identifyingHeaders() {
  return {
    Accept: 'application/json',
    'User-Agent': productIdentity.userAgent(),
  };
}

function parseResetMs(headers = {}) {
  const retryAfter = headers['retry-after'];
  if (retryAfter && /^\d+(\.\d+)?$/.test(String(retryAfter))) {
    return Math.min(MODRINTH_MAX_WAIT_MS, Number(retryAfter) * 1000);
  }
  const reset = headers['x-ratelimit-reset'];
  if (reset && /^\d+(\.\d+)?$/.test(String(reset))) {
    const seconds = Number(reset);
    const asUnix = seconds > 1e9;
    const wait = asUnix ? (seconds * 1000) - Date.now() : seconds * 1000;
    return Math.max(0, Math.min(MODRINTH_MAX_WAIT_MS, wait));
  }
  return 5000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKeyFrom(url, params) {
  return `${url}\n${JSON.stringify(params || {})}`;
}

async function axiosGet(parsed, { params, extraHeaders, allowHosts }) {
  return axios.get(parsed.toString(), {
    params: params && typeof params === 'object' ? params : undefined,
    headers: extraHeaders,
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 3,
    beforeRedirect: (config) => {
      const nextUrl = config?.url || config?.href;
      if (!nextUrl) return;
      const next = new URL(String(nextUrl), parsed);
      if (!controlledDownload.hostnameAllowed(next.hostname, allowHosts)) {
        throw Object.assign(new Error('Redirect rejected'), { status: 400 });
      }
    },
    validateStatus: (status) => status < 500,
  });
}

async function requestCurseforge({ url, params, method = 'GET' } = {}) {
  if (!isConfigured('curseforge')) {
    pluginAudit.record('catalog.search.unconfigured', {
      targetType: 'catalog-source',
      targetId: 'curseforge',
    });
    throw Object.assign(
      new Error('CurseForge catalog access requires an API key. Open the CurseForge Catalog plugin settings to add it.'),
      { status: 400, code: 'CURSEFORGE_API_KEY_REQUIRED' }
    );
  }
  const parsed = assertCurseforgeUrl(url);
  const verb = String(method || 'GET').toUpperCase();
  if (verb !== 'GET') {
    throw Object.assign(new Error('Catalog HTTP is limited to GET requests'), { status: 400 });
  }
  const headers = {
    ...identifyingHeaders(),
    'X-API-Key': settingsStore.getCurseForgeApiKey(),
  };
  try {
    const response = await axiosGet(parsed, {
      params,
      extraHeaders: headers,
      allowHosts: CURSEFORGE_HOSTS,
    });
    if (response.status >= 400) {
      throw Object.assign(new Error('CurseForge catalog request failed'), { status: response.status, response });
    }
    return { data: response.data, status: response.status, headers: response.headers };
  } catch (err) {
    throw publicError(err, 'CurseForge catalog request failed', { curseforgeAuth: true });
  }
}

async function requestModrinthOnce(parsed, params) {
  const until = rateLimitedUntil.get('modrinth') || 0;
  if (Date.now() < until) {
    throw Object.assign(new Error('Modrinth rate limit reached. Try again in a moment.'), {
      status: 429,
      code: 'RATE_LIMITED',
    });
  }
  const response = await axiosGet(parsed, {
    params,
    extraHeaders: identifyingHeaders(),
    allowHosts: MODRINTH_HOSTS,
  });
  if (response.status === 429) {
    const waitMs = parseResetMs(response.headers || {});
    rateLimitedUntil.set('modrinth', Date.now() + waitMs);
    if (waitMs > 0 && waitMs <= MODRINTH_MAX_WAIT_MS) {
      await sleep(waitMs);
      const retry = await axiosGet(parsed, {
        params,
        extraHeaders: identifyingHeaders(),
        allowHosts: MODRINTH_HOSTS,
      });
      if (retry.status === 429) {
        throw Object.assign(new Error('Modrinth rate limit reached. Try again in a moment.'), {
          status: 429,
          code: 'RATE_LIMITED',
          response: retry,
        });
      }
      if (retry.status >= 400) {
        throw Object.assign(new Error(retry.data?.description || 'Modrinth catalog request failed'), {
          status: retry.status,
          response: retry,
        });
      }
      return { data: retry.data, status: retry.status, headers: retry.headers };
    }
    throw Object.assign(new Error('Modrinth rate limit reached. Try again in a moment.'), {
      status: 429,
      code: 'RATE_LIMITED',
      response,
    });
  }
  if (response.status === 404) {
    throw Object.assign(new Error('That Modrinth project or version is not available.'), {
      status: 404,
      code: 'NOT_FOUND',
      response,
    });
  }
  if (response.status >= 400) {
    throw Object.assign(new Error(response.data?.description || 'Modrinth catalog request failed'), {
      status: response.status,
      response,
    });
  }
  return { data: response.data, status: response.status, headers: response.headers };
}

async function requestModrinth({ url, params, method = 'GET' } = {}) {
  const parsed = assertModrinthUrl(url);
  const verb = String(method || 'GET').toUpperCase();
  if (verb !== 'GET') {
    throw Object.assign(new Error('Catalog HTTP is limited to GET requests'), { status: 400 });
  }
  const key = cacheKeyFrom(parsed.toString(), params);
  if (inflight.has(key)) return inflight.get(key);
  const pending = requestModrinthOnce(parsed, params).catch((err) => {
    throw publicError(err, 'Modrinth catalog request failed');
  });
  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(key);
  }
}

async function request({ credentialProfile, url, params, method = 'GET' } = {}) {
  if (credentialProfile === 'modrinth') {
    return requestModrinth({ url, params, method });
  }
  if (credentialProfile !== 'curseforge') {
    throw Object.assign(new Error('Unknown catalog credential profile'), { status: 400 });
  }
  return requestCurseforge({ url, params, method });
}

function forPlugin() {
  return {
    isConfigured: (profile = 'curseforge') => isConfigured(profile),
    request: (opts) => request(opts),
  };
}

function resetModrinthLimiterForTests() {
  rateLimitedUntil.delete('modrinth');
  inflight.clear();
}

module.exports = {
  CURSEFORGE_HOSTS,
  MODRINTH_HOSTS,
  forPlugin,
  isConfigured,
  request,
  resetModrinthLimiterForTests,
  sanitizeMessage,
};
