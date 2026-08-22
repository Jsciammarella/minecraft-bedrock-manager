const ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

const CORE_API = [
  /^\/api\/health$/,
  /^\/api\/v1(?:\/|$)/,
  /^\/api\/servers(?:\/|$)/,
  /^\/api\/mods(?:\/|$)/,
  /^\/api\/players(?:\/|$)/,
  /^\/api\/ports(?:\/|$)/,
  /^\/api\/bedrock-connect(?:\/|$)/,
];

export function isAllowedPluginApiPath(pluginId, requestPath) {
  const raw = String(requestPath || '').split('?')[0];
  if (!raw.startsWith('/api/')) return false;
  if (raw.includes('\\') || raw.includes('\0') || raw.includes('..')) return false;
  let pathname;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    return false;
  }
  if (pathname.includes('..')) return false;
  const ownPrefix = `/api/plugins/${pluginId}`;
  if (pathname === ownPrefix || pathname.startsWith(`${ownPrefix}/`)) {
    if (pathname === `${ownPrefix}/ui` || pathname.startsWith(`${ownPrefix}/ui/`)) return false;
    if (pathname === `${ownPrefix}/meta` || pathname === `${ownPrefix}/sdk.js`) return false;
    return ID_RE.test(pluginId);
  }
  if (pathname === '/api/plugins' || pathname === '/api/plugins/') return true;
  return CORE_API.some((re) => re.test(pathname));
}

export function isAllowedPluginNavigatePath(pluginId, requestPath) {
  const raw = String(requestPath || '').split('?')[0];
  if (!raw.startsWith(`/plugins/${pluginId}`)) return false;
  if (raw.includes('..') || raw.includes('\\') || raw.includes('\0')) return false;
  return raw === `/plugins/${pluginId}` || raw.startsWith(`/plugins/${pluginId}/`);
}

export async function proxyPluginApi(pluginId, method, requestPath, body) {
  if (!isAllowedPluginApiPath(pluginId, requestPath)) {
    const error = new Error('Plugin API path is not allowed');
    error.status = 403;
    throw error;
  }
  const verb = String(method || 'GET').toUpperCase();
  const allowedMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
  if (!allowedMethods.includes(verb)) {
    const error = new Error('Plugin API method is not allowed');
    error.status = 405;
    throw error;
  }
  const headers = { Accept: 'application/json' };
  const init = { method: verb, headers };
  if (!['GET', 'HEAD'].includes(verb) && body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(requestPath, init);
  const text = await res.text();
  let data = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  } else {
    data = null;
  }
  if (!res.ok) {
    const error = new Error((data && data.error) || res.statusText || 'Request failed');
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}
