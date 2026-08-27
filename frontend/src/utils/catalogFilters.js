import { modLoaderIds } from './modCompatibility';

export const EMPTY_FILTER_AVAILABILITY = {
  javaHostingAvailable: false,
  editions: [],
  loaders: [],
  environments: [],
};

export function parseFilterAvailability(data) {
  if (!data || typeof data !== 'object') return { ...EMPTY_FILTER_AVAILABILITY };
  return {
    javaHostingAvailable: Boolean(data.javaHostingAvailable),
    editions: Array.isArray(data.editions) ? data.editions : [],
    loaders: Array.isArray(data.loaders) ? data.loaders : [],
    environments: Array.isArray(data.environments) ? data.environments : [],
  };
}

export function reconcileCatalogQuery(current = {}, availability = EMPTY_FILTER_AVAILABILITY) {
  const editionIds = new Set((availability.editions || []).map((item) => item.id));
  const loaderIds = new Set((availability.loaders || []).map((item) => item.id));
  let source = current.source || 'all';
  let edition = current.edition || 'all';
  let category = current.category || '';
  let loader = current.loader || '';
  let environment = current.environment || 'all';

  if (edition !== 'all' && !editionIds.has(edition)) edition = 'all';
  if (loader && !loaderIds.has(loader)) loader = '';
  if (!availability.javaHostingAvailable) {
    loader = '';
    environment = 'all';
    if (edition === 'java') edition = 'all';
  } else if (loader) {
    edition = 'java';
  }

  const changed = source !== (current.source || 'all')
    || edition !== (current.edition || 'all')
    || category !== (current.category || '')
    || loader !== (current.loader || '')
    || environment !== (current.environment || 'all');

  return {
    source,
    edition,
    category,
    loader,
    environment,
    changed,
  };
}

export function libraryFilterOptions(availability = EMPTY_FILTER_AVAILABILITY) {
  const options = [
    { id: 'all', name: 'All editions', type: 'all' },
    { id: 'bedrock', name: 'Bedrock', type: 'edition' },
  ];
  for (const item of availability.editions || []) {
    if (item.id !== 'bedrock' && item.catalogFilter !== false) options.push(item);
  }
  for (const item of availability.loaders || []) options.push(item);
  for (const item of availability.environments || []) options.push(item);
  return options;
}

export function libraryFilterAllowedIds(availability = EMPTY_FILTER_AVAILABILITY) {
  return new Set(libraryFilterOptions(availability).map((item) => item.id));
}

export function modMatchesLibraryFilter(mod, filterId, availability = EMPTY_FILTER_AVAILABILITY) {
  if (!filterId || filterId === 'all') return true;
  if (filterId === 'bedrock') return (mod.edition || 'bedrock') !== 'java';
  if (filterId === 'java') return mod.edition === 'java' || modLoaderIds(mod).length > 0;
  if (filterId === 'server') return mod.environment === 'server' || mod.environment === 'both';
  if (filterId === 'client') return mod.environment === 'client' || mod.environment === 'both';
  if ((availability.loaders || []).some((item) => item.id === filterId)) {
    return modLoaderIds(mod).includes(filterId);
  }
  return true;
}
