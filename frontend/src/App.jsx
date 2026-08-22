import { Routes, Route, Navigate } from 'react-router-dom';
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

function App() {
  return (
    <Routes>
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default App;
