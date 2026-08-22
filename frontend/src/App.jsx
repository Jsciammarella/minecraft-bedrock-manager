import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import ServerDetail from './pages/ServerDetail';
import CreateServer from './pages/CreateServer';
import ServerProperties from './pages/ServerProperties';
import ServerUsers from './pages/ServerUsers';
import ModCatalog from './pages/ModCatalog';
import ModCatalogSettings from './pages/ModCatalogSettings';
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

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-mc-dark">
        <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

function RequireUserManagement() {
  const { canAccessUserManagement, canViewUsers, canViewGroups, canViewPermissions } = useAuth();
  const location = useLocation();
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
          <Route path="servers/:id/users" element={<ServerUsers />} />
          <Route path="servers/:id/properties" element={<ServerProperties />} />
          <Route path="mods" element={<ModLibrary />} />
          <Route path="mods/catalog" element={<ModCatalog />} />
          <Route path="mods/catalog/settings" element={<ModCatalogSettings />} />
          <Route path="players" element={<PlayerManagement />} />
          <Route path="bedrock-connect" element={<BedrockConnectPage />} />
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
