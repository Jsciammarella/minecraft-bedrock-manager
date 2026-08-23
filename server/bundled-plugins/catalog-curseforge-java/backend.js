const path = require('path');

const GAME_ID = 432;
const DEFAULT_CLASS_ID = 6;
const API = 'https://api.curseforge.com';
const CLASS_SLUGS = {
  6: 'mc-mods',
  12: 'texture-packs',
  17: 'worlds',
  4471: 'modpacks',
  6552: 'shaders',
  6945: 'datapacks',
};
const LOADER_ALIASES = {
  fabric: 'fabric',
  forge: 'forge',
  neoforge: 'neoforge',
  quilt: 'quilt',
  liteloader: 'unknown',
  rift: 'unknown',
};
const RELEASE_TYPES = {
  1: 'release',
  2: 'beta',
  3: 'alpha',
};

function namespaceCategory(id) {
  return `curseforge-java:${id}`;
}

function parseCategory(category) {
  const raw = String(category || '').trim();
  if (!raw) return '';
  return raw.startsWith('curseforge-java:') ? raw.slice('curseforge-java:'.length) : raw;
}

function parseGameVersions(versions) {
  const list = Array.isArray(versions) ? versions.map((item) => String(item || '')) : [];
  const loaders = [];
  const envs = [];
  const minecraftVersions = [];
  for (const value of list) {
    const lower = value.toLowerCase();
    if (LOADER_ALIASES[lower]) {
      if (LOADER_ALIASES[lower] !== 'unknown') loaders.push(LOADER_ALIASES[lower]);
      continue;
    }
    if (lower === 'client' || lower === 'server') {
      envs.push(lower);
      continue;
    }
    if (/^\d+\.\d+/.test(value)) minecraftVersions.push(value);
  }
  let loader = 'unknown';
  const uniqueLoaders = [...new Set(loaders)];
  if (uniqueLoaders.length === 1) loader = uniqueLoaders[0];
  else if (uniqueLoaders.length > 1) loader = 'any';
  let environment = 'unknown';
  const uniqueEnvs = [...new Set(envs)];
  if (uniqueEnvs.includes('client') && uniqueEnvs.includes('server')) environment = 'both';
  else if (uniqueEnvs.length === 1) environment = uniqueEnvs[0];
  return { loader, environment, minecraftVersions };
}

function classSlug(item) {
  return CLASS_SLUGS[item.classId] || item.classId || 'mc-mods';
}

function formatProject(item) {
  const files = item.latestFiles || [];
  const parsed = parseGameVersions(files[0]?.gameVersions || item.latestFilesIndexes?.[0]?.gameVersions || []);
  const slug = item.slug || String(item.id);
  return {
    id: item.id,
    providerId: 'curseforge-java',
    source: 'curseforge',
    edition: 'java',
    artifactType: 'mod',
    name: item.name,
    slug,
    description: item.summary || item.description || '',
    author: item.authors?.[0]?.name || 'Unknown',
    thumbnail: item.logo?.thumbnailUrl || item.logo?.url || '',
    websiteUrl: item.links?.websiteUrl || `https://www.curseforge.com/minecraft/${classSlug(item)}/${slug}`,
    curseforgeId: item.id,
    fileId: item.mainFileId || files[0]?.id || null,
    downloads: item.downloadCount || 0,
    dateUpdated: item.dateModified || item.dateUpdated || '',
    loader: parsed.loader,
    minecraftVersions: parsed.minecraftVersions,
    environment: parsed.environment,
    downloadState: 'unknown',
    type: 'mod',
    projectClass: classSlug(item),
  };
}

function formatFile(file) {
  const parsed = parseGameVersions(file.gameVersions || []);
  const hashes = Array.isArray(file.hashes) ? file.hashes : [];
  const sha1 = hashes.find((item) => item.algo === 1)?.value || '';
  const warning = parsed.environment === 'client'
    ? 'This file is marked client-only and may not load on a dedicated server.'
    : '';
  return {
    id: String(file.id),
    fileId: file.id,
    name: file.fileName || `file-${file.id}`,
    fileName: file.fileName || `file-${file.id}`,
    displayName: file.displayName || file.fileName || '',
    type: 'mod',
    edition: 'java',
    extension: path.extname(file.fileName || '').toLowerCase() || '.jar',
    date: file.fileDate || '',
    size: file.fileLength || 0,
    releaseType: RELEASE_TYPES[file.releaseType] || 'unknown',
    loader: parsed.loader,
    minecraftVersions: parsed.minecraftVersions,
    environment: parsed.environment,
    sha1,
    warning,
    fabric: parsed.loader === 'fabric' || parsed.loader === 'any',
    neoforge: parsed.loader === 'neoforge' || parsed.loader === 'any',
  };
}

