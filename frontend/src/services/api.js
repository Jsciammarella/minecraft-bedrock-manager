import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// ========== SERVERS ==========

export const serverApi = {
  getAll: () => api.get('/servers'),
  getById: (id) => api.get(`/servers/${id}`),
  create: (data) => api.post('/servers', data, { timeout: 60000 }),
  update: (id, data) => api.put(`/servers/${id}`, data),
  delete: (id) => api.delete(`/servers/${id}`),
  start: (id) => api.post(`/servers/${id}/start`),
  stop: (id) => api.post(`/servers/${id}/stop`),
  restart: (id) => api.post(`/servers/${id}/restart`),
  restartWithWarning: (id) => api.post(`/servers/${id}/restart-with-warning`),
  cancelWarnedRestart: (id) => api.delete(`/servers/${id}/restart-with-warning`),
  command: (id, cmd) => api.post(`/servers/${id}/command`, { command: cmd }),
  updateVersion: (id, version) => api.post(`/servers/${id}/update`, { version }, { timeout: 120000 }),
  checkUpdates: () => api.get('/servers/check-updates'),
  previewBedrockConnect: () => api.get('/servers/bedrock-connect/preview'),
  createBedrockConnect: (data) => api.post('/servers/bedrock-connect', data, { timeout: 120000 }),
  bedrockConnectVersions: () => api.get('/servers/bedrock-connect/versions'),
  checkBedrockConnectUpdates: () => api.post('/servers/bedrock-connect/check-updates', {}, { timeout: 120000 }),
  previewLanBroadcast: (id) => api.get(`/servers/${id}/lan-broadcast`),
  setLanBroadcast: (id, data) => api.put(`/servers/${id}/lan-broadcast`, data, { timeout: 120000 }),
  
  // Auto-update management
  getAutoUpdate: (id) => api.get(`/servers/${id}/auto-update`),
  enableAutoUpdate: (id, intervalHours = 24) => api.post(`/servers/${id}/auto-update`, { intervalHours }),
  disableAutoUpdate: (id) => api.delete(`/servers/${id}/auto-update`),
  getAllAutoUpdates: () => api.get('/servers/auto-update/all'),
};

// ========== MODS ==========

export const modApi = {
  getAll: () => api.get('/mods'),
  getById: (id) => api.get(`/mods/${id}`),
  upload: (file, metadata, onProgress) => {
    const formData = new FormData();
    formData.append('file', file);
    if (metadata) Object.entries(metadata).forEach(([k, v]) => formData.append(k, v));
    return api.post('/mods/upload', formData, {
      timeout: 10 * 60 * 1000,
      onUploadProgress: (event) => {
        if (typeof onProgress !== 'function') return;
        if (!event.total) {
          onProgress(null);
          return;
        }
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      },
    });
  },
  importCurseforgeUrl: (url) => api.post('/mods/import-curseforge', { url }, {
    timeout: 20 * 60 * 1000,
  }),
  importMcpedlUrl: (url) => api.post('/mods/import-mcpedl', { url }, {
    timeout: 20 * 60 * 1000,
  }),
  delete: (id) => api.delete(`/mods/${id}`),
  update: (id, { description, thumbnailFile, clearThumbnail }) => {
    const formData = new FormData();
    if (description != null) formData.append('description', description);
    if (clearThumbnail) formData.append('clearThumbnail', '1');
    if (thumbnailFile) formData.append('thumbnail', thumbnailFile);
    return api.put(`/mods/${id}`, formData);
  },
  getAvailable: (serverId) => api.get(`/mods/available/${serverId}`),
  getInstalled: (serverId) => api.get(`/mods/installed/${serverId}`),
  install: (modId, serverId) => api.post(`/mods/${modId}/install/${serverId}`, null, {
    timeout: 10 * 60 * 1000,
  }),
  uninstall: (modId, serverId) => api.delete(`/mods/${modId}/uninstall/${serverId}`, {
    timeout: 10 * 60 * 1000,
  }),
  
  catalogSearch: (params) => api.get('/mods/catalog/search', { params, timeout: 90000 }),
  catalogCategories: () => api.get('/mods/catalog/categories'),
  catalogDownload: (mod, serverId) => api.post(`/mods/catalog/download/${encodeURIComponent(mod.slug)}`, {
    source: mod.source || 'curseforge',
    projectClass: mod.projectClass,
    curseforgeId: mod.curseforgeId,
    fileId: mod.fileId,
    serverId,
  }),
  catalogDetails: (slug, projectClass, source) => api.get(`/mods/catalog/${encodeURIComponent(slug)}`, {
    params: { projectClass, source },
  }),
  catalogSettings: () => api.get('/mods/catalog/settings'),
  saveCatalogSettings: (data) => api.put('/mods/catalog/settings', data),
  testGitCatalog: (data) => api.post('/mods/catalog/git/test', data, { timeout: 45000 }),
  gitCatalogSyncStatus: () => api.get('/mods/catalog/git/status'),
  syncGitCatalog: () => api.post('/mods/catalog/git/sync'),
};

// ========== PLAYERS ==========

export const playerApi = {
  getAll: () => api.get('/players'),
  getByServer: (serverId) => api.get(`/players/server/${serverId}`),
  scan: (serverId) => api.post(`/players/scan/${serverId}`),
  add: (data) => api.post('/players', data),
  whitelist: (id, serverId) => api.post(`/players/${id}/whitelist`, { serverId }),
  unwhitelist: (id, serverId) => api.post(`/players/${id}/unwhitelist`, { serverId }),
  unwhitelistAll: (id) => api.post(`/players/${id}/unwhitelist-all`),
  banAll: (id, reason) => api.post(`/players/${id}/ban-all`, { reason }),
  unbanAll: (id) => api.post(`/players/${id}/unban-all`),
  updateServerAccess: (serverId, playerId, data) => api.put(`/players/server/${serverId}/${playerId}`, data),
  search: (q) => api.get('/players/search', { params: { q } }),
};

// ========== PORTS ==========

export const portApi = {
  getAll: () => api.get('/ports'),
  search: (q) => api.get('/ports/search', { params: { q } }),
  check: (port) => api.get(`/ports/check/${port}`),
};

export const bedrockConnectApi = {
  get: () => api.get('/bedrock-connect'),
  saveDns: (data) => api.put('/bedrock-connect/dns', data),
};

// ========== PUBLIC API ==========

export const publicApi = {
  overview: () => api.get('/v1/overview'),
  serverStatus: (id) => api.get(`/v1/server/${id}`),
  health: () => api.get('/health'),
};

export default api;
