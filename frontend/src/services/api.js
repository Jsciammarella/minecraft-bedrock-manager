import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// ========== SERVERS ==========

export const serverApi = {
  getAll: () => api.get('/servers'),
  getById: (id) => api.get(`/servers/${id}`),
  create: (data) => api.post('/servers', data),
  update: (id, data) => api.put(`/servers/${id}`, data),
  delete: (id) => api.delete(`/servers/${id}`),
  start: (id) => api.post(`/servers/${id}/start`),
  stop: (id) => api.post(`/servers/${id}/stop`),
  restart: (id) => api.post(`/servers/${id}/restart`),
  restartWithWarning: (id) => api.post(`/servers/${id}/restart-with-warning`),
  cancelWarnedRestart: (id) => api.delete(`/servers/${id}/restart-with-warning`),
  command: (id, cmd) => api.post(`/servers/${id}/command`, { command: cmd }),
  updateVersion: (id, version) => api.post(`/servers/${id}/update`, { version }),
  checkUpdates: () => api.get('/servers/check-updates'),
  
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
  upload: (file, metadata) => {
    const formData = new FormData();
    formData.append('file', file);
    if (metadata) Object.entries(metadata).forEach(([k, v]) => formData.append(k, v));
    return api.post('/mods/upload', formData, {
      timeout: 10 * 60 * 1000,
    });
  },
  delete: (id) => api.delete(`/mods/${id}`),
  getAvailable: (serverId) => api.get(`/mods/available/${serverId}`),
  getInstalled: (serverId) => api.get(`/mods/installed/${serverId}`),
  install: (modId, serverId) => api.post(`/mods/${modId}/install/${serverId}`),
  uninstall: (modId, serverId) => api.delete(`/mods/${modId}/uninstall/${serverId}`),
  
  // CurseForge catalog
  catalogSearch: (params) => api.get('/mods/catalog/search', { params }),
  catalogCategories: () => api.get('/mods/catalog/categories'),
  catalogDownload: (mod, serverId) => api.post(`/mods/catalog/download/${mod.slug}`, {
    projectClass: mod.projectClass,
    curseforgeId: mod.curseforgeId,
    fileId: mod.fileId,
    serverId,
  }),
  catalogDetails: (slug, projectClass) => api.get(`/mods/catalog/${slug}`, { params: { projectClass } }),
};

// ========== PLAYERS ==========

export const playerApi = {
  getAll: () => api.get('/players'),
  getByServer: (serverId) => api.get(`/players/server/${serverId}`),
  scan: (serverId) => api.post(`/players/scan/${serverId}`),
  add: (data) => api.post('/players', data),
  whitelist: (id, serverId) => api.post(`/players/${id}/whitelist`, { serverId }),
  unwhitelist: (id, serverId) => api.post(`/players/${id}/unwhitelist`, { serverId }),
  updateServerAccess: (serverId, playerId, data) => api.put(`/players/server/${serverId}/${playerId}`, data),
  search: (q) => api.get('/players/search', { params: { q } }),
};

// ========== PORTS ==========

export const portApi = {
  getAll: () => api.get('/ports'),
  search: (q) => api.get('/ports/search', { params: { q } }),
  check: (port) => api.get(`/ports/check/${port}`),
};

// ========== PUBLIC API ==========

export const publicApi = {
  overview: () => api.get('/v1/overview'),
  serverStatus: (id) => api.get(`/v1/server/${id}`),
  health: () => api.get('/v1/health'),
};

export default api;
