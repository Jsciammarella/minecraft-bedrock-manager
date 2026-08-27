const serverManager = require('./serverManager');
const javaHostingPolicy = require('./javaHostingPolicy');
const javaLoaderRegistry = require('./javaLoaderRegistry');
const minecraftVersions = require('./minecraftVersions');

const MAX_SELECTION = 100;

function notFoundError() {
  const err = new Error('Server not found');
  err.status = 404;
  err.code = 'NOT_FOUND';
  return err;
}

function canView(principal, server) {
  const security = require('../security');
  if (!principal || !server) return false;
  try {
    if (security.isAdministrator(principal)) return true;
    return security.authorize(principal, 'servers.view', server)
      || security.authorize(principal, 'servers.view_details', server);
  } catch {
    return false;
  }
}

function loaderInfo(server) {
  const loader = String(server?.loader_provider_id || server?.loaderProviderId || 'vanilla');
  const entry = javaLoaderRegistry.get(loader);
  const meta = entry ? javaLoaderRegistry.publicMetadata(entry) : null;
  const loaderAvailable = Boolean(entry);
  const supportsMods = Boolean(meta?.supportsMods);
  let disabledReason = null;
  if (!loaderAvailable) disabledReason = 'Loader unavailable';
  else if (!supportsMods || loader === 'vanilla') disabledReason = 'Loader does not support mods';
  return {
    loader,
    loaderName: meta?.name || loader,
    loaderAvailable,
    supportsMods,
    selectable: loaderAvailable && supportsMods && loader !== 'vanilla',
    disabledReason,
  };
}

function toSummary(server) {
  const info = loaderInfo(server);
  return {
    id: Number(server.id),
    name: String(server.name || ''),
    kind: 'java',
    minecraftVersion: minecraftVersions.serverMinecraftVersion(server),
    loader: info.loader,
    loaderName: info.loaderName,
    loaderAvailable: info.loaderAvailable,
    supportsMods: info.supportsMods,
    selectable: info.selectable,
    disabledReason: info.disabledReason,
  };
}

function eligibleJavaServers(principal) {
  if (!javaHostingPolicy.isJavaHostingAvailable()) return [];
  return javaHostingPolicy.filterVisibleServers(serverManager.getAllServers())
    .filter((server) => {
      if (String(server.kind || '') !== 'java') return false;
      if (server.remote_host) return false;
      if (!canView(principal, server)) return false;
      const version = minecraftVersions.serverMinecraftVersion(server);
      return Boolean(version) && version !== 'N/A';
    })
    .map(toSummary);
}

function listVisible(principal) {
  return eligibleJavaServers(principal).map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    minecraftVersion: item.minecraftVersion,
    loader: item.loader,
    loaderName: item.loaderName,
    loaderAvailable: item.loaderAvailable,
    supportsMods: item.supportsMods,
  }));
}

function listOptions(principal) {
  return eligibleJavaServers(principal).map((item) => ({
    id: String(item.id),
    label: `${item.name} — ${item.minecraftVersion} — ${item.loaderName}`,
    disabled: !item.selectable,
    disabledReason: item.disabledReason,
    server: item,
  }));
}

function parseIds(values) {
  const raw = Array.isArray(values) ? values : [values];
  const ids = [];
  const seen = new Set();
  for (const value of raw) {
    const id = Number.parseInt(String(value), 10);
    if (!Number.isInteger(id) || id <= 0) throw notFoundError();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > MAX_SELECTION) {
    const err = new Error(`Select at most ${MAX_SELECTION} Java servers.`);
    err.status = 400;
    err.code = 'CATALOG_FILTER_LIMIT';
    throw err;
  }
  return ids;
}

function resolveIds(values, principal) {
  const ids = parseIds(values);
  const visible = new Map(eligibleJavaServers(principal).map((item) => [item.id, item]));
  const targets = [];
  for (const id of ids) {
    const summary = visible.get(id);
    if (!summary || !summary.selectable) throw notFoundError();
    targets.push({
      serverId: summary.id,
      serverName: summary.name,
      minecraftVersion: summary.minecraftVersion,
      loader: summary.loader,
    });
  }
  return targets;
}

function isJavaHostingAvailable() {
  return javaHostingPolicy.isJavaHostingAvailable();
}

function forPlugin() {
  return {
    isJavaHostingAvailable,
    listVisible,
    listOptions,
    resolveIds,
  };
}

module.exports = {
  MAX_SELECTION,
  forPlugin,
  isJavaHostingAvailable,
  listOptions,
  listVisible,
  resolveIds,
};
