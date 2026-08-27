import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import ServerDetail from './pages/ServerDetail';
import CreateServer from './pages/CreateServer';
import ServerProperties from './pages/ServerProperties';
import ServerUsers from './pages/ServerUsers';
import ServerAccess from './pages/ServerAccess';
import ServerAccessGroup from './pages/ServerAccessGroup';
import ServerAccessUser from './pages/ServerAccessUser';
import ModCatalog from './pages/ModCatalog';
import ModLibrary from './pages/ModLibrary';
import PlayerManagement from './pages/PlayerManagement';
import PortManager from './pages/PortManager';
import BedrockConnectPage from './pages/BedrockConnect';
import Plugins from './pages/Plugins';
import PluginPage from './pages/PluginPage';
import Login from './pages/Login';
import UserManagement from './pages/UserManagement';
import UsersList from './pages/UsersList';
import UserDetail from './pages/UserDetail';
import GroupsList from './pages/GroupsList';
import GroupDetail from './pages/GroupDetail';
import PermissionsPage from './pages/PermissionsPage';
import AccountSettings from './pages/AccountSettings';
import { useAuth } from './context/AuthContext';
import { serverAccessApi } from './services/api';

function RequireAuth() {
  const { user, loading, authenticationRequired, securityError } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-mc-dark">
        <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
      </div>
    );
  }
  if (securityError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-mc-dark p-6">
        <div className="card max-w-md text-center space-y-3">
          <h1 className="text-xl font-bold text-white">Unable to load security configuration</h1>
          <p className="text-sm text-mc-textMuted">{securityError}</p>
          <p className="text-sm text-mc-textMuted">The manager will not assume an open, unauthenticated mode after a security error.</p>
        </div>
      </div>
    );
  }
  if (authenticationRequired && !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-mc-dark">
        <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
      </div>
    );
  }
  return <Outlet />;
}

function RequireUserManagement() {
  const {
    canAccessUserManagement,
    canViewUsers,
    canViewGroups,
    canViewPermissions,
    features,
  } = useAuth();
  const location = useLocation();
  if (!features.userManagement && !features.passwordManagement) {
    return <Navigate to="/" replace />;
  }
  if (location.pathname === '/users/settings') return <Outlet />;
  if (!canAccessUserManagement) return <Navigate to="/users/settings" replace />;
  if (location.pathname === '/users' && !canViewUsers) {
    const fallback = canViewGroups
      ? '/users/groups'
      : canViewPermissions
        ? '/users/permissions'
        : '/users/settings';
    return <Navigate to={fallback} replace />;
  }
  return <Outlet />;
}

function RequireServerAccess() {
  const { id } = useParams();
  const [state, setState] = useState('loading');
  useEffect(() => {
    let cancelled = false;
    serverAccessApi.availability()
      .then((res) => {
        if (!cancelled) setState(res.data?.available ? 'ok' : 'no');
      })
      .catch(() => {
        if (!cancelled) setState('no');
      });
    return () => { cancelled = true; };
  }, []);
  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
      </div>
    );
  }
  if (state === 'no') return <Navigate to={id ? `/servers/${id}` : '/'} replace />;
  return <Outlet />;
}

import Gateways from './pages/Gateways';


function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="servers" element={<Dashboard />} />
          <Route path="servers/new" element={<CreateServer />} />
          <Route path="servers/:id" element={<ServerDetail />} />
          <Route path="servers/:id/player-roles" element={<ServerUsers />} />
          <Route path="servers/:id/users" element={<RequireServerAccess />}>
            <Route index element={<ServerAccess />} />
            <Route path="groups/:groupId" element={<ServerAccessGroup />} />
            <Route path=":userId" element={<ServerAccessUser />} />
          </Route>
          <Route path="servers/:id/properties" element={<ServerProperties />} />
          <Route path="mods" element={<ModLibrary />} />
          <Route path="mods/catalog" element={<ModCatalog />} />
          <Route path="mods/catalog/settings" element={<Navigate to="/plugins" replace />} />
          <Route path="players" element={<PlayerManagement />} />
          <Route path="bedrock-connect" element={<BedrockConnectPage />} />
          <Route path="gateways" element={<Gateways />} />
          <Route path="ports" element={<PortManager />} />
          <Route path="plugins" element={<Plugins />} />
          <Route path="plugins/:pluginId" element={<PluginPage />} />
          <Route path="plugins/:pluginId/:pageId" element={<PluginPage />} />
          <Route path="users" element={<RequireUserManagement />}>
            <Route element={<UserManagement />}>
              <Route index element={<UsersList />} />
              <Route path="groups" element={<GroupsList />} />
              <Route path="groups/:id" element={<GroupDetail />} />
              <Route path="permissions" element={<PermissionsPage />} />
              <Route path="settings" element={<AccountSettings />} />
              <Route path=":id" element={<UserDetail />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>

      </Route>
    </Routes>
  );
}

export default App;
