const FILTER_ID = 'java-installed-servers';

function createProvider(host) {
  return {
    getMetadata() {
      return {
        id: FILTER_ID,
        label: 'Compatible with Servers',
        type: 'multi-select',
        editions: ['java'],
        emptyLabel: 'All Java Servers',
        unavailableNotice: 'This filter is unavailable until Minecraft Java Hosting is enabled.',
      };
    },
    isAvailable() {
      return Boolean(host?.isJavaHostingAvailable?.());
    },
    listOptions(context = {}) {
      if (!this.isAvailable()) return [];
      return host.listOptions(context.principal) || [];
    },
    resolveSelection(values, context = {}) {
      if (!this.isAvailable()) {
        const err = new Error('That catalog filter is not available.');
        err.status = 409;
        err.code = 'CATALOG_FILTER_UNAVAILABLE';
        throw err;
      }
      return host.resolveIds(values, context.principal);
    },
  };
}

function register(ctx) {
  const host = ctx.services?.javaServers;
  if (!host) {
    ctx.logger.warn('Java Server Compatibility Filter is missing the javaServers host API');
    return;
  }
  ctx.registerCatalogFilter(createProvider(host));
}

module.exports = { register };
