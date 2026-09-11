const catalogModMeta = require('./catalogModMeta');
const minecraftVersions = require('./minecraftVersions');
const modCompatibility = require('./modCompatibility');

const SERVER_ENVIRONMENTS = new Set(['server', 'both', 'client_and_server', 'client-and-server']);

function normalizeLoader(value) {
  return catalogModMeta.normalizeLoader(value, 'java') || 'unknown';
}

function uniqueConfigs(targets = []) {
  const seen = new Map();
  for (const target of targets || []) {
    const minecraftVersion = minecraftVersions.canonicalMinecraftVersion(target.minecraftVersion || '');
    const loader = normalizeLoader(target.loader);
    if (!minecraftVersion || !loader || loader === 'unknown' || loader === 'vanilla' || loader === 'any') continue;
    const key = `${minecraftVersion}|${loader}`;
    if (!seen.has(key)) {
      seen.set(key, {
        minecraftVersion,
        loader,
        serverIds: [],
        serverNames: [],
      });
    }
    const entry = seen.get(key);
    if (target.serverId != null && !entry.serverIds.includes(Number(target.serverId))) {
      entry.serverIds.push(Number(target.serverId));
    }
    const name = String(target.serverName || '').trim();
    if (name && !entry.serverNames.includes(name)) entry.serverNames.push(name);
  }
  return [...seen.values()].sort((a, b) => {
    const version = minecraftVersions.compareMinecraftVersions(a.minecraftVersion, b.minecraftVersion);
    if (version) return version;
    return String(a.loader).localeCompare(String(b.loader));
  });
}

function cacheKey(targets = []) {
  return uniqueConfigs(targets)
    .map((item) => `${item.minecraftVersion}:${item.loader}`)
    .join(',');
}

function filesFromProject(project = {}) {
  const listed = []
    .concat(project.files || [])
    .concat(project.compatibilityFiles || [])
    .concat(project.latestFiles || [])
    .filter(Boolean);
  if (listed.length) {
    return listed.map((file) => ({
      loader: normalizeLoader(file.loader || file.modLoader),
      minecraftVersions: minecraftVersions.parseVersionList(
        file.minecraftVersions || file.gameVersions || file.gameVersion
      ),
      environment: String(file.environment || '').toLowerCase() || 'unknown',
    }));
  }
  return [{
    loader: normalizeLoader(project.loader),
    minecraftVersions: minecraftVersions.parseVersionList(project.minecraftVersions),
    environment: String(project.environment || '').toLowerCase() || 'unknown',
  }];
}

function isServerEnvironment(environment) {
  const value = String(environment || '').toLowerCase();
  if (!value || value === 'unknown' || value === 'client' || value === 'client_only' || value === 'client-only') {
    return false;
  }
  if (SERVER_ENVIRONMENTS.has(value)) return true;
  if (value.includes('server') && !value.includes('client_only')) return true;
  return false;
}

function fileMatchesTarget(file, target) {
  if (!file || !target) return false;
  if (!isServerEnvironment(file.environment)) return false;
  const loader = normalizeLoader(file.loader);
  if (!loader || loader === 'unknown') return false;
  if (!modCompatibility.loadersCompatible(loader, target.loader, { allowUnknown: false })) return false;
  const versions = file.minecraftVersions || [];
  if (!versions.length) return false;
  return minecraftVersions.supportsMinecraftVersion(versions, target.minecraftVersion);
}

function projectMatchesTarget(project, target) {
  if (!project || String(project.edition || 'java').toLowerCase() !== 'java') return false;
  const files = filesFromProject(project);
  if (!files.length) return false;
  const known = files.filter((file) => (
    isServerEnvironment(file.environment)
    && normalizeLoader(file.loader) !== 'unknown'
    && (file.minecraftVersions || []).length
  ));
  if (!known.length) return false;
  return known.some((file) => fileMatchesTarget(file, target));
}

function projectMatchesAnyTarget(project, targets = []) {
  return (targets || []).some((target) => projectMatchesTarget(project, target));
}

