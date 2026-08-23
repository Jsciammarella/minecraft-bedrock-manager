const ALLOWED_CATALOG_EDITIONS = ['bedrock', 'java'];
const ALLOWED_SET = new Set(ALLOWED_CATALOG_EDITIONS);
const EDITION_LABELS = {
  bedrock: 'Bedrock',
  java: 'Java',
};

function validateProviderEditions(meta = {}) {
  const raw = Array.isArray(meta.editions)
    ? meta.editions
    : (meta.edition != null ? [meta.edition] : []);
  if (!raw.length) {
    throw new Error('Catalog provider must declare at least one edition');
  }
  const seen = new Set();
  const editions = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new Error('Catalog provider editions must be strings');
    }
    const value = item.trim().toLowerCase();
    if (!value) {
      throw new Error('Catalog provider editions must be strings');
    }
    if (value === 'all') {
      throw new Error('Catalog provider cannot declare edition "all"');
    }
    if (!ALLOWED_SET.has(value)) {
      throw new Error(`Catalog provider edition "${item}" is not allowed`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      editions.push(value);
    }
  }
  if (!editions.length) {
    throw new Error('Catalog provider must declare at least one edition');
  }
  return editions;
}

function availableEditionsFromProviders(providers = []) {
  const present = new Set();
  for (const provider of providers) {
    for (const edition of provider.editions || []) {
      if (ALLOWED_SET.has(edition)) present.add(edition);
    }
  }
  return ALLOWED_CATALOG_EDITIONS.filter((id) => present.has(id));
}

function sourceIdFromFilter(source) {
  if (source === 'curseforge') return 'curseforge-bedrock';
  return source;
}

function reconcileCatalogFilters({ providers = [], source = 'all', edition = 'all', category = '' } = {}) {
  const ids = new Set(providers.map((item) => item.id));
  const editions = availableEditionsFromProviders(providers);
  let nextSource = source || 'all';
  let nextEdition = edition || 'all';
  let nextCategory = category || '';
  const sourceId = nextSource === 'all' ? 'all' : sourceIdFromFilter(nextSource);
  if (nextSource !== 'all' && !ids.has(sourceId)) {
    nextSource = 'all';
    nextCategory = '';
  }
  if (nextEdition !== 'all' && !editions.includes(nextEdition)) {
    nextEdition = 'all';
    if (String(nextCategory).startsWith('curseforge-java:')) nextCategory = '';
  }
  if (nextSource !== 'curseforge-java' && String(nextCategory).startsWith('curseforge-java:')) {
    nextCategory = '';
  }
  const changed = nextSource !== (source || 'all')
    || nextEdition !== (edition || 'all')
    || nextCategory !== (category || '');
  return {
    source: nextSource,
    edition: nextEdition,
    category: nextCategory,
    page: changed ? 1 : undefined,
    editions,
    changed,
  };
}

module.exports = {
  ALLOWED_CATALOG_EDITIONS,
  EDITION_LABELS,
  availableEditionsFromProviders,
  reconcileCatalogFilters,
  sourceIdFromFilter,
  validateProviderEditions,
};
