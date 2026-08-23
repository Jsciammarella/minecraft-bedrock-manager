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
  start: (id) => api.post(`/servers/${id}/start`, undefined, { timeout: 10 * 60 * 1000 }),
  stop: (id) => api.post(`/servers/${id}/stop`),
  restart: (id) => api.post(`/servers/${id}/restart`, undefined, { timeout: 10 * 60 * 1000 }),
  restartWithWarning: (id) => api.post(`/servers/${id}/restart-with-warning`),
  cancelWarnedRestart: (id) => api.delete(`/servers/${id}/restart-with-warning`),
  command: (id, cmd) => api.post(`/servers/${id}/command`, { command: cmd }),
  updateVersion: (id, version) => api.post(`/servers/${id}/update`, { version }, { timeout: 120000 }),
  checkUpdates: () => api.get('/servers/check-updates'),
  javaVersions: () => api.get('/servers/java/versions'),
  javaProviders: () => api.get('/java/providers'),
  javaProviderVersions: (providerId) => api.get(`/java/providers/${encodeURIComponent(providerId)}/versions`),
  javaLoaderVersions: (providerId, minecraftVersion) => api.get(`/java/providers/${encodeURIComponent(providerId)}/loader-versions`, { params: { minecraftVersion } }),
  javaValidate: (providerId, data) => api.post(`/java/providers/${encodeURIComponent(providerId)}/validate`, data),
  javaMods: (id) => api.get(`/servers/${id}/java/mods`),
  installJavaMod: (id, modId) => api.post(`/servers/${id}/java/mods`, { modId }),
  removeJavaMod: (id, installationId) => api.delete(`/servers/${id}/java/mods/${installationId}`),
  pendingJavaMods: (id) => api.get(`/servers/${id}/java/mods/pending`),
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
  upload: (files, metadata, onProgress) => {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
    const formData = new FormData();
    if (list.length === 1) {
      formData.append('file', list[0]);
    } else {
      list.forEach((file) => formData.append('files', file));
    }
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
  delete: (id, { uninstallFromAll } = {}) => api.delete(`/mods/${id}`, {
    params: uninstallFromAll ? { uninstallFromAll: '1' } : undefined,
    timeout: 10 * 60 * 1000,
  }),
  update: (id, { description, thumbnailFile, clearThumbnail, loader }) => {
    const formData = new FormData();
    if (description != null) formData.append('description', description);
    if (clearThumbnail) formData.append('clearThumbnail', '1');
    if (loader != null) formData.append('loader', loader);
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
  catalogProviders: () => api.get('/mods/catalog/providers'),
  catalogCategories: (params) => api.get('/mods/catalog/categories', { params }),
  catalogDownload: (mod, serverId, files, extra = {}) => api.post(`/mods/catalog/download/${encodeURIComponent(mod.slug)}`, {
    source: mod.source || 'curseforge',
    provider: mod.providerId,
    edition: mod.edition,
    projectClass: mod.projectClass,
    curseforgeId: mod.curseforgeId,
    fileId: mod.fileId,
    fileKind: mod.fileKind,
    serverId,
    files,
    loader: extra.loader,
  }, { timeout: 10 * 60 * 1000 }),
  setCatalogMultiFileMode: (mode) => api.put('/mods/catalog/multi-file-mode', { mode }),
  catalogDetails: (slug, projectClass, source) => api.get(`/mods/catalog/${encodeURIComponent(slug)}`, {
    params: { projectClass, source },
  }),
  catalogSettings: () => api.get('/mods/catalog/settings'),
  saveCatalogSettings: (data) => api.put('/mods/catalog/settings', data),
  testGitCatalog: (data) => api.post('/mods/catalog/git/test', data, { timeout: 45000 }),
  testFileCatalog: (data) => api.post('/mods/catalog/file/test', data, { timeout: 45000 }),
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

export const gatewayApi = {
  providers: () => api.get('/gateway-providers'),
  list: () => api.get('/gateways'),
  create: (data) => api.post('/gateways', data, { timeout: 10 * 60 * 1000 }),
  get: (id) => api.get(`/gateways/${id}`),
  update: (id, data) => api.patch(`/gateways/${id}`, data),
  remove: (id) => api.delete(`/gateways/${id}`),
  start: (id) => api.post(`/gateways/${id}/start`, undefined, { timeout: 10 * 60 * 1000 }),
  stop: (id) => api.post(`/gateways/${id}/stop`),
  restart: (id) => api.post(`/gateways/${id}/restart`, undefined, { timeout: 10 * 60 * 1000 }),
  logs: (id) => api.get(`/gateways/${id}/logs`),
};

export const pluginApi = {
  list: () => api.get('/plugins'),
  meta: (id) => api.get(`/plugins/${encodeURIComponent(id)}/meta`),
  setEnabled: (id, enabled) => api.put(`/plugins/${encodeURIComponent(id)}/enabled`, { enabled }),
  setBackendEnabled: (id, enabled) => api.put(`/plugins/${encodeURIComponent(id)}/backend-enabled`, { enabled }),
  upload: (formData) => api.post('/plugins/upload', formData, { timeout: 120000 }),
};

export const publicApi = {
  overview: () => api.get('/v1/overview'),
  serverStatus: (id) => api.get(`/v1/server/${id}`),
  health: () => api.get('/health'),
};

export default api;
