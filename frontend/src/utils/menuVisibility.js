export function splitPermissionCatalog(catalog = {}) {
  const permissions = catalog.permissions || [];
  const categories = catalog.categories || [];
  return {
    actions: {
      categories: categories.filter((item) => item.id !== 'menu'),
      permissions: permissions.filter((item) => item.category !== 'menu'),
    },
    menu: {
      categories: categories.filter((item) => item.id === 'menu'),
      permissions: permissions.filter((item) => item.category === 'menu'),
    },
  };
}

export function pluginMenuKey(pluginId, menuId) {
  return `menu.view.plugin.${pluginId}.${menuId}`;
}

export function requiredMenuKey(pathname, pluginMenus = []) {
  if (pathname === '/users/settings') return null;
  if (pathname === '/') return 'menu.view.dashboard';
  if (pathname === '/servers/new') return 'menu.view.servers_new';
  if (pathname === '/servers') return 'menu.view.servers';
  if (pathname.startsWith('/servers/')) return null;
  if (pathname.startsWith('/mods/catalog')) return 'menu.view.catalog';
  if (pathname === '/mods' || pathname.startsWith('/mods/')) return 'menu.view.library';
  if (pathname.startsWith('/players')) return 'menu.view.players';
  if (pathname.startsWith('/bedrock-connect')) return 'menu.view.bedrock_connect';
  if (pathname.startsWith('/ports')) return 'menu.view.ports';
  if (pathname === '/plugins') return 'menu.view.plugins';
  if (pathname.startsWith('/plugins/')) {
    const match = pluginMenus.find((item) => (
      pathname === item.path || pathname.startsWith(`${item.path}/`)
    ));
    if (match) return pluginMenuKey(match.pluginId, match.id);
    return 'menu.view.plugins';
  }
  if (pathname.startsWith('/users')) return 'menu.view.users';
  return null;
}
