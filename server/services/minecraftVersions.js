function parseVersionList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parseVersionList(parsed);
    } catch {
      /* comma-separated */
    }
    return raw.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function versionTokens(value) {
  return String(value || '').split('.').filter(Boolean);
}

function listedSupportsServer(listed, serverVersion) {
  const a = String(listed || '').trim();
  const b = String(serverVersion || '').trim();
  if (!a || a.toLowerCase() === 'any' || a === '*') return true;
  if (a === b) return true;
  const ta = versionTokens(a);
  const tb = versionTokens(b);
  if (ta.length === 2 && tb.length >= 2 && ta[0] === tb[0] && ta[1] === tb[1]) return true;
  return false;
}

function supportsMinecraftVersion(versions, serverVersion) {
  const wanted = String(serverVersion || '').trim();
  if (!wanted) return true;
  const list = parseVersionList(versions);
  if (!list.length) return true;
  return list.some((item) => listedSupportsServer(item, wanted));
}

function serverMinecraftVersion(server) {
  return String(server?.minecraft_version || server?.minecraftVersion || server?.version || '').trim();
}

function modMinecraftVersions(mod) {
  return parseVersionList(mod?.minecraftVersions ?? mod?.minecraft_versions);
}

function parseRequestedGameVersions(raw) {
  const items = [];
  const list = Array.isArray(raw)
    ? raw
    : String(raw || '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const item of list) {
    if (item && typeof item === 'object' && item.version) {
      const edition = item.edition === 'java' || item.edition === 'bedrock' ? item.edition : '';
      items.push({ version: String(item.version).trim(), edition });
      continue;
    }
    const text = String(item || '');
    const [version, edition] = text.split(':');
    if (!version) continue;
    items.push({
      version: version.trim(),
      edition: edition === 'java' || edition === 'bedrock' ? edition : '',
    });
  }
  return items.filter((item) => item.version);
}

function providerGameVersions(editions, requested) {
  const list = Array.isArray(requested) ? requested : parseRequestedGameVersions(requested);
  if (!list.length) return [];
  const allowed = Array.isArray(editions) ? editions : [];
  return [...new Set(list
    .filter((item) => !item.edition || allowed.includes(item.edition))
    .map((item) => item.version)
    .filter(Boolean))];
}

function matchesCatalogGameVersions(mod, minecraftVersions, requested = []) {
  const listed = modMinecraftVersions(mod);
  const edition = String(mod?.edition || '').toLowerCase();
  const selected = Array.isArray(requested) && requested.length
    ? requested
    : (Array.isArray(minecraftVersions) ? minecraftVersions.filter(Boolean).map((version) => ({ version })) : []);
  if (!selected.length) return true;
  const wanted = selected
    .filter((item) => {
      const version = typeof item === 'string' ? item : item?.version;
      const itemEdition = typeof item === 'string' ? '' : item?.edition;
      return version && (!itemEdition || !edition || itemEdition === edition);
    })
    .map((item) => (typeof item === 'string' ? item : item.version));
  if (!wanted.length) return false;
  if (!listed.length) return true;
  return wanted.some((version) => supportsMinecraftVersion(listed, version));
}

module.exports = {
  listedSupportsServer,
  matchesCatalogGameVersions,
  modMinecraftVersions,
  parseRequestedGameVersions,
  parseVersionList,
  providerGameVersions,
  serverMinecraftVersion,
  supportsMinecraftVersion,
};
