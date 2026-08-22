import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronDown, FolderUp, Puzzle, Upload } from 'lucide-react';
import { pluginApi } from '../services/api';
import { pluginIcon } from '../pluginIcons';

function notifyPluginMenus() {
  window.dispatchEvent(new Event('mbm-plugins-changed'));
}

function Plugins() {
  const navigate = useNavigate();
  const zipInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const uploadMenuRef = useRef(null);
  const [plugins, setPlugins] = useState([]);
  const [installDir, setInstallDir] = useState('data/plugins');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const applyPayload = (data) => {
    setPlugins(data?.plugins || []);
    if (data?.installDir) setInstallDir(data.installDir);
    notifyPluginMenus();
  };

  const load = () => {
    pluginApi.list()
      .then((res) => applyPayload(res.data))
      .catch(() => setError('Could not load plugins.'));
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!uploadOpen) return undefined;
    const onPointer = (event) => {
      if (!uploadMenuRef.current?.contains(event.target)) setUploadOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [uploadOpen]);

  const togglePlugin = async (plugin) => {
    setError('');
    setMessage('');
    setBusyId(plugin.id);
    try {
      const res = await pluginApi.setEnabled(plugin.id, !plugin.enabled);
      applyPayload(res.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not update that plugin.');
    } finally {
      setBusyId('');
    }
  };

  const uploadForm = async (formData) => {
    setError('');
    setMessage('');
    setUploading(true);
    setUploadOpen(false);
    try {
      const res = await pluginApi.upload(formData);
      applyPayload(res.data);
      setMessage(`${res.data?.plugin?.name || 'Plugin'} installed.`);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not upload that plugin.');
    } finally {
      setUploading(false);
    }
  };

  const onZipChosen = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const formData = new FormData();
    formData.append('archive', file);
    uploadForm(formData);
  };

  const onFolderChosen = (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    const formData = new FormData();
    files.forEach((file) => {
      const rel = String(file.webkitRelativePath || file.name).replace(/\\/g, '/');
      formData.append('files', file, rel);
    });
    uploadForm(formData);
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="page-header flex items-center gap-4 mb-8">
        <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">Plugins</h1>
          <p className="text-mc-textMuted mt-1">
            Plugins can add their own features that can be accessed by the sidebar menu once installed.
          </p>
        </div>
      </div>

      <div className="card mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-white mb-2">Install a plugin</h2>
            <p className="text-sm text-mc-textMuted">
              Upload a plugin folder or a zip that contains that folder. You can also copy a folder into{' '}
              <code className="text-mc-text">{installDir}</code> and restart.
            </p>
          </div>
          <div className="relative" ref={uploadMenuRef}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={uploading}
              onClick={() => setUploadOpen((open) => !open)}
            >
              <Upload className="w-4 h-4" />
              {uploading ? 'Uploading…' : 'Upload'}
              <ChevronDown className="w-4 h-4" />
            </button>
            {uploadOpen && (
              <div className="absolute right-0 mt-2 w-44 rounded-lg border border-mc-surfaceLight bg-mc-surface shadow-lg z-10 py-1">
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm text-mc-text hover:bg-mc-surfaceLight"
                  onClick={() => zipInputRef.current?.click()}
                >
                  Zip file
                </button>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm text-mc-text hover:bg-mc-surfaceLight flex items-center gap-2"
                  onClick={() => folderInputRef.current?.click()}
                >
                  <FolderUp className="w-4 h-4" />
                  Folder
                </button>
              </div>
            )}
            <input
              ref={zipInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={onZipChosen}
            />
            <input
              ref={folderInputRef}
              type="file"
              className="hidden"
              webkitdirectory=""
              directory=""
              multiple
              onChange={onFolderChosen}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 text-sm text-mc-danger">{error}</div>
      )}
      {message && (
        <div className="mb-4 text-sm text-mc-accent">{message}</div>
      )}

      {plugins.length === 0 ? (
        <div className="card text-mc-textMuted text-sm">
          No plugins are installed yet.
        </div>
      ) : (
        <div className="space-y-3">
          {plugins.map((plugin) => {
            const Icon = pluginIcon(plugin.icon);
            return (
              <div key={plugin.id} className="card flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-mc-accent/10 text-mc-accent flex items-center justify-center flex-shrink-0">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-white font-semibold">{plugin.name}</h3>
                    <span className="text-xs text-mc-textMuted">v{plugin.version}</span>
                  </div>
                  {plugin.description && (
                    <p className="text-sm text-mc-textMuted mt-1">{plugin.description}</p>
                  )}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={plugin.enabled}
                  aria-label={`${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`}
                  disabled={busyId === plugin.id}
                  onClick={() => togglePlugin(plugin)}
                  className={`toggle ${plugin.enabled ? 'toggle-active' : 'toggle-inactive'} ${
                    busyId === plugin.id ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                >
                  <span className={`toggle-thumb ${plugin.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
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
