const javaHostingPolicy = require('./javaHostingPolicy');
const javaLoaderRegistry = require('./javaLoaderRegistry');
const catalogProviderRegistry = require('./catalogProviderRegistry');

const JAVA_HOSTING_DISABLED = 'JAVA_HOSTING_DISABLED';
const CATALOG_LOADER_UNAVAILABLE = 'CATALOG_LOADER_UNAVAILABLE';

function catalogHasBedrockSource() {
  return catalogProviderRegistry.list().some((provider) => (provider.editions || []).includes('bedrock'));
}

function listModCapableLoaders() {
  return javaLoaderRegistry.list()
    .filter((item) => item.id !== 'vanilla' && item.supportsMods !== false)
    .map((item) => ({
      id: item.id,
      name: item.name || item.id,
      type: 'loader',
    }));
}

function listFilterAvailability() {
  const javaHostingAvailable = javaHostingPolicy.isJavaHostingAvailable();
  const editions = [];
  if (catalogHasBedrockSource()) {
    editions.push({ id: 'bedrock', name: 'Bedrock', type: 'edition' });
  }
  if (javaHostingAvailable) {
    editions.push({ id: 'java', name: 'Java', type: 'edition' });
  }
  return {
    javaHostingAvailable,
    editions,
    loaders: javaHostingAvailable ? listModCapableLoaders() : [],
    environments: javaHostingAvailable
      ? [
        { id: 'server', name: 'Server-side', type: 'environment' },
        { id: 'client', name: 'Client-side', type: 'environment' },
      ]
      : [],
  };
}

function isJavaEnvironmentFilter(value) {
  const env = String(value || '').trim().toLowerCase();
  return Boolean(env) && env !== 'all';
}

function assertSearchFilters({ edition = 'all', loader = '', environment = '' } = {}) {
  const availability = listFilterAvailability();
  const nextEdition = String(edition || 'all').toLowerCase();
  const nextLoader = String(loader || '').trim().toLowerCase();
  const nextEnvironment = String(environment || '').trim().toLowerCase();
  const wantsJava = nextEdition === 'java' || Boolean(nextLoader) || isJavaEnvironmentFilter(nextEnvironment);

  if (wantsJava && !availability.javaHostingAvailable) {
    const err = new Error('Java catalog filters require the Minecraft Java Hosting plug-in.');
    err.status = 409;
    err.code = JAVA_HOSTING_DISABLED;
    throw err;
  }

  if (nextLoader) {
    const allowed = availability.loaders.some((item) => item.id === nextLoader);
    if (!allowed) {
      const err = new Error('The requested Java loader is not currently enabled.');
      err.status = 409;
      err.code = CATALOG_LOADER_UNAVAILABLE;
      err.loaderId = nextLoader;
      throw err;
    }
  }

  return {
    availability,
    edition: nextEdition,
    loader: nextLoader,
    environment: nextEnvironment === 'all' ? '' : nextEnvironment,
  };
}

module.exports = {
  JAVA_HOSTING_DISABLED,
  CATALOG_LOADER_UNAVAILABLE,
  listFilterAvailability,
  listModCapableLoaders,
  assertSearchFilters,
};
