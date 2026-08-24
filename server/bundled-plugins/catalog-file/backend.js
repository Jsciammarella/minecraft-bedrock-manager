const fileCatalog = require('../../services/fileCatalogClient');
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
        id: 'file',
        name: 'File Catalog',
        source: 'file',
        editions: ['bedrock', 'java'],
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
        edition: item.edition || 'bedrock',
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
          loader: item.loader,
          artifactType: item.type || 'addon',
        })),
      };
    },
    async getDetails(projectId, options = {}) {
      const details = fileCatalog.getMod(options.slug || projectId, options.fileKind);
      return details
        ? mark(details, { providerId: 'file', source: 'file', edition: details.edition || 'bedrock', loader: details.loader })
        : null;
    },
    async listDownloadFiles(projectId, options = {}) {
      return fileCatalog.listDownloadFiles(options.slug || projectId, options.fileKind);
    },
    async download(projectId, fileSelection, options = {}) {
      return fileCatalog.downloadMod(
        options.slug || projectId,
        options.serverId,
        options.fileKind,
        fileSelection,
        { loader: options.loader }
      );
    },
  };
}

function syncSource(ctx, enabled) {
  if (enabled) ctx.registerCatalogSource(createProvider());
  else ctx.unregisterCatalogSource('file');
}

function register(ctx) {
  const files = ctx.services.fileCatalog;
  const config = files.publicConfig();
  syncSource(ctx, config.enabled);

  ctx.registerPluginSettings({
    schema,
    getState() {
      const next = files.publicConfig();
      return {
        values: {
          enabled: next.enabled,
          localEnabled: next.local.enabled,
          localPath: next.local.path,
          smbEnabled: next.smb.enabled,
          smbPath: next.smb.path,
          smbUsername: next.smb.username,
          nfsEnabled: next.nfs.enabled,
          nfsPath: next.nfs.path,
        },
        status: {
          modCount: next.modCount,
          defaultLocalPath: next.defaultLocalPath,
        },
      };
    },
    actions: {
      async save({ values, actor }) {
        const next = files.updateConfig({
          enabled: values.enabled,
          localEnabled: values.localEnabled,
          localPath: values.localPath,
          smbEnabled: values.smbEnabled,
          smbPath: values.smbPath,
          smbUsername: values.smbUsername,
          nfsEnabled: values.nfsEnabled,
          nfsPath: values.nfsPath,
        }, { actor });
        syncSource(ctx, next.enabled);
        return { message: 'Catalog settings saved' };
      },
      async 'test-local-path'({ values, actor }) {
        const result = await files.testPath('local', { path: values.localPath }, { actor });
        return { ok: true, message: `Local folder is reachable (${result.modCount || 0} mods)` };
      },
      async 'test-smb-path'({ values, actor }) {
        const result = await files.testPath('smb', {
          path: values.smbPath,
          username: values.smbUsername,
        }, { actor });
        return { ok: true, message: `SMB is reachable (${result.modCount || 0} mods)` };
      },
      async 'test-nfs-path'({ values, actor }) {
        const result = await files.testPath('nfs', { path: values.nfsPath }, { actor });
        return { ok: true, message: `NFS is reachable (${result.modCount || 0} mods)` };
      },
      async 'download-template'() {
        const zip = files.starterZip();
        return { download: true, filename: zip.filename, buffer: zip.buffer };
      },
    },
  });
}

module.exports = { createProvider, register };
