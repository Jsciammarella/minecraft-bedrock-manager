const ALLOWED_EDITIONS = ['bedrock', 'java'];
const LOADER_ALIASES = { forge: 'neoforge' };
const ALLOWED_LOADERS = ['any', 'vanilla', 'fabric', 'neoforge', 'unknown'];

function normalizeEdition(value, fallback = 'bedrock') {
  const edition = String(value || '').trim().toLowerCase();
  if (ALLOWED_EDITIONS.includes(edition)) return edition;
  return fallback;
}

function normalizeLoader(value, edition = 'bedrock') {
  const raw = String(value || '').trim().toLowerCase();
  const mapped = LOADER_ALIASES[raw] || raw;
  if (ALLOWED_LOADERS.includes(mapped)) return mapped;
  if (edition === 'java') return 'unknown';
  return 'any';
}

function fromDeclared(item = {}) {
  const loaderHint = item.loader || item.launcher || item.loaderType || item.launcherType;
  const declaredEdition = normalizeEdition(item.edition, '');
  let loader = normalizeLoader(loaderHint, declaredEdition || 'bedrock');
  let edition = declaredEdition;
  if (!edition) {
    edition = ['fabric', 'neoforge', 'vanilla'].includes(loader) ? 'java' : 'bedrock';
  }
  if (edition === 'bedrock' && !loaderHint) loader = 'any';
  if (edition === 'java' && !loaderHint && loader === 'any') loader = 'unknown';
  return { edition, loader };
}

function isJavaMod(mod = {}) {
  const edition = normalizeEdition(mod.edition, '');
  const loader = String(mod.loader || '').trim().toLowerCase();
  return edition === 'java' || ['fabric', 'neoforge', 'forge', 'vanilla'].includes(loader);
}

module.exports = {
  ALLOWED_EDITIONS,
  ALLOWED_LOADERS,
  fromDeclared,
  isJavaMod,
  normalizeEdition,
  normalizeLoader,
};
