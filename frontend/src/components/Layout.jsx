import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { 
  Server, Plus, Package, Users, Network, Globe,
  ChevronLeft, ChevronRight, Home, Download
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useApi } from '../context/ApiContext';
import { useSocket } from '../context/SocketContext';
import { publicApi } from '../services/api';

function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [hostName, setHostName] = useState('');
  const { servers, loading } = useApi();
  const { connected } = useSocket();

  useEffect(() => {
    publicApi.health()
      .then((res) => setHostName(String(res.data?.hostname || '').trim()))
      .catch(() => setHostName(''));
  }, []);

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

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside 
        className={`${collapsed ? 'w-16' : 'w-64'} bg-mc-darker border-r border-mc-surfaceLight 
          flex flex-col transition-all duration-300 flex-shrink-0`}
      >
        {/* Logo */}
        <div className="p-4 border-b border-mc-surfaceLight">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-mc-accent rounded-lg flex items-center justify-center flex-shrink-0" title={hostName || 'MC Manager'}>
              <Server className="w-5 h-5 text-mc-darker" />
            </div>
            {!collapsed && (
              <div className="overflow-hidden">
                <h1 className="text-sm font-bold text-white truncate">MC Manager</h1>
                <p className="text-xs text-mc-textMuted truncate" title={hostName || undefined}>
                  {hostName || 'Bedrock Edition'}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = item.exact
              ? location.pathname === item.path
              : item.path === '/mods'
                ? location.pathname === '/mods' || (location.pathname.startsWith('/mods/') && !location.pathname.startsWith('/mods/catalog'))
                : location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);
            
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium 
                  transition-all duration-200 ${
                    isActive 
                      ? 'bg-mc-accent/10 text-mc-accent' 
                      : 'text-mc-textMuted hover:text-mc-text hover:bg-mc-surfaceLight'
                  }`}
                title={collapsed ? item.label : undefined}
              >
                <Icon className="w-5 h-5 flex-shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        {/* Server Quick Links */}
        {!collapsed && servers.length > 0 && (
          <div className="p-3 border-t border-mc-surfaceLight">
            <p className="text-xs text-mc-textMuted mb-2 px-1">Quick Access</p>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {servers.map(server => (
                <button
                  key={server.id}
                  onClick={() => navigate(`/servers/${server.id}`)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-mc-textMuted 
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

        {/* Status & Toggle */}
        <div className="p-3 border-t border-mc-surfaceLight space-y-2">
          {/* Connection Status */}
          <div className="flex items-center gap-2 px-1">
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
            {!collapsed && <span className="text-xs text-mc-textMuted">{connected ? 'Connected' : 'Disconnected'}</span>}
          </div>
          
          {/* Active servers count */}
          {!collapsed && (
            <div className="px-1 text-xs text-mc-textMuted">
              {activeServers}/{servers.length} servers active
            </div>
          )}

          {/* Collapse Toggle */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs 
              text-mc-textMuted hover:text-mc-text hover:bg-mc-surfaceLight transition-all"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto bg-mc-dark">
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
  );
}

export default Layout;
