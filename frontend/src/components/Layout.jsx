import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { 
  Server, Plus, Package, Users, Network, Globe,
  ChevronLeft, ChevronRight, Home, Download, Menu, X
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useApi } from '../context/ApiContext';
import { useSocket } from '../context/SocketContext';
import { pluginApi, publicApi } from '../services/api';
import { pluginIcon } from '../pluginIcons';

function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [hostName, setHostName] = useState('');
  const [managerVersion, setManagerVersion] = useState('');
  const [pluginMenus, setPluginMenus] = useState([]);
  const { servers, loading } = useApi();
  const { connected } = useSocket();

  useEffect(() => {
    publicApi.health()
      .then((res) => {
        setHostName(String(res.data?.hostname || '').trim());
        setManagerVersion(String(res.data?.version || '').trim().replace(/^v\.?\s*/i, ''));
      })
      .catch(() => {
        setHostName('');
        setManagerVersion('');
      });
    pluginApi.list()
      .then((res) => setPluginMenus(res.data?.menus || []))
      .catch(() => setPluginMenus([]));
    const refreshPluginMenus = () => {
      pluginApi.list()
        .then((res) => setPluginMenus(res.data?.menus || []))
        .catch(() => setPluginMenus([]));
    };
    window.addEventListener('mbm-plugins-changed', refreshPluginMenus);
    return () => window.removeEventListener('mbm-plugins-changed', refreshPluginMenus);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [mobileOpen]);

  const navItems = [
    { icon: Home, label: 'Dashboard', path: '/', exact: true },
    { icon: Server, label: 'Servers', path: '/servers' },
    { icon: Plus, label: 'New Server', path: '/servers/new' },
    { icon: Package, label: 'Mod Library', path: '/mods' },
    { icon: Download, label: 'Mod Catalog', path: '/mods/catalog' },
    { icon: Users, label: 'Players', path: '/players' },
    { icon: Globe, label: 'BedrockConnect', path: '/bedrock-connect' },
    { icon: Network, label: 'Ports', path: '/ports' },
  ];

  const activeServers = servers.filter(s => s.status === 'running').length;
  const isCoreNavActive = (item) => (
    item.exact
      ? location.pathname === item.path
      : item.path === '/mods'
        ? location.pathname === '/mods' || (location.pathname.startsWith('/mods/') && !location.pathname.startsWith('/mods/catalog'))
        : location.pathname === item.path || location.pathname.startsWith(`${item.path}/`)
  );
  const currentPlugin = pluginMenus.find((item) => (
    location.pathname === item.path || location.pathname.startsWith(`${item.path}/`)
  ));
  const currentPage = navItems.find((item) => isCoreNavActive(item));
  const pageTitle = currentPlugin?.label
    || currentPage?.label
    || (location.pathname === '/plugins' ? 'Plugins' : null)
    || (location.pathname.startsWith('/servers/') ? 'Server' : 'MC Manager');
  const isPluginPage = location.pathname.startsWith('/plugins/') && location.pathname !== '/plugins';

  const goTo = (path) => {
    navigate(path);
    setMobileOpen(false);
  };

  const navButtonClass = (isActive) => `w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium
              transition-all duration-200 max-md:min-h-11 ${
                isActive
                  ? 'bg-mc-accent/10 text-mc-accent'
                  : 'text-mc-textMuted hover:text-mc-text hover:bg-mc-surfaceLight'
              }`;

  const renderNav = (showLabels) => (
    <nav className="flex-1 min-h-0 p-3 space-y-1 overflow-y-auto overscroll-contain">
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = isCoreNavActive(item);

        return (
          <button
            key={item.path}
            onClick={() => goTo(item.path)}
            className={navButtonClass(isActive)}
            title={!showLabels ? item.label : undefined}
          >
            <Icon className="w-5 h-5 flex-shrink-0" />
            {showLabels && <span>{item.label}</span>}
          </button>
        );
      })}
      {pluginMenus.length > 0 && (
        <div className="pt-2 mt-2 border-t border-mc-surfaceLight space-y-1">
          {showLabels && (
            <p className="px-3 pb-1 text-[10px] uppercase tracking-wide text-mc-textMuted">Plugins</p>
          )}
          {pluginMenus.map((item) => {
            const Icon = pluginIcon(item.icon);
            const isActive = location.pathname === item.path
              || location.pathname.startsWith(`${item.path}/`);
            return (
              <button
                key={`${item.pluginId}:${item.id}`}
                onClick={() => goTo(item.path)}
                className={navButtonClass(isActive)}
                title={!showLabels ? item.label : undefined}
              >
                <Icon className="w-5 h-5 flex-shrink-0" />
                {showLabels && <span className="truncate">{item.label}</span>}
              </button>
            );
          })}
        </div>
      )}
    </nav>
  );

  const sidebarInner = (showLabels, { closeable = false } = {}) => (
    <>
      <div className="p-4 border-b border-mc-surfaceLight flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-mc-accent rounded-lg flex items-center justify-center flex-shrink-0" title={hostName || 'MC Manager'}>
            <Server className="w-5 h-5 text-mc-darker" />
          </div>
          {showLabels && (
            <div className="overflow-hidden flex-1 min-w-0">
              <h1 className="text-sm font-bold text-white truncate">MC Manager</h1>
              <p className="text-xs text-mc-textMuted truncate" title={hostName || undefined}>
                {hostName || 'Bedrock Edition'}
              </p>
            </div>
          )}
          {closeable && (
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="ml-auto p-2 rounded-lg text-mc-textMuted hover:text-mc-text hover:bg-mc-surfaceLight"
              aria-label="Close menu"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        {showLabels && (
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-mc-textMuted truncate min-w-0" title={managerVersion ? `Manager version ${managerVersion}` : undefined}>
              {managerVersion ? `v. ${managerVersion}` : '\u00a0'}
            </p>
            <button
              type="button"
              onClick={() => goTo('/plugins')}
              className={`text-xs shrink-0 ${
                location.pathname === '/plugins'
                  ? 'text-mc-accent'
                  : 'text-mc-textMuted hover:text-mc-text'
              }`}
            >
              Plugins
            </button>
          </div>
        )}
        {!showLabels && (
          <button
            type="button"
            onClick={() => goTo('/plugins')}
            className={`mt-2 w-full text-xs ${
              location.pathname === '/plugins'
                ? 'text-mc-accent'
                : 'text-mc-textMuted hover:text-mc-text'
            }`}
            title="Plugins"
          >
            Plugins
          </button>
        )}
      </div>

      {renderNav(showLabels)}

      {showLabels && servers.length > 0 && (
        <div className="p-3 border-t border-mc-surfaceLight flex-shrink-0">
          <p className="text-xs text-mc-textMuted mb-2 px-1">Quick Access</p>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {servers.map(server => (
              <button
                key={server.id}
                onClick={() => goTo(`/servers/${server.id}`)}
                className="w-full flex items-center gap-2 px-2 py-1.5 max-md:py-2.5 rounded text-xs text-mc-textMuted 
                  hover:text-mc-text hover:bg-mc-surfaceLight transition-all"
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  server.status === 'running' ? 'bg-green-400' : 
                  server.status === 'starting' ? 'bg-yellow-400 animate-pulse' : 'bg-red-400'
                }`} />
                <span className="truncate">{server.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="p-3 border-t border-mc-surfaceLight space-y-2 flex-shrink-0">
        <div className="flex items-center gap-2 px-1">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
          {showLabels && <span className="text-xs text-mc-textMuted">{connected ? 'Connected' : 'Disconnected'}</span>}
        </div>

        {showLabels && (
          <div className="px-1 text-xs text-mc-textMuted">
            {activeServers}/{servers.length} servers active
          </div>
        )}

        <button
          onClick={() => setCollapsed(!collapsed)}
          className="hidden md:flex w-full items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs 
            text-mc-textMuted hover:text-mc-text hover:bg-mc-surfaceLight transition-all"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          {showLabels && <span>Collapse</span>}
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-screen max-md:h-[100dvh] max-md:flex-col overflow-hidden">
      <header className="md:hidden flex-shrink-0 flex items-center gap-3 px-3 py-2.5 bg-mc-darker border-b border-mc-surfaceLight pt-[max(0.625rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="p-2 -ml-1 rounded-lg text-mc-text hover:bg-mc-surfaceLight min-h-11 min-w-11 flex items-center justify-center"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-white truncate">{pageTitle}</p>
          <p className="text-[11px] text-mc-textMuted truncate">
            {activeServers}/{servers.length} servers active
          </p>
        </div>
        <span
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${connected ? 'bg-green-400' : 'bg-red-400'}`}
          title={connected ? 'Connected' : 'Disconnected'}
        />
      </header>

      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        {mobileOpen && (
          <button
            type="button"
            className="md:hidden absolute inset-0 z-40 bg-black/60"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
          />
        )}

        <aside
          className={`${collapsed ? 'md:w-16' : 'md:w-64'} w-72 max-md:max-w-[85vw] bg-mc-darker border-r border-mc-surfaceLight 
            flex flex-col transition-all duration-300 flex-shrink-0
            max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-2xl
            ${mobileOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'}`}
        >
          <div className="hidden md:flex md:flex-col md:h-full">
            {sidebarInner(!collapsed)}
          </div>
          <div className="flex flex-col h-full md:hidden">
            {sidebarInner(true, { closeable: true })}
          </div>
        </aside>

        <main className={`flex-1 min-w-0 min-h-0 bg-mc-dark pb-[env(safe-area-inset-bottom)] ${
          isPluginPage ? 'overflow-hidden' : 'overflow-y-auto overflow-x-hidden'
        }`}>
          {loading && servers.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-2 border-mc-accent border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-mc-textMuted">Loading...</p>
              </div>
            </div>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}

export default Layout;
