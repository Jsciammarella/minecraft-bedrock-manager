const path = require('path');
const packFiles = require('../../../services/packFiles');

const GAME_ID = 78022;
const API = 'https://api.curseforge.com';
const PROVIDER_ID = 'curseforge-bedrock';
const KEY_MESSAGE = 'CurseForge catalog access requires an API key. Open the CurseForge Catalog plugin settings to add it.';
const DOWNLOAD_HOSTS = [
  'api.curseforge.com',
  'forgecdn.net',
  'edge.forgecdn.net',
  'mediafilez.forgecdn.net',
  'media.forgecdn.net',
];
const CLASS_IDS = {
  addons: 4984,
  maps: 6913,
  'texture-packs': 6929,
  scripts: 6940,
  skins: 6925,
};
const CLASS_SLUGS = Object.fromEntries(
  Object.entries(CLASS_IDS).map(([slug, id]) => [String(id), slug])
);
const STATIC_CATEGORIES = [
  { id: 'addons', name: 'Addons', description: 'Behavior and content addons' },
  { id: 'texture-packs', name: 'Texture Packs', description: 'Visual enhancements' },
  { id: 'maps', name: 'Maps', description: 'World maps and levels' },
  { id: 'scripts', name: 'Scripts', description: 'Script addons' },
  { id: 'skins', name: 'Skins', description: 'Player skins' },
  { id: 'utility', name: 'Utility', description: 'Utility addons' },
  { id: 'vanilla', name: 'Vanilla+', description: 'Vanilla enhancements' },
  { id: 'survival', name: 'Survival', description: 'Survival addons' },
  { id: 'technology', name: 'Technology', description: 'Tech addons' },
  { id: 'magic', name: 'Magic', description: 'Magic addons' },
  { id: 'multiplayer', name: 'Multiplayer', description: 'Multiplayer addons' },
];

function missingKey() {
  return Object.assign(new Error(KEY_MESSAGE), { status: 400, code: 'CURSEFORGE_API_KEY_REQUIRED' });
}

