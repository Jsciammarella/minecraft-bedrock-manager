const path = require('path');

const API = 'https://api.modrinth.com/v2';
const PROVIDER_ID = 'modrinth-java';
const CATEGORY_PREFIX = 'modrinth-java:';
const CDN_HOSTS = ['cdn.modrinth.com'];
const SITE_HOSTS = ['modrinth.com', 'www.modrinth.com'];
const SEARCH_TTL_MS = 3 * 60 * 1000;
const PROJECT_TTL_MS = 20 * 60 * 1000;
const VERSION_TTL_MS = 15 * 60 * 1000;
const TAG_TTL_MS = 12 * 60 * 60 * 1000;
const NEGATIVE_HASH_TTL_MS = 2 * 60 * 1000;
const MAX_PAGE_SIZE = 40;
const MAX_DEP_DEPTH = 8;
const MAX_DEP_COUNT = 25;
const MAX_FILE_BYTES = 250 * 1024 * 1024;
const HOST_LOADERS = new Set(['fabric', 'neoforge']);
const SEARCH_LOADERS = {
  fabric: ['fabric', 'quilt'],
  neoforge: ['neoforge', 'forge'],
};
const BLOCKED_ENVIRONMENTS = new Set(['client_only', 'singleplayer_only']);
const SERVER_ONLY_ENVIRONMENTS = new Set([
  'server_only',
  'dedicated_server_only',
  'server_only_client_optional',
]);
const BOTH_ENVIRONMENTS = new Set([
  'client_and_server',
  'client_or_server',
  'client_or_server_prefers_both',
  'client_only_server_optional',
]);
const SERVER_COMPATIBLE_ENVIRONMENTS = [
  ...SERVER_ONLY_ENVIRONMENTS,
  ...BOTH_ENVIRONMENTS,
  'unknown',
];
const ENVIRONMENT_LABELS = {
  client_only: 'Client Side Only',
  singleplayer_only: 'Client Side Only',
  server_only: 'Server Only',
  dedicated_server_only: 'Dedicated Server Only',
  server_only_client_optional: 'Server Only (Client Optional)',
  client_and_server: 'Client & Server Required',
  client_or_server: 'Client or Server',
  client_or_server_prefers_both: 'Client or Server (Prefers Both)',
  client_only_server_optional: 'Client Focused — Server Optional',
  unknown: 'Compatibility Unknown',
};
const ENVIRONMENT_WARNINGS = {
  client_and_server: 'This mod must also be installed on connecting Minecraft clients.',
  client_only_server_optional: 'This mod is client-focused. Server installation may be unnecessary.',
};
const REJECT_NAME_RE = /(^|[._-])(sources?|javadoc|dev|dev-sources?|sources-dev)([._-]|$)/i;

function namespaceCategory(id) {
  return `${CATEGORY_PREFIX}${id}`;
}

function parseCategory(category) {
  const raw = String(category || '').trim();
  if (!raw) return '';
  return raw.startsWith(CATEGORY_PREFIX) ? raw.slice(CATEGORY_PREFIX.length) : raw;
}

