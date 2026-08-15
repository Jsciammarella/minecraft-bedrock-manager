import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import ServerDetail from './pages/ServerDetail';
import CreateServer from './pages/CreateServer';
import ServerProperties from './pages/ServerProperties';
import ModCatalog from './pages/ModCatalog';
import ModLibrary from './pages/ModLibrary';
import PlayerManagement from './pages/PlayerManagement';
import PortManager from './pages/PortManager';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="servers" element={<Dashboard />} />
        <Route path="servers/new" element={<CreateServer />} />
        <Route path="servers/:id" element={<ServerDetail />} />
        <Route path="servers/:id/properties" element={<ServerProperties />} />
        <Route path="mods" element={<ModLibrary />} />
        <Route path="mods/catalog" element={<ModCatalog />} />
        <Route path="players" element={<PlayerManagement />} />
        <Route path="ports" element={<PortManager />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default App;
