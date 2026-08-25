import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = String(error.config?.url || '');
    if (error.response?.status === 401 && !url.includes('/auth/login') && !url.includes('/auth/me') && !url.includes('/auth/password-policy') && !url.includes('/auth/security') && !url.includes('/system')) {
      window.dispatchEvent(new Event('mbm-auth-expired'));
    }
    return Promise.reject(error);
  }
);

// ========== SERVERS ==========

export const serverApi = {
  getAll: () => api.get('/servers'),
  getById: (id) => api.get(`/servers/${id}`),
  create: (data) => api.post('/servers', data, { timeout: 60000 }),
  update: (id, data) => api.put(`/servers/${id}`, data),
  delete: (id, opts = {}) => api.delete(`/servers/${id}`, { params: opts }),
  start: (id) => api.post(`/servers/${id}/start`, undefined, { timeout: 10 * 60 * 1000 }),
  stop: (id) => api.post(`/servers/${id}/stop`),
  restart: (id) => api.post(`/servers/${id}/restart`, undefined, { timeout: 10 * 60 * 1000 }),
  restartWithWarning: (id) => api.post(`/servers/${id}/restart-with-warning`),
  cancelWarnedRestart: (id) => api.delete(`/servers/${id}/restart-with-warning`),
  command: (id, cmd) => api.post(`/servers/${id}/command`, { command: cmd }),
  updateVersion: (id, version) => api.post(`/servers/${id}/update`, { version }, { timeout: 120000 }),
  checkUpdates: () => api.get('/servers/check-updates'),
  javaVersions: () => api.get('/servers/java/versions'),
  editions: () => api.get('/editions'),
  javaProviders: () => api.get('/java/providers'),
  javaProviderVersions: (providerId) => api.get(`/java/providers/${encodeURIComponent(providerId)}/versions`),
  javaLoaderVersions: (providerId, minecraftVersion) => api.get(`/java/providers/${encodeURIComponent(providerId)}/loader-versions`, { params: { minecraftVersion } }),
  javaValidate: (providerId, data) => api.post(`/java/providers/${encodeURIComponent(providerId)}/validate`, data),
  javaMods: (id) => api.get(`/servers/${id}/java/mods`),
  installJavaMod: (id, modId) => api.post(`/servers/${id}/java/mods`, { modId }),
  removeJavaMod: (id, installationId) => api.delete(`/servers/${id}/java/mods/${installationId}`),
  pendingJavaMods: (id) => api.get(`/servers/${id}/java/mods/pending`),
  resolveJavaDependencies: (id, ids, overrides) => api.post(`/servers/${id}/java/dependencies/resolve`, { ids, overrides }, { timeout: 10 * 60 * 1000 }),
  reevaluateJavaDependencies: (id) => api.post(`/servers/${id}/java/dependencies/reevaluate`, undefined, { timeout: 10 * 60 * 1000 }),
  runPluginActionForServer: (id, data) => api.post(`/servers/${id}/plugin-actions`, data, { timeout: 10 * 60 * 1000 }),
  runPluginAction: (data) => api.post('/plugin-actions', data, { timeout: 10 * 60 * 1000 }),
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
    if (metadata) {
      Object.entries(metadata).forEach(([k, v]) => {
        if (v == null || v === '') return;
        formData.append(k, typeof v === 'object' ? JSON.stringify(v) : v);
      });
    }
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
  addFiles: (id, files, metadata, onProgress) => {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
    const formData = new FormData();
    list.forEach((file) => formData.append('files', file));
    if (metadata) {
      Object.entries(metadata).forEach(([k, v]) => {
        if (v == null || v === '') return;
        formData.append(k, typeof v === 'object' ? JSON.stringify(v) : v);
      });
    }
    return api.post(`/mods/${id}/files`, formData, {
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
  deleteFile: (id, { sha256, name, uninstallFromAll } = {}) => api.delete(`/mods/${id}/files`, {
    params: {
      sha256: sha256 || undefined,
      name: name || undefined,
      uninstallFromAll: uninstallFromAll ? '1' : undefined,
    },
    data: { sha256, name, uninstallFromServers: Boolean(uninstallFromAll) },
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
  catalogFilterAvailability: () => api.get('/mods/catalog/filter-availability'),
  catalogCategories: (params) => api.get('/mods/catalog/categories', { params }),
  catalogDownload: (mod, serverId, files, extra = {}) => api.post(`/mods/catalog/download/${encodeURIComponent(mod.slug)}`, {
    source: mod.source || 'curseforge',
    provider: mod.providerId,
    edition: mod.edition,
    projectClass: mod.projectClass,
    curseforgeId: mod.curseforgeId,
    modrinthId: mod.modrinthId || extra.modrinthId,
    fileId: mod.fileId,
    fileKind: mod.fileKind,
    serverId,
    files,
    loader: extra.loader,
    gameVersions: extra.gameVersions,
  }, { timeout: 10 * 60 * 1000 }),
  setCatalogMultiFileMode: (mode) => api.put('/mods/catalog/multi-file-mode', { mode }),
  catalogDetails: (slug, projectClass, source) => api.get(`/mods/catalog/${encodeURIComponent(slug)}`, {
    params: { projectClass, source },
  }),
  catalogMultiFileMode: () => api.get('/mods/catalog/multi-file-mode'),
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

export const dashboardApi = {
  list: () => api.get('/dashboard'),
  gateways: () => api.get('/dashboard/gateways'),
  gateway: (id) => api.get(`/dashboard/gateways/${encodeURIComponent(id)}`),
};

export const pluginApi = {
  list: () => api.get('/plugins'),
  meta: (id) => api.get(`/plugins/${encodeURIComponent(id)}/meta`),
  setEnabled: (id, enabled, extra = {}) => api.put(
    `/plugins/${encodeURIComponent(id)}/enabled`,
    { enabled, ...extra },
    enabled === false ? { timeout: 10 * 60 * 1000 } : undefined,
  ),
  disableImpact: (id) => api.get(`/plugins/${encodeURIComponent(id)}/disable-impact`),
  setBackendEnabled: (id, enabled) => api.put(`/plugins/${encodeURIComponent(id)}/backend-enabled`, { enabled }),
  upload: (formData) => api.post('/plugins/upload', formData, { timeout: 120000 }),
  settings: (id) => api.get(`/plugins/${encodeURIComponent(id)}/settings`),
  settingsAction: (id, actionId, data) => api.post(
    `/plugins/${encodeURIComponent(id)}/settings/actions/${encodeURIComponent(actionId)}`,
    data,
    { timeout: 120000 },
  ),
};

export const publicApi = {
  overview: () => api.get('/v1/overview'),
  serverStatus: (id) => api.get(`/v1/server/${id}`),
  health: () => api.get('/health'),
};

export const authApi = {
  login: (username, password) => api.post('/auth/login', { username, password }),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  security: () => api.get('/auth/security'),
  changePassword: (data) => api.put('/auth/password', data),
  passwordPolicy: () => api.get('/auth/password-policy'),
};

export const userManagementApi = {
  users: () => api.get('/user-management/users'),
  getUser: (id) => api.get(`/user-management/users/${id}`),
  createUser: (data) => api.post('/user-management/users', data),
  updateUser: (id, data) => api.put(`/user-management/users/${id}`, data),
  deleteUser: (id) => api.delete(`/user-management/users/${id}`),
  groups: () => api.get('/user-management/groups'),
  getGroup: (id) => api.get(`/user-management/groups/${id}`),
  createGroup: (data) => api.post('/user-management/groups', data),
  updateGroup: (id, data) => api.put(`/user-management/groups/${id}`, data),
  deleteGroup: (id) => api.delete(`/user-management/groups/${id}`),
  permissions: () => api.get('/user-management/permissions'),
  updatePermission: (key, data) => api.put(`/user-management/permissions/${encodeURIComponent(key)}`, data),
  catalog: () => api.get('/user-management/catalog'),
  settings: () => api.get('/user-management/settings'),
  saveSettings: (data) => api.put('/user-management/settings', data),
};

export default api;
