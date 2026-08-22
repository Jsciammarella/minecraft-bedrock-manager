import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Puzzle } from 'lucide-react';
import { pluginApi } from '../services/api';
import { pluginIcon } from '../pluginIcons';

function Plugins() {
  const navigate = useNavigate();
  const [plugins, setPlugins] = useState([]);
  const [installDir, setInstallDir] = useState('data/plugins');
  const [error, setError] = useState('');

  useEffect(() => {
    pluginApi.list()
      .then((res) => {
        setPlugins(res.data?.plugins || []);
        if (res.data?.installDir) setInstallDir(res.data.installDir);
      })
      .catch(() => setError('Could not load plugins.'));
  }, []);

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="page-header flex items-center gap-4 mb-8">
        <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">Plugins</h1>
          <p className="text-mc-textMuted mt-1">
            Plugins can add their own sidebar items and pages. They cannot change Dashboard, servers, catalog, library, players, BedrockConnect, or ports.
          </p>
        </div>
      </div>

      <div className="card mb-6">
        <h2 className="text-lg font-semibold text-white mb-2">Install a plugin</h2>
        <p className="text-sm text-mc-textMuted">
          Copy a plugin folder into <code className="text-mc-text">{installDir}</code> on this host, then restart the manager.
          A starter example lives in <code className="text-mc-text">examples/plugins/hello-world</code>.
        </p>
      </div>

      {error && (
        <div className="mb-4 text-sm text-mc-danger">{error}</div>
      )}

      {plugins.length === 0 ? (
        <div className="card text-mc-textMuted text-sm">
          No plugins are installed yet. Core menus stay exactly as they are until you add one.
        </div>
      ) : (
        <div className="space-y-3">
          {plugins.map((plugin) => {
            const Icon = pluginIcon(plugin.menus?.[0]?.icon);
            return (
              <div key={plugin.id} className="card flex items-start gap-4">
                <div className="w-10 h-10 rounded-lg bg-mc-accent/10 text-mc-accent flex items-center justify-center flex-shrink-0">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-white font-semibold">{plugin.name}</h3>
                    <span className="text-xs text-mc-textMuted">v{plugin.version}</span>
                    {!plugin.enabled && (
                      <span className="text-xs text-mc-warning">Disabled</span>
                    )}
                  </div>
                  {plugin.description && (
                    <p className="text-sm text-mc-textMuted mt-1">{plugin.description}</p>
                  )}
                  {plugin.enabled && plugin.menus?.map((menu) => (
                    <button
                      key={menu.id}
                      type="button"
                      onClick={() => navigate(menu.path)}
                      className="btn btn-secondary text-xs mt-3"
                    >
                      Open {menu.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!plugins.length && (
        <div className="mt-4 flex items-center gap-2 text-xs text-mc-textMuted">
          <Puzzle className="w-4 h-4" />
          See docs/plugins.md for the manifest format and isolation rules.
        </div>
      )}
    </div>
  );
}

export default Plugins;
