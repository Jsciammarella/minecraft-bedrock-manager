import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { modApi } from '../services/api';
import { useApi } from '../context/ApiContext';
import {
  ArrowLeft, Package, Upload, Search, Trash2, Plus, X,
  AlertCircle, Check, Loader2, Server, Download, Settings, ImagePlus
} from 'lucide-react';

function ModLibrary() {
  const navigate = useNavigate();
  const { servers, refresh } = useApi();
  const fileInputRef = useRef(null);
  const settingsImageRef = useRef(null);

  const [mods, setMods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('all');

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadDesc, setUploadDesc] = useState('');
  const [uploadType, setUploadType] = useState('addon');
  const [showUploadModal, setShowUploadModal] = useState(false);

  // Install state
  const [installModal, setInstallModal] = useState(null);
  const [installing, setInstalling] = useState(false);

  const [settingsModal, setSettingsModal] = useState(null);
  const [settingsDesc, setSettingsDesc] = useState('');
  const [settingsImage, setSettingsImage] = useState(null);
  const [settingsPreview, setSettingsPreview] = useState('');
  const [clearThumbnail, setClearThumbnail] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    loadMods();
  }, []);

  const loadMods = async () => {
    try {
      const res = await modApi.getAll();
      setMods(res.data);
    } catch (err) {
      setError('Failed to load mods');
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadFile(file);
      setUploadName(file.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const handleUpload = async () => {
    if (!uploadFile) {
      setError('Please select a file');
      return;
    }

    setUploading(true);
    setError('');
    try {
      await modApi.upload(uploadFile, {
        name: uploadName,
        description: uploadDesc,
        type: uploadType,
      });
      setSuccess('Mod uploaded successfully!');
      setShowUploadModal(false);
      setUploadFile(null);
      setUploadName('');
      setUploadDesc('');
      loadMods();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (modId) => {
    if (!confirm('Delete this mod from the library?')) return;
    try {
      await modApi.delete(modId);
      setSuccess('Mod deleted');
      loadMods();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleInstall = async (modId, serverId) => {
    setInstalling(true);
    try {
      await modApi.install(modId, serverId);
      await refresh();
      setSuccess('Mod installed!');
      setInstallModal(null);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async (modId, serverId) => {
    if (!confirm('Uninstall this mod from the server?')) return;
    try {
      await modApi.uninstall(modId, serverId);
      await refresh();
      setSuccess('Mod uninstalled');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const openSettings = (mod) => {
    setSettingsModal(mod);
    setSettingsDesc(mod.description || '');
    setSettingsImage(null);
    setClearThumbnail(false);
    setSettingsPreview(libraryThumbnailSrc(mod) || '');
    setError('');
  };

  const handleSettingsImage = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSettingsImage(file);
    setClearThumbnail(false);
    setSettingsPreview(URL.createObjectURL(file));
  };

  const handleSaveSettings = async () => {
    if (!settingsModal) return;
    setSavingSettings(true);
    setError('');
    try {
      await modApi.update(settingsModal.id, {
        description: settingsDesc,
        thumbnailFile: settingsImage,
        clearThumbnail: clearThumbnail && !settingsImage,
      });
      setSuccess('Mod details saved');
      setSettingsModal(null);
      loadMods();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save mod details');
    } finally {
      setSavingSettings(false);
    }
  };

  const filteredMods = mods.filter(mod => {
    const matchesSearch = !search || mod.name.toLowerCase().includes(search.toLowerCase());
    const matchesType = filterType === 'all' || mod.type === filterType;
    return matchesSearch && matchesType;
  });

  const getTypeBadge = (type) => {
    const colors = {
      addon: 'badge-info',
      texture_pack: 'badge-warning',
      resource_pack: 'badge-warning',
      world: 'badge-success',
      map: 'badge-success',
      skin: 'badge-danger',
      template: 'badge-info',
    };
    return <span className={`badge ${colors[type] || 'badge-info'}`}>{type.replace('_', ' ')}</span>;
  };

  const getSourceBadge = (source) => {
    if (source === 'curseforge') return <span className="badge badge-info">CurseForge</span>;
    if (source === 'git') return <span className="badge badge-success">Git</span>;
    return <span className="badge badge-warning">Uploaded</span>;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
          <p className="text-sm text-mc-textMuted">Loading mod library...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-white">Mod Library</h1>
            <p className="text-mc-textMuted mt-1">Manage addons, texture packs, and maps</p>
          </div>
        </div>
        <button
          onClick={() => setShowUploadModal(true)}
          className="btn btn-primary"
        >
          <Upload className="w-4 h-4" />
          Upload Mod
        </button>
      </div>

      {/* Messages */}
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-2">
          <Check className="w-4 h-4 text-green-400 flex-shrink-0" />
          <p className="text-sm text-green-400">{success}</p>
        </div>
      )}

      {/* Filters */}
      <div className="card mb-6">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mc-textMuted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-10"
              placeholder="Search mods..."
            />
          </div>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="input w-40"
          >
            <option value="all">All Types</option>
            <option value="addon">Addons</option>
            <option value="texture_pack">Texture Packs</option>
            <option value="world">Worlds</option>
            <option value="skin">Skins</option>
          </select>
        </div>
      </div>

      {/* Mod List */}
      {filteredMods.length === 0 ? (
        <div className="card text-center py-16">
          <Package className="w-16 h-16 text-mc-textMuted mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-white mb-2">No mods in library</h3>
          <p className="text-mc-textMuted mb-6">Upload mods or download them from the catalog</p>
          <div className="flex items-center justify-center gap-3">
            <button onClick={() => setShowUploadModal(true)} className="btn btn-primary">
              <Upload className="w-4 h-4" /> Upload Mod
            </button>
            <button onClick={() => navigate('/mods/catalog')} className="btn btn-secondary">
              <Download className="w-4 h-4" /> Browse Catalog
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredMods.map(mod => (
            <div key={mod.id} className="card animate-slide-up">
              <div className="flex items-start gap-4">
                {/* Icon */}
                <div className="w-12 h-12 bg-mc-darker rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
                  {libraryThumbnailSrc(mod) ? (
                    <img
                      src={libraryThumbnailSrc(mod)}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  ) : (
                    <Package className="w-6 h-6 text-mc-textMuted" />
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-white truncate">{mod.name}</h3>
                    {getTypeBadge(mod.type)}
                    {getSourceBadge(mod.source)}
                  </div>
                  <p className="text-sm text-mc-textMuted mb-2 line-clamp-1">
                    {mod.description || 'No description'}
                  </p>
                  <div className="flex items-center gap-4 text-xs text-mc-textMuted">
                    <span>v{mod.version}</span>
                    <span>{(mod.file_size / 1024).toFixed(1)} KB</span>
                    <span>Added {new Date(mod.downloaded_at).toLocaleDateString()}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => setInstallModal(mod)}
                    className="btn btn-secondary text-sm"
                    title="Install to server"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => openSettings(mod)}
                    className="btn btn-secondary text-sm"
                    title="Mod settings"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(mod.id)}
                    className="btn btn-secondary text-sm text-mc-danger hover:bg-red-500/20"
                    title="Delete from library"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Upload Mod</h3>
              <button onClick={() => setShowUploadModal(false)} className="p-1 hover:bg-mc-surfaceLight rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              {/* File Drop */}
              <div
                className="border-2 border-dashed border-mc-surfaceLight rounded-lg p-8 text-center 
                  hover:border-mc-accent/50 transition-colors cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-8 h-8 text-mc-textMuted mx-auto mb-2" />
                {uploadFile ? (
                  <p className="text-sm text-mc-accent">{uploadFile.name}</p>
                ) : (
                  <p className="text-sm text-mc-textMuted">Click to select a file</p>
                )}
                <p className="text-xs text-mc-textMuted mt-1">.mcpack, .mcaddon, .mcworld, .zip</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".mcpack,.mcaddon,.mcworld,.zip,.mctemplate"
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Name</label>
                <input
                  type="text"
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                  className="input"
                  placeholder="Mod name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Type</label>
                <select
                  value={uploadType}
                  onChange={(e) => setUploadType(e.target.value)}
                  className="input"
                >
                  <option value="addon">Addon</option>
                  <option value="texture_pack">Texture Pack</option>
                  <option value="world">World/Map</option>
                  <option value="skin">Skin</option>
                  <option value="template">Template</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Description</label>
                <textarea
                  value={uploadDesc}
                  onChange={(e) => setUploadDesc(e.target.value)}
                  className="input resize-none"
                  rows="2"
                  placeholder="Optional description..."
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleUpload}
                  disabled={uploading || !uploadFile}
                  className="btn btn-primary flex-1"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      Upload
                    </>
                  )}
                </button>
                <button
                  onClick={() => setShowUploadModal(false)}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Install to Server Modal */}
      {installModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Install to Server</h3>
              <button onClick={() => setInstallModal(null)} className="p-1 hover:bg-mc-surfaceLight rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-mc-textMuted mb-4">
              Install <strong className="text-white">{installModal.name}</strong> to a server:
            </p>

            <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
              {servers.length === 0 ? (
                <p className="text-sm text-mc-textMuted text-center py-4">No servers available</p>
              ) : (
                servers.map(server => (
                  <button
                    key={server.id}
                    onClick={() => handleInstall(installModal.id, server.id)}
                    disabled={installing}
                    className="w-full flex items-center gap-3 p-3 bg-mc-darker rounded-lg 
                      hover:bg-mc-surfaceLight transition-colors text-left"
                  >
                    <Server className="w-4 h-4 text-mc-textMuted" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-white">{server.name}</p>
                      <p className="text-xs text-mc-textMuted">Port {server.port} • {server.status}</p>
                    </div>
                    <Plus className="w-4 h-4 text-mc-accent" />
                  </button>
                ))
              )}
            </div>

            <button
              onClick={() => setInstallModal(null)}
              className="btn btn-secondary w-full"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {settingsModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Mod Settings</h3>
              <button onClick={() => setSettingsModal(null)} className="p-1 hover:bg-mc-surfaceLight rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-mc-textMuted mb-4">
              Update details for <strong className="text-white">{settingsModal.name}</strong>
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Image</label>
                <div
                  className="border-2 border-dashed border-mc-surfaceLight rounded-lg p-4 text-center
                    hover:border-mc-accent/50 transition-colors cursor-pointer"
                  onClick={() => settingsImageRef.current?.click()}
                >
                  {settingsPreview && !clearThumbnail ? (
                    <img
                      src={settingsPreview}
                      alt=""
                      className="w-full h-36 object-cover rounded-lg mb-2"
                    />
                  ) : (
                    <ImagePlus className="w-8 h-8 text-mc-textMuted mx-auto mb-2" />
                  )}
                  <p className="text-sm text-mc-textMuted">
                    {settingsImage ? settingsImage.name : 'Click to choose a PNG, JPEG, WebP, or GIF'}
                  </p>
                  <input
                    ref={settingsImageRef}
                    type="file"
                    accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif"
                    onChange={handleSettingsImage}
                    className="hidden"
                  />
                </div>
                {(settingsPreview || settingsModal.thumbnail) && !clearThumbnail && (
                  <button
                    type="button"
                    onClick={() => {
                      setSettingsImage(null);
                      setSettingsPreview('');
                      setClearThumbnail(true);
                    }}
                    className="mt-2 text-xs text-mc-danger hover:underline"
                  >
                    Remove image
                  </button>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Description</label>
                <textarea
                  value={settingsDesc}
                  onChange={(e) => setSettingsDesc(e.target.value)}
                  className="input resize-none"
                  rows="4"
                  placeholder="Describe this mod..."
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleSaveSettings}
                  disabled={savingSettings}
                  className="btn btn-primary flex-1"
                >
                  {savingSettings ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      Save
                    </>
                  )}
                </button>
                <button
                  onClick={() => setSettingsModal(null)}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function libraryThumbnailSrc(mod) {
  if (!mod?.thumbnail) return '';
  const value = String(mod.thumbnail);
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/api/')) {
    return value;
  }
  return `/api/mods/${mod.id}/thumbnail?v=${encodeURIComponent(mod.downloaded_at || mod.id)}`;
}

export default ModLibrary;
