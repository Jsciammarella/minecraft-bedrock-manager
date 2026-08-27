import { modLoaderIds } from './modCompatibility';

export const EMPTY_FILTER_AVAILABILITY = {
  javaHostingAvailable: false,
  editions: [],
  loaders: [],
  environments: [],
  catalogFilters: [],
};

export function parseFilterAvailability(data) {
  if (!data || typeof data !== 'object') return { ...EMPTY_FILTER_AVAILABILITY };
  return {
    javaHostingAvailable: Boolean(data.javaHostingAvailable),
    editions: Array.isArray(data.editions) ? data.editions : [],
    loaders: Array.isArray(data.loaders) ? data.loaders : [],
    environments: Array.isArray(data.environments) ? data.environments : [],
    catalogFilters: Array.isArray(data.catalogFilters) ? data.catalogFilters : [],
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

export function catalogFiltersParam(selected = {}) {
  const payload = {};
  for (const [id, values] of Object.entries(selected || {})) {
    const list = Array.isArray(values) ? values.map(String).filter(Boolean) : [];
    if (list.length) payload[id] = list;
  }
  return Object.keys(payload).length ? JSON.stringify(payload) : '';
}

export function reconcileCatalogFilterSelections(selected = {}, availability = EMPTY_FILTER_AVAILABILITY) {
  const listed = new Map((availability.catalogFilters || []).map((item) => [item.id, item]));
  const next = {};
  let changed = false;
  for (const [id, values] of Object.entries(selected || {})) {
    const filter = listed.get(id);
    if (!filter || !filter.available) {
      changed = true;
      continue;
    }
    const allowed = new Set(
      (filter.options || []).filter((item) => !item.disabled).map((item) => String(item.id))
    );
    const kept = (Array.isArray(values) ? values : []).map(String).filter((value) => allowed.has(value));
    if (kept.length !== (Array.isArray(values) ? values.length : 0)) changed = true;
    if (kept.length) next[id] = kept;
  }
  return { selected: next, changed };
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