function projectClassFromItem(item) {
  const url = item.links?.websiteUrl || '';
  const fromUrl = url.match(/\/minecraft-bedrock\/(addons|maps|texture-packs|scripts|skins)\//)?.[1];
  if (fromUrl) return fromUrl;
  return CLASS_SLUGS[String(item.classId)] || 'addons';
}

function inferType(categories = []) {
  const names = categories.map((item) => String(item.name || item.slug || '').toLowerCase());
  if (names.some((name) => name.includes('world') || name.includes('map'))) return 'world';
  if (names.some((name) => name.includes('texture') || name.includes('resource'))) return 'resource_pack';
  return 'addon';
}

function formatProject(item) {
  const projectClass = projectClassFromItem(item);
  const slug = item.slug || String(item.id);
  return {
    id: item.id,
    providerId: PROVIDER_ID,
    source: 'curseforge',
    edition: 'bedrock',
    artifactType: inferType(item.categories || []),
    name: item.name,
    slug,
    description: item.summary || item.description || '',
    author: item.authors?.[0]?.name || 'Unknown',
    thumbnail: item.logo?.thumbnailUrl || item.logo?.url || '',
    websiteUrl: item.links?.websiteUrl || `https://www.curseforge.com/minecraft-bedrock/${projectClass}/${slug}`,
    curseforgeId: item.id,
    fileId: item.mainFileId || item.latestFiles?.[0]?.id || null,
    downloads: item.downloadCount || 0,
    dateUpdated: item.dateModified || item.dateUpdated || '',
    downloadState: 'unknown',
    type: inferType(item.categories || []),
    projectClass,
    categories: item.categories || [],
  };
}

function formatFile(file) {
  const ext = path.extname(file.fileName || '').toLowerCase();
  return {
    id: String(file.id),
    fileId: file.id,
    name: file.fileName || `file-${file.id}`,
    fileName: file.fileName || `file-${file.id}`,
    displayName: file.displayName || file.fileName || '',
    type: packFiles.typeFromExt(file.fileName || ''),
    edition: 'bedrock',
    extension: ext,
    date: file.fileDate || '',
    size: file.fileLength || 0,
  };
}

function sortField(sortBy) {
  if (sortBy === 'popularity') return 2;
  if (sortBy === 'lastUpdated') return 3;
  if (sortBy === 'totalDownloads') return 6;
  return 1;
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
    const requested = String(category || '').trim();
    if (!requested) return;
    try {
      const items = await taxonomy();
      const match = items.find((item) => (
        String(item.id) === requested
        || item.slug === requested
        || (item.name || '').toLowerCase().replace(/\s+/g, '-') === requested
      ));
      if (match?.isClass) params.classId = match.id;
      else if (match) {
        params.categoryId = match.id;
        if (match.classId) params.classId = match.classId;
      } else if (CLASS_IDS[requested]) {
        params.classId = CLASS_IDS[requested];
      }
    } catch {
      if (CLASS_IDS[requested]) params.classId = CLASS_IDS[requested];
    }
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
      .filter((file) => packFiles.isImportExt(path.extname(file.fileName || '')) && !packFiles.isJavaExt(path.extname(file.fileName || '')))
      .sort((a, b) => new Date(b.fileDate || 0) - new Date(a.fileDate || 0));
    if (selected.length) {
      const byId = new Map(formatted.map((file) => [String(file.id), file]));
      const wanted = [];
      for (const id of selected) {
        const file = byId.get(id);
        if (!file) {
          throw Object.assign(new Error('Unknown catalog file ID'), { status: 400, code: 'UNKNOWN_FILE_ID', fileId: id });
        }
        wanted.push(file);
      }
      return wanted;
    }
    const byExt = new Map();
    for (const file of formatted) {
      const ext = path.extname(file.fileName || '').toLowerCase();
      const date = new Date(file.fileDate || 0).getTime();
      const prev = byExt.get(ext);
      if (!prev || date > prev.date) byExt.set(ext, { file, date });
    }
    const picked = [...byExt.values()].map((item) => item.file);
    const rank = { '.mcaddon': 0, '.zip': 1, '.mcpack': 2, '.mcworld': 3, '.mctemplate': 4, '.mcstructure': 5 };
    picked.sort((a, b) => (
      (rank[path.extname(a.fileName || '').toLowerCase()] ?? 9)
      - (rank[path.extname(b.fileName || '').toLowerCase()] ?? 9)
    ));
    if (formatted.length > 1 && picked.length !== 1) return { needsSelection: true, files: formatted.map(formatFile) };
    return picked.slice(0, 1);
  }

  return {
    getMetadata() {
      return {
        id: PROVIDER_ID,
        name: 'CurseForge Bedrock',
        source: 'curseforge',
        editions: ['bedrock'],
        credentialProfile: 'curseforge',
        homepage: 'https://www.curseforge.com/minecraft-bedrock',
        downloadHosts: DOWNLOAD_HOSTS,
      };
    },
    isAvailable() {
      return Boolean(http.isConfigured('curseforge'));
    },
    async getCategories() {
      return STATIC_CATEGORIES.map((item) => ({
        ...item,
        providerId: PROVIDER_ID,
        edition: 'bedrock',
        source: 'curseforge',
      }));
    },
    async search(query, options = {}) {
      if (!this.isAvailable()) throw missingKey();
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
      if (versions.length === 1) params.gameVersion = versions[0];
      else if (options.version) params.gameVersion = options.version;
      const data = await apiGet('/v1/mods/search', params);
      return {
        results: (data.data || []).map(formatProject),
        total: data.pagination?.totalCount || 0,
        page: options.page || 1,
      };
    },
    async getDetails(projectId, options = {}) {
      if (!this.isAvailable()) throw missingKey();
      if (projectId && /^\d+$/.test(String(projectId))) {
        const data = await apiGet(`/v1/mods/${encodeURIComponent(projectId)}`);
        return data.data ? formatProject(data.data) : null;
      }
      const slug = options.slug || projectId;
      if (!slug) return null;
      const params = { gameId: GAME_ID, slug, pageSize: 5 };
      const projectClass = options.projectClass;
      if (CLASS_IDS[projectClass]) params.classId = CLASS_IDS[projectClass];
      const data = await apiGet('/v1/mods/search', params);
      const match = (data.data || []).find((item) => item.slug === slug);
      return match ? formatProject(match) : null;
    },
    async listDownloadFiles(projectId, options = {}) {
      const modId = options.curseforgeId || projectId;
      if (!modId) return [];
      const files = await listModFiles(modId);
      return files
        .filter((file) => packFiles.isImportExt(path.extname(file.fileName || '')) && !packFiles.isJavaExt(path.extname(file.fileName || '')))
        .sort((a, b) => new Date(b.fileDate || 0) - new Date(a.fileDate || 0))
        .map(formatFile);
    },
    async download(projectId, fileSelection, options = {}) {
      const details = await this.getDetails(options.curseforgeId || projectId, options);
      if (!details) throw Object.assign(new Error('That CurseForge project is not available.'), { status: 404 });
      const listed = await listModFiles(details.curseforgeId || projectId);
      const selected = selectFiles(listed, fileSelection);
      if (selected.needsSelection) return selected;
      const planned = [];
      for (const file of selected) {
        const urlData = await apiGet(`/v1/mods/${encodeURIComponent(details.curseforgeId)}/files/${encodeURIComponent(file.id)}/download-url`);
        const url = urlData.data || file.downloadUrl;
        if (!url) throw new Error(`CurseForge did not provide a download URL for ${file.fileName || file.id}`);
        planned.push({
          ...formatFile(file),
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
  };
}

module.exports = {
  GAME_ID,
  PROVIDER_ID,
  createProvider,
};
