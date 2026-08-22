const curseforge = require('./curseforgeClient');
const gitCatalog = require('./gitCatalogClient');
const fileCatalog = require('./fileCatalogClient');
const settingsStore = require('./settingsStore');
const catalogProviderRegistry = require('./catalogProviderRegistry');

const CORE_PLUGIN = {
  id: 'core-catalog',
  source: 'bundled',
  capabilities: ['provider:catalog-source'],
};

function mark(item, extra) {
  return {
    ...item,
    ...extra,
    providerId: extra.providerId,
    source: extra.source || item.source,
    edition: extra.edition || item.edition || 'bedrock',
  };
}

function curseforgeBedrockProvider() {
  return {
    getMetadata() {
      return {
        id: 'curseforge-bedrock',
        name: 'CurseForge Bedrock',
        source: 'curseforge',
        editions: ['bedrock'],
        credentialProfile: 'curseforge',
        homepage: 'https://www.curseforge.com/minecraft-bedrock',
      };
    },
    isAvailable() {
      return Boolean(settingsStore.getCurseForgeApiKey());
    },
    async getCategories() {
      const categories = await curseforge.getCategories();
      return categories.map((item) => ({
        ...item,
        providerId: 'curseforge-bedrock',
        edition: 'bedrock',
        source: 'curseforge',
      }));
    },
    async search(query, options = {}) {
      const result = await curseforge.searchMods(query, options);
      return {
        ...result,
        results: (result.results || []).map((item) => mark(item, {
          providerId: 'curseforge-bedrock',
          source: 'curseforge',
          edition: 'bedrock',
          artifactType: item.type || 'addon',
        })),
      };
    },
    async getDetails(projectId, options = {}) {
      const details = await curseforge.getModDetails(options.slug || projectId, options.projectClass);
      return details ? mark(details, {
        providerId: 'curseforge-bedrock',
        source: 'curseforge',
        edition: 'bedrock',
      }) : null;
    },
    async listDownloadFiles(projectId, options = {}) {
      const modId = options.curseforgeId || projectId || await curseforge.findModIdBySlug(options.slug, options.projectClass);
      if (!modId) return [];
      return curseforge.listDownloadableFiles(modId);
    },
    async download(projectId, fileSelection, options = {}) {
      return curseforge.downloadMod(
        options.slug || projectId,
        options.projectClass,
        options.serverId,
        { modId: options.curseforgeId || projectId, fileId: options.fileId },
        fileSelection
      );
    },
  };
}

function gitProvider() {
  return {
    getMetadata() {
      return {
        id: 'git',
        name: 'Git Repository',
        source: 'git',
        editions: ['bedrock'],
        homepage: '',
      };
    },
    isAvailable() {
      return gitCatalog.isConfigured();
    },
    async getCategories() {
      return gitCatalog.getDiscoveredCategories().map((item) => ({
        ...item,
        providerId: 'git',
        edition: 'bedrock',
      }));
    },
    async search(query, options = {}) {
      const result = await gitCatalog.searchMods(query, options);
      return {
        ...result,
        results: (result.results || []).map((item) => mark(item, {
          providerId: 'git',
          source: 'git',
          edition: 'bedrock',
          artifactType: item.type || 'addon',
        })),
      };
    },
    async getDetails(projectId, options = {}) {
      const details = gitCatalog.getMod(options.slug || projectId);
      return details ? mark(details, { providerId: 'git', source: 'git', edition: 'bedrock' }) : null;
    },
    async listDownloadFiles(projectId, options = {}) {
      return gitCatalog.listDownloadFiles(options.slug || projectId);
    },
    async download(projectId, fileSelection, options = {}) {
      return gitCatalog.downloadMod(options.slug || projectId, options.serverId, fileSelection);
    },
  };
}

function fileProvider() {
  return {
    getMetadata() {
      return {
        id: 'file',
        name: 'File Catalog',
        source: 'file',
        editions: ['bedrock'],
        homepage: '',
      };
    },
    isAvailable() {
      return fileCatalog.isConfigured();
    },
    async getCategories() {
      return fileCatalog.getDiscoveredCategories().map((item) => ({
        ...item,
        providerId: 'file',
        edition: 'bedrock',
      }));
    },
    async search(query, options = {}) {
      const result = await fileCatalog.searchMods(query, options);
      return {
        ...result,
        results: (result.results || []).map((item) => mark(item, {
          providerId: 'file',
          source: 'file',
          edition: item.edition || 'bedrock',
          artifactType: item.type || 'addon',
        })),
      };
    },
    async getDetails(projectId, options = {}) {
      const details = fileCatalog.getMod(options.slug || projectId, options.fileKind);
      return details ? mark(details, { providerId: 'file', source: 'file', edition: 'bedrock' }) : null;
    },
    async listDownloadFiles(projectId, options = {}) {
      return fileCatalog.listDownloadFiles(options.slug || projectId, options.fileKind);
    },
    async download(projectId, fileSelection, options = {}) {
      return fileCatalog.downloadMod(options.slug || projectId, options.serverId, options.fileKind, fileSelection);
    },
  };
}

function registerAll() {
  const factories = [
    curseforgeBedrockProvider,
    gitProvider,
    fileProvider,
  ];
  for (const factory of factories) {
    const provider = factory();
    const id = provider.getMetadata().id;
    if (!catalogProviderRegistry.get(id)) {
      catalogProviderRegistry.register(CORE_PLUGIN, provider, { core: true });
    }
  }
}

module.exports = {
  CORE_PLUGIN,
  registerAll,
};