function createProvider(services) {
  const http = services.catalogHttp;
  const cache = new Map();

  async function apiGet(urlPath, params) {
    const response = await http.request({
      credentialProfile: 'curseforge',
      url: `${API}${urlPath}`,
      params,
    });
    return response.data;
  }

  async function taxonomy() {
    const cached = cache.get('taxonomy');
    if (cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.value;
    const data = await apiGet('/v1/categories', { gameId: GAME_ID });
    const value = data.data || [];
    cache.set('taxonomy', { time: Date.now(), value });
    return value;
  }

  async function applyCategory(params, category) {
    const requested = parseCategory(category);
    if (!requested) {
      params.classId = DEFAULT_CLASS_ID;
      return;
    }
    const items = await taxonomy();
    const match = items.find((item) => (
      String(item.id) === requested
      || item.slug === requested
      || namespaceCategory(item.slug || item.id) === category
    ));
    if (match?.isClass) {
      params.classId = match.id;
    } else if (match) {
      params.categoryId = match.id;
      params.classId = match.classId || DEFAULT_CLASS_ID;
    } else if (requested === 'mc-mods') {
      params.classId = DEFAULT_CLASS_ID;
    } else {
      params.classId = DEFAULT_CLASS_ID;
    }
  }

  function sortField(sortBy) {
    if (sortBy === 'popularity') return 2;
    if (sortBy === 'lastUpdated') return 3;
    if (sortBy === 'totalDownloads') return 6;
    return 1;
  }

  async function listModFiles(modId) {
    const files = [];
    let index = 0;
    for (let page = 0; page < 10; page += 1) {
      const data = await apiGet(`/v1/mods/${encodeURIComponent(modId)}/files`, { index, pageSize: 50 });
      const batch = data.data || [];
      files.push(...batch);
      const total = data.pagination?.totalCount || files.length;
      index += batch.length;
      if (!batch.length || index >= total) break;
    }
    return files;
  }

  function selectFiles(files, fileSelection) {
    const selected = Array.isArray(fileSelection) ? fileSelection.map(String).filter(Boolean) : [];
    const formatted = files
      .filter((file) => path.extname(file.fileName || '').toLowerCase() === '.jar')
      .sort((a, b) => new Date(b.fileDate || 0) - new Date(a.fileDate || 0))
      .map(formatFile);
    if (selected.length) {
      const byId = new Map(formatted.map((file) => [String(file.id), file]));
      const wanted = [];
      for (const id of selected) {
        const file = byId.get(id);
        if (!file) {
          const err = new Error('Unknown catalog file ID');
          err.status = 400;
          err.code = 'UNKNOWN_FILE_ID';
          err.fileId = id;
          throw err;
        }
        if (file.environment === 'client') {
          const err = new Error('Client-only files cannot be downloaded for a dedicated server.');
          err.status = 400;
          err.code = 'CLIENT_ONLY_FILE';
          err.fileId = id;
          throw err;
        }
        wanted.push(file);
      }
      return { files: wanted };
    }
    const selectable = formatted.filter((file) => file.environment !== 'client');
    if (formatted.length > 0 && selectable.length === 0) {
      const err = new Error('Client-only files cannot be downloaded for a dedicated server.');
      err.status = 400;
      err.code = 'CLIENT_ONLY_FILE';
      throw err;
    }
    const loaders = new Set(formatted.map((file) => file.loader || 'unknown'));
    const mixed = loaders.size > 1 || loaders.has('unknown') || loaders.has('any');
    if (mixed || formatted.length > 1) {
      return {
        needsSelection: true,
        files: formatted,
        warning: mixed
          ? 'This project publishes files for different loaders or unknown compatibility. Choose a file manually.'
          : 'Choose a file that matches your Minecraft version and loader.',
      };
    }
    return { files: selectable.slice(0, 1) };
  }

  return {
    getMetadata() {
      return {
        id: 'curseforge-java',
        name: 'CurseForge Java',
        source: 'curseforge',
        editions: ['java'],
        credentialProfile: 'curseforge',
        homepage: 'https://www.curseforge.com/minecraft',
        downloadHosts: [
          'api.curseforge.com',
          'forgecdn.net',
          'edge.forgecdn.net',
          'mediafilez.forgecdn.net',
          'media.forgecdn.net',
        ],
        notices: ['Java mods are executable code. Trust a project before installing it on a server.'],
      };
    },
    isAvailable() {
      return Boolean(http.isConfigured('curseforge'));
    },
    async getCategories() {
      if (!this.isAvailable()) return [];
      const items = await taxonomy();
      return items
        .filter((item) => item.isClass || item.classId === DEFAULT_CLASS_ID)
        .map((item) => ({
          id: namespaceCategory(item.slug || item.id),
          name: item.name,
          description: item.isClass ? 'CurseForge Java class' : 'CurseForge Java category',
          providerId: 'curseforge-java',
          edition: 'java',
          source: 'curseforge',
        }));
    },
    async search(query, options = {}) {
      if (!this.isAvailable()) {
        const err = new Error('CurseForge Java requires the existing CurseForge API key. Open Catalog Settings to add it.');
        err.status = 400;
        err.code = 'CURSEFORGE_API_KEY_REQUIRED';
        throw err;
      }
      const pageSize = options.pageSize || 40;
      const offset = options.offset != null ? Number(options.offset) : ((options.page || 1) - 1) * pageSize;
      const params = {
        gameId: GAME_ID,
        pageSize,
        index: offset,
        sortField: sortField(options.sortBy),
        sortOrder: 'desc',
      };
      if (query) params.searchFilter = query;
      await applyCategory(params, options.category);
      const versions = Array.isArray(options.minecraftVersions) ? options.minecraftVersions.filter(Boolean) : [];
      if (versions.length === 1) {
        params.gameVersion = versions[0];
      } else if (versions.length > 1) {
        const pages = [];
        for (const version of versions) {
          const data = await apiGet('/v1/mods/search', { ...params, gameVersion: version });
          pages.push({
            results: (data.data || []).map(formatProject),
            total: data.pagination?.totalCount || 0,
          });
        }
        const seen = new Set();
        const results = [];
        for (const page of pages) {
          for (const item of page.results) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            results.push(item);
          }
        }
        return {
          results: results.slice(0, pageSize),
          total: Math.max(...pages.map((item) => item.total), results.length),
          page: options.page || 1,
        };
      }
      const data = await apiGet('/v1/mods/search', params);
      return {
        results: (data.data || []).map(formatProject),
        total: data.pagination?.totalCount || 0,
        page: options.page || 1,
      };
    },
    async getDetails(projectId) {
      const data = await apiGet(`/v1/mods/${encodeURIComponent(projectId)}`);
      return data.data ? formatProject(data.data) : null;
    },
    async listDownloadFiles(projectId) {
      const files = await listModFiles(projectId);
      return files
        .filter((file) => path.extname(file.fileName || '').toLowerCase() === '.jar')
        .sort((a, b) => new Date(b.fileDate || 0) - new Date(a.fileDate || 0))
        .map(formatFile);
    },
    async download(projectId, fileSelection) {
      const details = await this.getDetails(projectId);
      const listed = await listModFiles(projectId);
      const selected = selectFiles(listed, fileSelection);
      if (selected.needsSelection) return selected;
      if ((selected.files || []).some((file) => file.environment === 'client')) {
        const err = new Error('Client-only files cannot be downloaded for a dedicated server.');
        err.status = 400;
        err.code = 'CLIENT_ONLY_FILE';
        throw err;
      }
      const planned = [];
      for (const file of selected.files) {
        const urlData = await apiGet(`/v1/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file.fileId)}/download-url`);
        const url = urlData.data || listed.find((item) => String(item.id) === String(file.id))?.downloadUrl;
        if (!url) throw new Error(`CurseForge did not provide a download URL for ${file.name}`);
        planned.push({
          ...file,
          url,
          maximumBytes: 250 * 1024 * 1024,
        });
      }
      return {
        plan: true,
        project: details,
        files: planned,
      };
    },
    parseGameVersions,
    formatFile,
    selectFiles,
  };
}

module.exports = {
  GAME_ID,
  createProvider,
  parseGameVersions,
  register({ registerCatalogSource, services }) {
    registerCatalogSource(createProvider(services));
  },
};
