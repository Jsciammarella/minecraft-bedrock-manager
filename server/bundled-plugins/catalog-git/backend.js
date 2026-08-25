const gitCatalog = require('../../services/gitCatalogClient');
const schema = require('./settings');

function mark(item, extra) {
  return {
    ...item,
    ...extra,
    providerId: extra.providerId,
    source: extra.source || item.source,
    edition: extra.edition || item.edition || 'bedrock',
    loader: extra.loader || item.loader,
  };
}

function createProvider() {
  return {
    getMetadata() {
      return {
        id: 'git',
        name: 'Git Repository',
        source: 'git',
        editions: ['bedrock', 'java'],
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
        edition: item.edition || 'bedrock',
      }));
    },
    async search(query, options = {}) {
      const result = await gitCatalog.searchMods(query, options);
      return {
        ...result,
        results: (result.results || []).map((item) => mark(item, {
          providerId: 'git',
          source: 'git',
          edition: item.edition || 'bedrock',
          loader: item.loader,
          artifactType: item.type || 'addon',
        })),
      };
    },
    async getDetails(projectId, options = {}) {
      const details = gitCatalog.getMod(options.slug || projectId);
      return details
        ? mark(details, { providerId: 'git', source: 'git', edition: details.edition || 'bedrock', loader: details.loader })
        : null;
    },
    async listDownloadFiles(projectId, options = {}) {
      return gitCatalog.listDownloadFiles(options.slug || projectId);
    },
    async download(projectId, fileSelection, options = {}) {
      return gitCatalog.downloadMod(options.slug || projectId, options.serverId, fileSelection, { loader: options.loader });
    },
  };
}

function syncSource(ctx, enabled) {
  if (enabled) ctx.registerCatalogSource(createProvider());
  else ctx.unregisterCatalogSource('git');
}

function register(ctx) {
  const git = ctx.services.gitCatalog;
  const config = git.publicConfig();
  syncSource(ctx, config.enabled);

  ctx.registerPluginSettings({
    schema,
    getState() {
      const next = git.publicConfig();
      const sync = git.syncStatus();
      return {
        values: {
          enabled: next.enabled,
          url: next.url,
          branch: next.branch,
          subdir: next.subdir,
          username: next.username,
        },
        status: {
          sync,
          lastSync: next.lastSync,
          modCount: sync.modCount || 0,
        },
      };
    },
    actions: {
      async save({ values, actor }) {
        const previous = git.publicConfig();
        const next = git.updateConfig({
          enabled: values.enabled,
          url: values.url,
          branch: values.branch,
          username: values.username,
          subdir: values.subdir,
        }, { actor });
        syncSource(ctx, next.enabled);
        const changed = previous.enabled !== next.enabled
          || previous.url !== next.url
          || previous.branch !== next.branch
          || previous.username !== next.username
          || previous.subdir !== next.subdir;
        if (changed && git.syncStatus().canSync) {
          git.startSync('settings-save', { actor });
          return { message: 'Catalog settings saved. Git catalog is syncing in the background.' };
        }
        return { message: 'Catalog settings saved' };
      },
      async 'test-connection'({ values, actor }) {
        const result = await git.testConnection({
          url: values.url,
          branch: values.branch,
          username: values.username,
        }, { actor });
        return { ok: true, message: 'Git repository is reachable', ...result };
      },
      async 'sync-now'({ actor }) {
        const status = git.startSync('manual', { actor });
        return { message: status.running ? 'Git catalog is syncing' : 'Git catalog sync started', ...status };
      },
      async 'download-template'() {
        const zip = git.starterZip();
        return { download: true, filename: zip.filename, buffer: zip.buffer };
      },
    },
  });
}

module.exports = { createProvider, register };