function sanitizeText(value, max = 4000) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeSlug(value) {
  const slug = String(value || '').trim();
  if (!/^[\w!@$()`.+,"\-']{1,64}$/.test(slug)) return '';
  return slug;
}

function safeCategoryName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) return '';
  return name;
}

function allowHttpsUrl(rawUrl, hosts) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    const host = parsed.hostname.toLowerCase();
    if (!(hosts || []).some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function mapLoader(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'quilt') return 'fabric';
  if (raw === 'forge') return 'neoforge';
  if (HOST_LOADERS.has(raw)) return raw;
  return 'unknown';
}

function loadersFromList(values) {
  const mapped = [...new Set((values || []).map(mapLoader).filter((item) => item !== 'unknown'))];
  if (mapped.length === 1) return mapped[0];
  if (mapped.length > 1) return 'any';
  return 'unknown';
}

function mapEnvironment(raw) {
  const key = String(raw || 'unknown').trim().toLowerCase() || 'unknown';
  if (BLOCKED_ENVIRONMENTS.has(key)) {
    return {
      raw: key,
      environment: 'client',
      label: ENVIRONMENT_LABELS[key],
      warning: 'This file is marked client-only and may not load on a dedicated server.',
    };
  }
  if (SERVER_ONLY_ENVIRONMENTS.has(key)) {
    return {
      raw: key,
      environment: 'server',
      label: ENVIRONMENT_LABELS[key] || 'Server',
      warning: '',
    };
  }
  if (BOTH_ENVIRONMENTS.has(key)) {
    return {
      raw: key,
      environment: 'both',
      label: ENVIRONMENT_LABELS[key] || 'Client and server',
      warning: ENVIRONMENT_WARNINGS[key] || '',
    };
  }
  return {
    raw: key === 'unknown' ? 'unknown' : key,
    environment: 'unknown',
    label: ENVIRONMENT_LABELS.unknown,
    warning: 'Compatibility is unknown for this file.',
  };
}

function summarizeProjectEnvironment(values) {
  const list = Array.isArray(values) ? values : (values ? [values] : []);
  const mapped = list.map(mapEnvironment);
  if (!mapped.length) return mapEnvironment('unknown');
  const envs = new Set(mapped.map((item) => item.environment));
  if (envs.size === 1) return mapped[0];
  if (envs.has('both')) {
    return mapped.find((item) => item.raw === 'client_and_server') || mapped.find((item) => item.environment === 'both');
  }
  return mapEnvironment('unknown');
}

function sortIndex(sortBy) {
  if (sortBy === 'popularity') return 'follows';
  if (sortBy === 'lastUpdated') return 'updated';
  if (sortBy === 'totalDownloads') return 'downloads';
  if (sortBy === 'newest') return 'newest';
  if (sortBy === 'follows') return 'follows';
  if (sortBy === 'downloads') return 'downloads';
  if (sortBy === 'updated') return 'updated';
  if (sortBy === 'relevance') return 'relevance';
  return 'relevance';
}

function environmentFacets(filter) {
  const value = String(filter || '').trim().toLowerCase();
  if (!value || value === 'all') return [];
  if (value === 'server-compatible' || value === 'server_compatible') {
    return [SERVER_COMPATIBLE_ENVIRONMENTS.map((item) => `environment:${item}`)];
  }
  if (value === 'server' || value === 'server-only' || value === 'server_only') {
    return [[...SERVER_ONLY_ENVIRONMENTS].map((item) => `environment:${item}`)];
  }
  if (value === 'both' || value === 'client-and-server' || value === 'client_and_server') {
    return [['environment:client_and_server']];
  }
  if (value === 'client' || value === 'client-only' || value === 'client_only') {
    return [[...BLOCKED_ENVIRONMENTS].map((item) => `environment:${item}`)];
  }
  if (value === 'unknown') return [['environment:unknown']];
  return [];
}

function loaderFacets(loader) {
  const mapped = mapLoader(loader);
  const values = SEARCH_LOADERS[mapped];
  if (!values) return [];
  return [values.map((item) => `categories:${item}`)];
}

function buildFacets({ minecraftVersions = [], loader = '', category = '', environment = '' } = {}) {
  const facets = [['project_type:mod']];
  const versions = (minecraftVersions || []).map((item) => String(item || '').trim()).filter(Boolean);
  if (versions.length) {
    facets.push(versions.map((version) => `versions:${version}`));
  }
  const loaders = loaderFacets(loader);
  if (loaders.length) facets.push(...loaders);
  const cat = safeCategoryName(parseCategory(category));
  if (cat) facets.push([`categories:${cat}`]);
  const env = environmentFacets(environment);
  if (env.length) facets.push(...env);
  return facets;
}

function isInstallableJar(file = {}) {
  const name = String(file.filename || file.fileName || file.name || '').toLowerCase();
  const ext = path.extname(name);
  if (ext !== '.jar') return false;
  if (file.file_type && file.file_type !== 'required-resource-pack' && /resource-pack/i.test(file.file_type)) {
    return false;
  }
  if (REJECT_NAME_RE.test(name.replace(/\.jar$/, ''))) return false;
  if (/\.(md|asc|sha\d+|sig)$/i.test(name)) return false;
  return true;
}

function selectPrimaryFile(files = []) {
  const list = Array.isArray(files) ? files.filter(isInstallableJar) : [];
  if (!list.length) return null;
  return list.find((file) => file.primary) || list[0];
}

function formatProject(hit = {}) {
  const slug = safeSlug(hit.slug) || String(hit.project_id || hit.id || '');
  const env = summarizeProjectEnvironment(hit.environment);
  const uniqueLoaders = [...new Set((hit.categories || []).map(mapLoader).filter((item) => item !== 'unknown'))];
  return {
    id: hit.project_id || hit.id,
    providerId: PROVIDER_ID,
    source: 'modrinth',
    edition: 'java',
    artifactType: 'mod',
    name: sanitizeText(hit.title || hit.name, 200),
    slug,
    description: sanitizeText(hit.description || hit.summary, 2000),
    author: sanitizeText(hit.author || 'Unknown', 120),
    thumbnail: allowHttpsUrl(hit.icon_url, CDN_HOSTS),
    websiteUrl: allowHttpsUrl(`https://modrinth.com/mod/${encodeURIComponent(slug)}`, SITE_HOSTS),
    curseforgeId: null,
    modrinthId: hit.project_id || hit.id,
    fileId: hit.latest_version || null,
    downloads: Number(hit.downloads) || 0,
    follows: Number(hit.follows) || 0,
    dateUpdated: hit.date_modified || hit.updated || '',
    datePublished: hit.date_created || hit.published || '',
    license: sanitizeText(typeof hit.license === 'object' ? (hit.license?.id || hit.license?.name) : hit.license, 80),
    loader: uniqueLoaders.length === 1 ? uniqueLoaders[0] : (uniqueLoaders.length ? 'any' : 'unknown'),
    minecraftVersions: Array.isArray(hit.versions) ? hit.versions.map(String) : [],
    environment: env.environment,
    environmentLabel: env.label,
    environmentRaw: env.raw,
    downloadState: 'unknown',
    type: 'mod',
    projectClass: 'mod',
    categories: uniqueLoaders,
    metadata: {
      modrinth: {
        projectId: hit.project_id || hit.id,
        slug,
      },
    },
  };
}

function formatVersionFile(project, version, file) {
  const env = mapEnvironment(version.environment);
  const loader = loadersFromList(version.loaders);
  const fileName = file.filename || `file-${version.id}.jar`;
  return {
    id: String(version.id),
    fileId: version.id,
    name: fileName,
    fileName,
    displayName: sanitizeText(version.name || version.version_number || fileName, 200),
    type: 'mod',
    edition: 'java',
    extension: path.extname(fileName).toLowerCase() || '.jar',
    date: version.date_published || '',
    size: Number(file.size) || 0,
    releaseType: version.version_type || 'unknown',
    loader,
    minecraftVersions: Array.isArray(version.game_versions) ? version.game_versions.map(String) : [],
    environment: env.environment,
    environmentLabel: env.label,
    environmentRaw: env.raw,
    sha1: file.hashes?.sha1 || '',
    sha512: file.hashes?.sha512 || '',
    url: allowHttpsUrl(file.url, CDN_HOSTS),
    warning: env.warning,
    fabric: loader === 'fabric' || loader === 'any',
    neoforge: loader === 'neoforge' || loader === 'any',
    primary: Boolean(file.primary),
    versionNumber: version.version_number || '',
    projectId: version.project_id || project?.modrinthId || project?.id,
    metadata: {
      modrinth: {
        projectId: version.project_id || project?.modrinthId,
        versionId: version.id,
        fileName,
        downloadUrl: allowHttpsUrl(file.url, CDN_HOSTS),
        environment: env.raw,
        loaders: version.loaders || [],
        minecraftVersions: version.game_versions || [],
        sha1: file.hashes?.sha1 || '',
        sha512: file.hashes?.sha512 || '',
      },
    },
  };
}

function clientOnlyError(detail = {}) {
  return Object.assign(new Error('Client-only files cannot be downloaded for a dedicated server.'), {
    status: 400,
    code: 'CLIENT_ONLY_FILE',
    fileId: detail.fileId || '',
    projectId: detail.projectId || '',
  });
}

function createProvider(services) {
  const http = services.catalogHttp;
  const cache = new Map();
  const negativeHash = new Map();

  function readCache(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.time > hit.ttl) {
      cache.delete(key);
      return null;
    }
    return hit.value;
  }

  function writeCache(key, value, ttl) {
    if (cache.size > 400) {
      const first = cache.keys().next().value;
      cache.delete(first);
    }
    cache.set(key, { time: Date.now(), ttl, value });
    return value;
  }

  async function apiGet(urlPath, params, ttl) {
    const key = JSON.stringify({ urlPath, params: params || {} });
    const cached = readCache(key);
    if (cached) return cached;
    const response = await http.request({
      credentialProfile: 'modrinth',
      url: `${API}${urlPath}`,
      params,
    });
    return writeCache(key, response.data, ttl);
  }

  async function taxonomy() {
    const data = await apiGet('/tag/category', undefined, TAG_TTL_MS);
    return Array.isArray(data) ? data.filter((item) => item.project_type === 'mod') : [];
  }

  function matchesEnvironmentFilter(env, filter) {
    const value = String(filter || '').trim().toLowerCase();
    if (!value || value === 'all') return true;
    if (value === 'server-compatible' || value === 'server_compatible') return env.environment !== 'client';
    if (value === 'server' || value === 'server-only' || value === 'server_only') return env.environment === 'server';
    if (value === 'both' || value === 'client-and-server' || value === 'client_and_server') {
      return env.raw === 'client_and_server';
    }
    if (value === 'client' || value === 'client-only' || value === 'client_only') return env.environment === 'client';
    if (value === 'unknown') return env.environment === 'unknown';
    return true;
  }

  async function listVersions(projectId, { minecraftVersions = [], loader = '' } = {}) {
    const params = { include_changelog: 'false' };
    const versions = (minecraftVersions || []).map(String).filter(Boolean);
    if (versions.length) params.game_versions = JSON.stringify(versions);
    const mapped = mapLoader(loader);
    if (SEARCH_LOADERS[mapped]) params.loaders = JSON.stringify(SEARCH_LOADERS[mapped]);
    const data = await apiGet(`/project/${encodeURIComponent(projectId)}/version`, params, VERSION_TTL_MS);
    return Array.isArray(data) ? data : [];
  }

  function filesFromVersions(project, versions) {
    return versions
      .map((version) => {
        const file = selectPrimaryFile(version.files || []);
        if (!file) return null;
        const formatted = formatVersionFile(project, version, file);
        if (!formatted.url) return null;
        return { version, file: formatted };
      })
      .filter(Boolean);
  }

  async function getVersion(versionId) {
    return apiGet(`/version/${encodeURIComponent(versionId)}`, undefined, VERSION_TTL_MS);
  }

  async function getProject(projectId) {
    const data = await apiGet(`/project/${encodeURIComponent(projectId)}`, undefined, PROJECT_TTL_MS);
    if (!data) return null;
    return formatProject({
      ...data,
      project_id: data.id,
      title: data.title,
      description: data.description,
      author: typeof data.organization === 'string' && data.organization
        ? data.organization
        : (data.author || ''),
      icon_url: data.icon_url,
      versions: data.game_versions,
      date_modified: data.updated,
      date_created: data.published,
      license: data.license,
      environment: data.environment,
      categories: data.categories,
      downloads: data.downloads,
    });
  }

  async function resolveRequiredDependencies(version, context, trail = []) {
    const deps = Array.isArray(version.dependencies) ? version.dependencies : [];
    const related = [];
    if (trail.length >= MAX_DEP_DEPTH) {
      throw Object.assign(new Error('Required dependencies are nested too deeply to install safely.'), { status: 400, code: 'DEPENDENCY_DEPTH' });
    }
    for (const dep of deps) {
      const type = String(dep.dependency_type || '').toLowerCase();
      if (type === 'optional' || type === 'embedded') continue;
      if (type === 'incompatible') {
        throw Object.assign(new Error('This version is incompatible with another selected or installed mod.'), {
          status: 400,
          code: 'DEPENDENCY_CONFLICT',
        });
      }
      if (type !== 'required') continue;
      if (related.length + trail.length >= MAX_DEP_COUNT) {
        throw Object.assign(new Error('This project has too many required dependencies to install automatically.'), {
          status: 400,
          code: 'DEPENDENCY_LIMIT',
        });
      }
      const depProjectId = dep.project_id || '';
      if (depProjectId && trail.includes(depProjectId)) {
        throw Object.assign(new Error('A required dependency cycle was detected.'), { status: 400, code: 'DEPENDENCY_CYCLE' });
      }
      let depVersion = null;
      if (dep.version_id) {
        depVersion = await getVersion(dep.version_id);
      } else if (depProjectId) {
        const versions = await listVersions(depProjectId, context);
        depVersion = versions[0] || null;
      }
      if (!depVersion) {
        throw Object.assign(new Error('A required dependency is missing or has no compatible version.'), {
          status: 400,
          code: 'MISSING_DEPENDENCY',
        });
      }
      const env = mapEnvironment(depVersion.environment);
      if (env.environment === 'client') {
        throw clientOnlyError({
          fileId: depVersion.id,
          projectId: depVersion.project_id,
        });
      }
      const project = await getProject(depVersion.project_id);
      const primary = selectPrimaryFile(depVersion.files || []);
      if (!primary) {
        throw Object.assign(new Error('A required dependency does not include an installable jar.'), { status: 400 });
      }
      const formatted = formatVersionFile(project, depVersion, primary);
      if (formatted.environment === 'client') throw clientOnlyError({ fileId: formatted.id, projectId: formatted.projectId });
      related.push({
        project,
        files: [{
          ...formatted,
          maximumBytes: MAX_FILE_BYTES,
        }],
      });
      const nested = await resolveRequiredDependencies(depVersion, context, [...trail, depVersion.project_id]);
      related.push(...nested);
    }
    const seen = new Set();
    return related.filter((item) => {
      const id = item.project?.modrinthId || item.project?.id;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  return {
    getMetadata() {
      return {
        id: PROVIDER_ID,
        name: 'Modrinth',
        source: 'modrinth',
        editions: ['java'],
        credentialProfile: null,
        homepage: 'https://modrinth.com/',
        downloadHosts: ['api.modrinth.com', 'cdn.modrinth.com'],
        notices: [
          'Java mods are executable code. Trust a project before installing it on a server.',
          'Modrinth search uses https://modrinth.com/ and https://docs.modrinth.com/api/. No API key is required.',
        ],
      };
    },
    isAvailable() {
      return Boolean(http && typeof http.request === 'function');
    },
    async getCategories() {
      if (!this.isAvailable()) return [];
      const items = await taxonomy();
      return items.map((item) => ({
        id: namespaceCategory(item.name),
        name: sanitizeText(item.name, 80),
        description: 'Modrinth Java category',
        providerId: PROVIDER_ID,
        edition: 'java',
        source: 'modrinth',
      }));
    },
    async search(query, options = {}) {
      if (!this.isAvailable()) {
        throw Object.assign(new Error('The Modrinth Java catalog is not available.'), { status: 400 });
      }
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(options.pageSize) || MAX_PAGE_SIZE));
      const offset = options.offset != null
        ? Math.max(0, Number(options.offset) || 0)
        : ((Math.max(1, Number(options.page) || 1) - 1) * pageSize);
      const facets = buildFacets({
        minecraftVersions: options.minecraftVersions,
        loader: options.loader,
        category: options.category,
        environment: options.environment,
      });
      const params = {
        limit: pageSize,
        offset,
        index: sortIndex(options.sortBy),
        facets: JSON.stringify(facets),
      };
      if (query) params.query = String(query);
      const data = await apiGet('/search', params, SEARCH_TTL_MS);
      const hits = Array.isArray(data.hits) ? data.hits : [];
      const results = hits
        .map(formatProject)
        .filter((item) => matchesEnvironmentFilter({
          environment: item.environment,
          raw: item.environmentRaw,
        }, options.environment));
      return {
        results,
        total: Number(data.total_hits) || results.length,
        page: options.page || 1,
      };
    },
    async getDetails(projectId) {
      return getProject(projectId);
    },
    async listDownloadFiles(projectId, options = {}) {
      const project = await getProject(projectId);
      const versions = await listVersions(projectId, {
        minecraftVersions: options.minecraftVersions || options.gameVersions,
        loader: options.loader,
      });
      return filesFromVersions(project, versions).map((item) => item.file);
    },
    async download(projectId, fileSelection, options = {}) {
      const details = await getProject(projectId);
      if (!details) {
        throw Object.assign(new Error('That Modrinth project is not available.'), { status: 404 });
      }
      const versions = await listVersions(projectId, {
        minecraftVersions: options.minecraftVersions || options.gameVersions,
        loader: options.loader,
      });
      const listed = filesFromVersions(details, versions);
      const formatted = listed.map((item) => item.file);
      const selectedIds = Array.isArray(fileSelection) ? fileSelection.map(String).filter(Boolean) : [];
      if (!selectedIds.length) {
        const selectable = formatted.filter((file) => file.environment !== 'client');
        if (formatted.length && !selectable.length) throw clientOnlyError({ projectId });
        if (formatted.length !== 1 || selectable.length !== 1) {
          return {
            needsSelection: true,
            files: formatted,
            warning: 'Choose a file that matches your Minecraft version and loader. The newest file is not always compatible.',
          };
        }
        selectedIds.push(selectable[0].id);
      }
      const byId = new Map(listed.map((item) => [String(item.file.id), item]));
      const wanted = [];
      for (const id of selectedIds) {
        const match = byId.get(id);
        if (!match) {
          throw Object.assign(new Error('Unknown catalog file ID'), {
            status: 400,
            code: 'UNKNOWN_FILE_ID',
            fileId: id,
          });
        }
        if (match.file.environment === 'client') {
          throw clientOnlyError({ fileId: id, projectId });
        }
        if (!match.file.url) {
          throw Object.assign(new Error('Invalid CDN URL'), { status: 400 });
        }
        wanted.push(match);
      }
      const relatedPlans = [];
      for (const item of wanted) {
        const extras = await resolveRequiredDependencies(item.version, {
          minecraftVersions: item.file.minecraftVersions,
          loader: item.file.loader,
        }, [item.version.project_id]);
        relatedPlans.push(...extras);
      }
      return {
        plan: true,
        project: details,
        files: wanted.map((item) => ({
          ...item.file,
          maximumBytes: MAX_FILE_BYTES,
        })),
        relatedPlans,
      };
    },
    async lookupHash(hash, algorithm = 'sha1') {
      const key = `${algorithm}:${String(hash || '').toLowerCase()}`;
      const missed = negativeHash.get(key);
      if (missed && Date.now() - missed < NEGATIVE_HASH_TTL_MS) return null;
      try {
        return await apiGet(`/version_file/${encodeURIComponent(hash)}`, { algorithm }, VERSION_TTL_MS);
      } catch (err) {
        if (err.status === 404) {
          negativeHash.set(key, Date.now());
          return null;
        }
        throw err;
      }
    },
    mapEnvironment,
    buildFacets,
    sortIndex,
    selectPrimaryFile,
    isInstallableJar,
    sanitizeText,
    formatProject,
    formatVersionFile,
  };
}

module.exports = {
  PROVIDER_ID,
  createProvider,
  mapEnvironment,
  buildFacets,
  sortIndex,
  selectPrimaryFile,
  isInstallableJar,
  sanitizeText,
  formatProject,
  register({ registerCatalogSource, services }) {
    registerCatalogSource(createProvider(services));
  },
};