function matchingServerNames(project, targets = []) {
  const names = [];
  for (const target of targets || []) {
    if (!projectMatchesTarget(project, target)) continue;
    const name = String(target.serverName || '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function dedupeProjects(results = []) {
  const seen = new Set();
  const out = [];
  for (const item of results) {
    const provider = item.providerId || item.source || '';
    const id = item.id || item.curseforgeId || item.modrinthId || item.slug;
    const key = `${provider}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function stableSort(results = [], sortBy = 'relevancy') {
  const list = [...results];
  const key = String(sortBy || 'relevancy').toLowerCase();
  list.sort((a, b) => {
    if (key === 'name' || key === 'name_asc') {
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    }
    if (key === 'updated' || key === 'date' || key === 'dateUpdated') {
      return String(b.dateUpdated || '').localeCompare(String(a.dateUpdated || ''));
    }
    const downloads = (Number(b.downloads) || 0) - (Number(a.downloads) || 0);
    if (downloads) return downloads;
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  });
  return list;
}

function paginate(results, { page = 1, pageSize = 40 } = {}) {
  const size = Math.max(1, Number(pageSize) || 40);
  const current = Math.max(1, Number(page) || 1);
  const start = (current - 1) * size;
  return {
    results: results.slice(start, start + size),
    total: results.length,
    page: current,
  };
}

function mergeTargetSearches(pages, options = {}) {
  const merged = dedupeProjects(pages.flatMap((page) => page.results || []));
  const sorted = stableSort(merged, options.sortBy);
  return paginate(sorted, options);
}

function applicableConfigs(targets = [], options = {}) {
  let configs = uniqueConfigs(targets);
  const requested = minecraftVersions.parseRequestedGameVersions(options.gameVersions);
  if (requested.length) {
    configs = configs.filter((config) => (
      requested.some((item) => {
        const version = item.version || item;
        if (item.edition && item.edition !== 'java') return false;
        return version === config.minecraftVersion
          || minecraftVersions.supportsMinecraftVersion([config.minecraftVersion], version)
          || minecraftVersions.supportsMinecraftVersion([version], config.minecraftVersion);
      })
    ));
  }
  const loader = normalizeLoader(options.loader);
  if (options.loader && loader && loader !== 'unknown' && loader !== 'any') {
    configs = configs.filter((config) => config.loader === loader);
  }
  return configs;
}

const MAX_OVERFETCH = 200;

async function searchPairedConfigs(targets, searchOne, options = {}) {
  const configs = applicableConfigs(targets, options);
  if (!configs.length) {
    return { results: [], total: 0, page: Math.max(1, Number(options.page) || 1) };
  }
  const pageSize = Math.max(1, Number(options.pageSize) || 40);
  const page = Math.max(1, Number(options.page) || 1);
  const overfetch = Math.min(MAX_OVERFETCH, Math.max(pageSize * page, pageSize));
  const pages = [];
  let truncated = false;
  for (const config of configs) {
    const inner = {
      ...options,
      minecraftVersions: [config.minecraftVersion],
      loader: config.loader,
      page: 1,
      offset: 0,
      pageSize: overfetch,
    };
    delete inner.compatibilityTargets;
    const pageResult = await searchOne(inner);
    const filtered = (pageResult.results || []).filter((item) => projectMatchesTarget(item, {
      minecraftVersion: config.minecraftVersion,
      loader: config.loader,
    }));
    if ((Number(pageResult.total) || 0) > overfetch) truncated = true;
    pages.push({ results: filtered, total: filtered.length });
  }
  const merged = mergeTargetSearches(pages, { page, pageSize, sortBy: options.sortBy });
  if (truncated) {
    merged.warning = merged.warning
      || 'Compatibility results may be incomplete for this catalog source.';
  }
  return merged;
}

module.exports = {
  applicableConfigs,
  cacheKey,
  dedupeProjects,
  fileMatchesTarget,
  filesFromProject,
  matchingServerNames,
  mergeTargetSearches,
  paginate,
  projectMatchesAnyTarget,
  projectMatchesTarget,
  searchPairedConfigs,
  uniqueConfigs,
};
