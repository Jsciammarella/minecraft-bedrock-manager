export function splitPermissionCatalog(catalog = {}) {
  const permissions = catalog.permissions || [];
  const categories = catalog.categories || [];
  return {
    actions: {
      categories: categories.filter((item) => item.id !== 'menu'),
      permissions: permissions.filter((item) => item.category !== 'menu' && item.primaryCategory !== 'menu'),
    },
    menu: {
      categories: categories.filter((item) => item.id === 'menu'),
      permissions: permissions.filter((item) => item.category === 'menu' || item.primaryCategory === 'menu'),
    },
  };
}

export function pluginMenuKey(pluginId, menuId) {
  return `menu.view.plugin.${pluginId}.${menuId}`;
}

export const CREATE_SERVER_PERMISSIONS = [
  'servers.create_bedrock',
  'servers.create_remote',
  'servers.create_java',
  'bedrock_connect.create',
];

export const USER_MANAGEMENT_NAV_PERMISSIONS = [
  'users.view',
  'groups.view',
  'permissions.view_catalog',
];

export function requiredMenuKey(pathname, pluginMenus = []) {
  if (pathname === '/users/settings') return null;
  const pluginMatch = (pluginMenus || []).find((item) => (
    pathname === item.path || pathname.startsWith(`${item.path}/`)
  ));
  if (pluginMatch) return pluginMatch.permissionKey || pluginMenuKey(pluginMatch.pluginId, pluginMatch.id);
  if (pathname === '/') return 'dashboard.view';
  if (pathname === '/servers/new') return null;
  if (pathname === '/servers') return 'servers.view';
  if (pathname.startsWith('/servers/')) return null;
  if (pathname.startsWith('/mods/catalog')) return 'catalog.view';
  if (pathname === '/mods' || pathname.startsWith('/mods/')) return 'library.view';
  if (pathname.startsWith('/players')) return 'players.view';
  if (pathname.startsWith('/ports')) return 'ports.view';
  if (pathname === '/plugins') return 'plugins.view';
  if (pathname.startsWith('/plugins/')) return null;
  if (pathname.startsWith('/users')) return null;
  if (pathname.startsWith('/bedrock-connect')) return 'bedrock_connect.view';
  return null;
}
