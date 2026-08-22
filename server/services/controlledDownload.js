const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { URL } = require('url');
const logger = require('./logger');
const pluginAudit = require('./pluginAudit');
const controlledFs = require('./controlledFs');

const USER_AGENT = 'minecraft-bedrock-manager';
const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_REDIRECTS = 3;

function hostnameAllowed(hostname, allowHosts) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  return (allowHosts || []).some((allowed) => {
    const needle = String(allowed || '').toLowerCase().replace(/\.$/, '');
    if (!needle) return false;
    return host === needle || host.endsWith(`.${needle}`);
  });
}

function assertHttpsUrl(rawUrl, allowHosts, { allowHttp = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    throw Object.assign(new Error('Download URL is invalid'), { status: 400 });
  }
  if (parsed.protocol === 'http:') {
    if (!allowHttp) {
      throw Object.assign(new Error('Downloads must use HTTPS'), { status: 400 });
    }
  } else if (parsed.protocol !== 'https:') {
    throw Object.assign(new Error('Downloads must use HTTPS'), { status: 400 });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('Download URLs may not include credentials'), { status: 400 });
  }
  if (!hostnameAllowed(parsed.hostname, allowHosts)) {
    throw Object.assign(new Error(`Host ${parsed.hostname} is not on the approved download list`), { status: 400 });
  }
  return parsed;
}

async function getJson(url, {
  allowHosts,
  timeoutMs = 20000,
  allowHttp = false,
  fetcher,
} = {}) {
  const parsed = assertHttpsUrl(url, allowHosts, { allowHttp });
  if (typeof fetcher === 'function') {
    return fetcher({ method: 'GET', url: parsed.toString(), json: true });
  }
  const { data } = await axios.get(parsed.toString(), {
    timeout: timeoutMs,
    maxRedirects: DEFAULT_REDIRECTS,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  return data;
}

async function getText(url, {
  allowHosts,
  timeoutMs = 20000,
  allowHttp = false,
  fetcher,
} = {}) {
  const parsed = assertHttpsUrl(url, allowHosts, { allowHttp });
  if (typeof fetcher === 'function') {
    return fetcher({ method: 'GET', url: parsed.toString(), json: false, text: true });
  }
  const { data } = await axios.get(parsed.toString(), {
    timeout: timeoutMs,
    maxRedirects: DEFAULT_REDIRECTS,
    responseType: 'text',
    headers: { 'User-Agent': USER_AGENT },
  });
  return String(data);
}

async function downloadToFile({
  url,
  destination,
  sha256,
  sha1,
  maximumBytes = DEFAULT_MAX_BYTES,
  allowHosts,
  allowHttp = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetcher,
  project = '',
  version = '',
} = {}) {
  const parsed = assertHttpsUrl(url, allowHosts, { allowHttp });
  const dest = path.resolve(destination);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.part`;
  try {
    let buffer;
    if (typeof fetcher === 'function') {
      buffer = await fetcher({ method: 'GET', url: parsed.toString(), json: false });
      if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    } else {
      const response = await axios.get(parsed.toString(), {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        maxRedirects: DEFAULT_REDIRECTS,
        maxContentLength: maximumBytes,
        headers: { 'User-Agent': USER_AGENT },
      });
      buffer = Buffer.from(response.data);
    }
    if (buffer.length > maximumBytes) {
      throw new Error(`Download exceeded the ${maximumBytes} byte limit`);
    }
    if (sha256) {
      const digest = crypto.createHash('sha256').update(buffer).digest('hex');
      if (digest.toLowerCase() !== String(sha256).toLowerCase()) {
        throw new Error('SHA-256 verification failed');
      }
    }
    if (sha1) {
      const digest = crypto.createHash('sha1').update(buffer).digest('hex');
      if (digest.toLowerCase() !== String(sha1).toLowerCase()) {
        throw new Error('SHA-1 verification failed');
      }
    }
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, dest);
    const sha256Actual = crypto.createHash('sha256').update(buffer).digest('hex');
    const publicUrl = `${parsed.origin}${parsed.pathname}`;
    pluginAudit.record('download.complete', {
      targetType: 'file',
      targetId: path.basename(dest),
      detail: { url: publicUrl, bytes: buffer.length, sha256: sha256Actual, project, version },
    });
    logger.info(`Downloaded ${publicUrl} (${buffer.length} bytes)`);
    return { path: dest, bytes: buffer.length, sha256: sha256Actual };
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    pluginAudit.record('download.failed', {
      targetType: 'file',
      detail: { url: `${parsed.origin}${parsed.pathname}`, error: err.message, project },
    });
    throw err;
  }
}

async function downloadIntoRoot(root, item, options = {}) {
  const rel = controlledFs.assertRelative(item.destination);
  const dest = controlledFs.resolveInRoot(root, rel);
  return downloadToFile({
    ...options,
    url: item.url,
    destination: dest,
    sha256: item.sha256,
    sha1: item.sha1,
    maximumBytes: item.maximumBytes || options.maximumBytes || DEFAULT_MAX_BYTES,
    project: item.project || options.project,
    version: item.version || options.version,
  });
}

module.exports = {
  USER_AGENT,
  assertHttpsUrl,
  downloadIntoRoot,
  downloadToFile,
  getJson,
  getText,
  hostnameAllowed,
};
