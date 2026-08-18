import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { modApi } from '../services/api';
import { useApi } from '../context/ApiContext';
import {
  ArrowLeft, Package, Upload, Search, Trash2, Plus, X,
  AlertCircle, Check, Loader2, Server, Download, Settings, ImagePlus
} from 'lucide-react';

const LIBRARY_PAGE_SIZE = 40;
const CURSEFORGE_URL_PREFIX = 'https://www.curseforge.com/minecraft-bedrock';
const MCPEDL_URL_PREFIX = 'https://mcpedl.com';
const MCPEDL_WWW_PREFIX = 'https://www.mcpedl.com';

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
  const [page, setPage] = useState(1);
  const [expandedMod, setExpandedMod] = useState(null);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [uploadFiles, setUploadFiles] = useState([]);
  const [uploadIndex, setUploadIndex] = useState(0);
  const [uploadName, setUploadName] = useState('');
  const [uploadDesc, setUploadDesc] = useState('');
  const [uploadType, setUploadType] = useState('addon');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showCurseforgeModal, setShowCurseforgeModal] = useState(false);
  const [curseforgeUrl, setCurseforgeUrl] = useState('');
  const [importingCurseforge, setImportingCurseforge] = useState(false);
  const [showMcpedlModal, setShowMcpedlModal] = useState(false);
  const [mcpedlUrl, setMcpedlUrl] = useState('');
  const [importingMcpedl, setImportingMcpedl] = useState(false);

  // Install state
  const [installModal, setInstallModal] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [installingServerId, setInstallingServerId] = useState(null);
  const [installError, setInstallError] = useState('');

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
      setExpandedMod(prev => (prev ? res.data.find(mod => mod.id === prev.id) || null : null));
    } catch (err) {
      setError('Failed to load mods');
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    setUploadFiles(files);
    if (files.length === 1) {
      setUploadName(files[0].name.replace(/\.[^/.]+$/, ''));
      setUploadType(typeFromFileName(files[0].name));
    } else {
      setUploadName('');
    }
  };

  const handleUpload = async () => {
    if (!uploadFiles.length) {
      setError('Please select a file');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setUploadIndex(0);
    setError('');
    const failures = [];
    try {
      for (let i = 0; i < uploadFiles.length; i += 1) {
        const file = uploadFiles[i];
        setUploadIndex(i);
        setUploadProgress(0);
        try {
          await modApi.upload(file, {
            name: uploadFiles.length === 1 ? (uploadName || file.name.replace(/\.[^/.]+$/, '')) : file.name.replace(/\.[^/.]+$/, ''),
            description: uploadDesc,
            type: uploadFiles.length === 1 ? uploadType : typeFromFileName(file.name),
          }, (percent) => setUploadProgress(percent));
        } catch (err) {
          failures.push(`${file.name}: ${err.response?.data?.error || err.message || 'Upload failed'}`);
        }
      }
      loadMods();
      if (failures.length) {
        setError(failures.join(' '));
        return;
      }
      setSuccess(uploadFiles.length === 1 ? 'Mod uploaded successfully!' : `${uploadFiles.length} mods uploaded successfully!`);
      setShowUploadModal(false);
      setUploadFiles([]);
      setUploadName('');
      setUploadDesc('');
      setUploadProgress(null);
      setTimeout(() => setSuccess(''), 3000);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const curseforgeUrlValid = curseforgeUrl.trim().startsWith(CURSEFORGE_URL_PREFIX);
  const mcpedlUrlValid = (() => {
    const value = mcpedlUrl.trim();
    return value.startsWith(MCPEDL_URL_PREFIX) || value.startsWith(MCPEDL_WWW_PREFIX);
  })();

  const openCurseforgeModal = () => {
    setError('');
    setCurseforgeUrl('');
    setShowCurseforgeModal(true);
  };

  const handleCurseforgeImport = async () => {
    if (!curseforgeUrlValid) return;
    setImportingCurseforge(true);
    setError('');
    try {
      const res = await modApi.importCurseforgeUrl(curseforgeUrl.trim());
      await loadMods();
      setSuccess(`${res.data?.name || 'Mod'} imported from CurseForge`);
      setShowCurseforgeModal(false);
      setCurseforgeUrl('');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'CurseForge import failed');
    } finally {
      setImportingCurseforge(false);
    }
  };

  const openMcpedlModal = () => {
    setError('');
    setMcpedlUrl('');
    setShowMcpedlModal(true);
  };

  const handleMcpedlImport = async () => {
    if (!mcpedlUrlValid) return;
    setImportingMcpedl(true);
    setError('');
    try {
      const res = await modApi.importMcpedlUrl(mcpedlUrl.trim());
      await loadMods();
      setSuccess(`${res.data?.name || 'Mod'} imported from MCPEDL`);
      setShowMcpedlModal(false);
      setMcpedlUrl('');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'MCPEDL import failed');
    } finally {
      setImportingMcpedl(false);
    }
  };

  const handleDelete = async (modId) => {
    if (!confirm('Delete this mod from the library?')) return;
    try {
      await modApi.delete(modId);
      setSuccess('Mod deleted');
      setExpandedMod(null);
      loadMods();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const openInstallModal = (mod) => {
    setInstallError('');
    setInstallingServerId(null);
    setInstallModal(mod);
  };

  const handleInstall = async (modId, serverId) => {
    if (installing) return;
    setInstalling(true);
    setInstallingServerId(serverId);
    setInstallError('');
    try {
      await modApi.install(modId, serverId);
      await refresh();
      setSuccess('Mod installed!');
      setInstallModal(null);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setInstallError(err.response?.data?.error || err.message);
    } finally {
      setInstalling(false);
      setInstallingServerId(null);
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

  const totalPages = Math.max(1, Math.ceil(filteredMods.length / LIBRARY_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageMods = filteredMods.slice(
    (currentPage - 1) * LIBRARY_PAGE_SIZE,
    currentPage * LIBRARY_PAGE_SIZE
  );
  const pageNumbers = visiblePageNumbers(currentPage, totalPages);
  const showPager = totalPages > 1 || currentPage > 1;

  const goToPage = (nextPage) => {
    setPage(Math.min(totalPages, Math.max(1, nextPage)));
  };

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const getTypeBadge = (type) => {
    const colors = {
      addon: 'badge-info',
      texture_pack: 'badge-warning',
      resource_pack: 'badge-warning',
      world: 'badge-success',
      map: 'badge-success',
      template: 'badge-success',
      structure: 'badge-warning',
      skin: 'badge-danger',
    };
    return <span className={`badge ${colors[type] || 'badge-info'}`}>{(type || 'addon').replace('_', ' ')}</span>;
  };

  const getSourceBadge = (source) => {
    if (source === 'curseforge') return <span className="badge badge-info">CurseForge</span>;
    if (source === 'mcpedl') return <span className="badge badge-info">MCPEDL</span>;
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
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="page-header flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-white">Mod Library</h1>
            <p className="text-mc-textMuted mt-1">Manage addons, texture packs, and maps</p>
          </div>
        </div>
        <div className="page-header-actions flex items-center gap-2">
          <button
            onClick={() => {
              setUploadProgress(null);
              setShowUploadModal(true);
            }}
            className="btn btn-primary"
          >
            <Upload className="w-4 h-4" />
            Upload Mod
          </button>
          <button
            onClick={openCurseforgeModal}
            className="btn btn-primary"
          >
            <Download className="w-4 h-4" />
            Download CurseForge URL
          </button>
          <button
            onClick={openMcpedlModal}
            className="btn btn-primary"
          >
            <Download className="w-4 h-4" />
            Download MCPEDL URL
          </button>
        </div>
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
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="input pl-10"
              placeholder="Search mods..."
            />
          </div>
          <select
            value={filterType}
            onChange={(e) => {
              setFilterType(e.target.value);
              setPage(1);
            }}
            className="input w-40"
          >
            <option value="all">All Types</option>
            <option value="addon">Addons</option>
            <option value="texture_pack">Texture Packs</option>
            <option value="world">Worlds</option>
            <option value="template">Templates</option>
            <option value="structure">Structures</option>
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
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <button
              onClick={() => {
                setUploadProgress(null);
                setShowUploadModal(true);
              }}
              className="btn btn-primary"
            >
              <Upload className="w-4 h-4" /> Upload Mod
            </button>
            <button onClick={openCurseforgeModal} className="btn btn-primary">
              <Download className="w-4 h-4" /> Download CurseForge URL
            </button>
            <button onClick={openMcpedlModal} className="btn btn-primary">
              <Download className="w-4 h-4" /> Download MCPEDL URL
            </button>
            <button onClick={() => navigate('/mods/catalog')} className="btn btn-secondary">
              <Download className="w-4 h-4" /> Browse Catalog
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {pageMods.map(mod => (
              <LibraryTile
                key={mod.id}
                mod={mod}
                onOpen={() => setExpandedMod(mod)}
                onInstall={() => openInstallModal(mod)}
                getTypeBadge={getTypeBadge}
                getSourceBadge={getSourceBadge}
              />
            ))}
          </div>
          {showPager && (
            <LibraryPager
              page={currentPage}
              totalPages={totalPages}
              pageNumbers={pageNumbers}
              onPage={goToPage}
            />
          )}
        </>
      )}

      {expandedMod && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={() => setExpandedMod(null)}
        >
          <LibraryTile
            mod={expandedMod}
            expanded
            onClose={() => setExpandedMod(null)}
            onInstall={() => openInstallModal(expandedMod)}
            onSettings={() => openSettings(expandedMod)}
            onDelete={() => handleDelete(expandedMod.id)}
            getTypeBadge={getTypeBadge}
            getSourceBadge={getSourceBadge}
          />
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Upload Mod</h3>
              <button
                onClick={() => setShowUploadModal(false)}
                disabled={uploading}
                className="p-1 hover:bg-mc-surfaceLight rounded disabled:opacity-30"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {error && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            <div className="space-y-4">
              {/* File Drop */}
              <div
                className={`border-2 border-dashed border-mc-surfaceLight rounded-lg p-8 text-center 
                  hover:border-mc-accent/50 transition-colors ${uploading ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}
                onClick={() => { if (!uploading) fileInputRef.current?.click(); }}
              >
                <Upload className="w-8 h-8 text-mc-textMuted mx-auto mb-2" />
                {uploadFiles.length === 1 ? (
                  <p className="text-sm text-mc-accent">{uploadFiles[0].name}</p>
                ) : uploadFiles.length > 1 ? (
                  <p className="text-sm text-mc-accent">{uploadFiles.length} files selected</p>
                ) : (
                  <p className="text-sm text-mc-textMuted">Click to select one or more files</p>
                )}
                <p className="text-xs text-mc-textMuted mt-1">.mcpack, .mcaddon, .mcworld, .mctemplate, .mcstructure, .zip</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".mcpack,.mcaddon,.mcworld,.zip,.mctemplate,.mcstructure"
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </div>

              {uploadFiles.length > 1 && (
                <ul className="max-h-28 overflow-y-auto text-xs text-mc-textMuted space-y-1">
                  {uploadFiles.map((file, index) => (
                    <li key={`${file.name}-${index}`} className={uploading && index === uploadIndex ? 'text-mc-accent' : ''}>
                      {file.name}
                    </li>
                  ))}
                </ul>
              )}

              {uploadFiles.length <= 1 && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-mc-text mb-2">Name</label>
                    <input
                      type="text"
                      value={uploadName}
                      onChange={(e) => setUploadName(e.target.value)}
                      disabled={uploading}
                      className="input"
                      placeholder="Mod name"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-mc-text mb-2">Type</label>
                    <select
                      value={uploadType}
                      onChange={(e) => setUploadType(e.target.value)}
                      disabled={uploading}
                      className="input"
                    >
                      <option value="addon">Addon</option>
                      <option value="texture_pack">Texture Pack</option>
                      <option value="world">World/Map</option>
                      <option value="template">Template</option>
                      <option value="structure">Structure</option>
                      <option value="skin">Skin</option>
                    </select>
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Description</label>
                <textarea
                  value={uploadDesc}
                  onChange={(e) => setUploadDesc(e.target.value)}
                  className="input resize-none"
                  rows="2"
                  placeholder="Optional description..."
                  disabled={uploading}
                />
              </div>

              {uploading && (
                <div>
                  <div className="h-2 bg-mc-darker rounded-full overflow-hidden">
                    <div
                      className={`h-full bg-mc-accent transition-all duration-200 ${
                        uploadProgress == null ? 'w-1/3 animate-pulse' : ''
                      }`}
                      style={uploadProgress == null ? undefined : { width: `${uploadProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-mc-textMuted mt-2">
                    {uploadFiles.length > 1
                      ? `Uploading ${uploadIndex + 1} of ${uploadFiles.length}${uploadProgress == null ? '' : uploadProgress < 100 ? ` — ${uploadProgress}%` : ' — saving'}`
                      : uploadProgress == null
                        ? 'Uploading…'
                        : uploadProgress < 100
                          ? `Uploading ${uploadProgress}%`
                          : 'Saving to the library…'}
                  </p>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleUpload}
                  disabled={uploading || uploadFiles.length === 0}
                  className="btn btn-primary flex-1"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {uploadProgress != null && uploadProgress < 100
                        ? `Uploading ${uploadProgress}%`
                        : uploadFiles.length > 1
                          ? `Uploading ${uploadIndex + 1} of ${uploadFiles.length}`
                          : 'Uploading...'}
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
                  disabled={uploading}
                  className="btn btn-secondary disabled:opacity-30"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCurseforgeModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Download CurseForge URL</h3>
              <button
                onClick={() => setShowCurseforgeModal(false)}
                disabled={importingCurseforge}
                className="p-1 hover:bg-mc-surfaceLight rounded disabled:opacity-30"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {error && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">CurseForge URL</label>
                <input
                  type="url"
                  value={curseforgeUrl}
                  onChange={(e) => setCurseforgeUrl(e.target.value)}
                  disabled={importingCurseforge}
                  className="input"
                  placeholder="https://www.curseforge.com/minecraft-bedrock/addons/..."
                  autoFocus
                />
                <p className="text-xs text-mc-textMuted mt-2">
                  Paste a CurseForge Bedrock project URL. The address must start with{' '}
                  <span className="text-mc-text">https://www.curseforge.com/minecraft-bedrock</span>.
                </p>
                {curseforgeUrl.trim() && !curseforgeUrlValid && (
                  <p className="text-xs text-red-400 mt-2">
                    URL must start with https://www.curseforge.com/minecraft-bedrock
                  </p>
                )}
              </div>

              {importingCurseforge && (
                <div className="p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-yellow-300 text-sm flex items-start gap-2">
                  <Loader2 className="w-4 h-4 flex-shrink-0 mt-0.5 animate-spin" />
                  <div>
                    <p className="font-medium">Downloading from CurseForge…</p>
                    <p className="text-xs text-yellow-200/80 mt-1">
                      Waiting for CurseForge metadata, then downloading the pack. Large maps can take several minutes.
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleCurseforgeImport}
                  disabled={importingCurseforge || !curseforgeUrlValid}
                  className="btn btn-primary flex-1"
                >
                  {importingCurseforge ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Downloading...
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      Download
                    </>
                  )}
                </button>
                <button
                  onClick={() => setShowCurseforgeModal(false)}
                  disabled={importingCurseforge}
                  className="btn btn-secondary disabled:opacity-30"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showMcpedlModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Download MCPEDL URL</h3>
              <button
                onClick={() => setShowMcpedlModal(false)}
                disabled={importingMcpedl}
                className="p-1 hover:bg-mc-surfaceLight rounded disabled:opacity-30"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {error && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">MCPEDL URL</label>
                <input
                  type="url"
                  value={mcpedlUrl}
                  onChange={(e) => setMcpedlUrl(e.target.value)}
                  disabled={importingMcpedl}
                  className="input"
                  placeholder="https://mcpedl.com/..."
                  autoFocus
                />
                <p className="text-xs text-mc-textMuted mt-2">
                  Paste an MCPEDL project URL. The address must start with{' '}
                  <span className="text-mc-text">https://mcpedl.com</span>.
                </p>
                {mcpedlUrl.trim() && !mcpedlUrlValid && (
                  <p className="text-xs text-red-400 mt-2">
                    URL must start with https://mcpedl.com
                  </p>
                )}
              </div>

              {importingMcpedl && (
                <div className="p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-yellow-300 text-sm flex items-start gap-2">
                  <Loader2 className="w-4 h-4 flex-shrink-0 mt-0.5 animate-spin" />
                  <div>
                    <p className="font-medium">Downloading from MCPEDL…</p>
                    <p className="text-xs text-yellow-200/80 mt-1">
                      Waiting for MCPEDL metadata, then downloading the pack. Large maps can take several minutes.
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleMcpedlImport}
                  disabled={importingMcpedl || !mcpedlUrlValid}
                  className="btn btn-primary flex-1"
                >
                  {importingMcpedl ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Downloading...
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      Download
                    </>
                  )}
                </button>
                <button
                  onClick={() => setShowMcpedlModal(false)}
                  disabled={importingMcpedl}
                  className="btn btn-secondary disabled:opacity-30"
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
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Install to Server</h3>
              <button
                onClick={() => setInstallModal(null)}
                disabled={installing}
                className="p-1 hover:bg-mc-surfaceLight rounded disabled:opacity-30"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-mc-textMuted mb-4">
              Install <strong className="text-white">{installModal.name}</strong> to a server:
            </p>

            {installing && (
              <div className="mb-4 p-2.5 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-yellow-300 text-sm flex items-start gap-2">
                <Loader2 className="w-4 h-4 flex-shrink-0 mt-0.5 animate-spin" />
                <div>
                  <p className="font-medium">Installing</p>
                  <p className="text-xs text-yellow-200/80 mt-1">
                    Copying this pack onto the selected server. This window closes when it finishes.
                  </p>
                </div>
              </div>
            )}

            {installError && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <p className="text-sm text-red-400">{installError}</p>
              </div>
            )}

            <div className={`space-y-2 mb-4 max-h-64 overflow-y-auto ${installing ? 'pointer-events-none' : ''}`}>
              {servers.length === 0 ? (
                <p className="text-sm text-mc-textMuted text-center py-4">No servers available</p>
              ) : (
                servers.map(server => {
                  const isTarget = installing && installingServerId === server.id;
                  return (
                    <button
                      key={server.id}
                      onClick={() => handleInstall(installModal.id, server.id)}
                      disabled={installing}
                      className={`w-full flex items-center gap-3 p-3 bg-mc-darker rounded-lg text-left transition-colors ${
                        installing && !isTarget
                          ? 'opacity-40 cursor-not-allowed'
                          : installing
                            ? 'border border-yellow-500/40 cursor-not-allowed'
                            : 'hover:bg-mc-surfaceLight'
                      }`}
                    >
                      <Server className="w-4 h-4 text-mc-textMuted" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-white">{server.name}</p>
                        <p className="text-xs text-mc-textMuted">
                          {isTarget ? 'Installing…' : `Port ${server.port} • ${server.status}`}
                        </p>
                      </div>
                      {isTarget ? (
                        <Loader2 className="w-4 h-4 text-yellow-300 animate-spin" />
                      ) : (
                        <Plus className="w-4 h-4 text-mc-accent" />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            <button
              onClick={() => setInstallModal(null)}
              disabled={installing}
              className="btn btn-secondary w-full disabled:opacity-30"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {settingsModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4">
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

function typeFromFileName(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.mcworld')) return 'world';
  if (lower.endsWith('.mctemplate')) return 'template';
  if (lower.endsWith('.mcstructure')) return 'structure';
  if (lower.endsWith('.mcpack')) return 'texture_pack';
  return 'addon';
}

function libraryThumbnailSrc(mod) {
  if (!mod?.thumbnail) return '';
  const value = String(mod.thumbnail);
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/api/')) {
    return value;
  }
  return `/api/mods/${mod.id}/thumbnail?v=${encodeURIComponent(mod.downloaded_at || mod.id)}`;
}

function visiblePageNumbers(current, totalPages, windowSize = 9) {
  if (totalPages <= 1) return [];
  if (totalPages <= windowSize) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const half = Math.floor(windowSize / 2);
  let start = current - half;
  let end = current + half;
  if (start < 1) {
    end += 1 - start;
    start = 1;
  }
  if (end > totalPages) {
    start -= end - totalPages;
    end = totalPages;
  }
  start = Math.max(1, start);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function LibraryPager({ page, totalPages, pageNumbers, onPage }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 mt-8">
      <button
        type="button"
        onClick={() => onPage(page - 1)}
        disabled={page <= 1}
        className="btn btn-secondary text-sm disabled:opacity-30"
      >
        Previous
      </button>
      {pageNumbers.map((number) => (
        <button
          key={number}
          type="button"
          onClick={() => onPage(number)}
          disabled={number === page}
          className={`text-sm min-w-[2.25rem] ${
            number === page ? 'btn btn-primary' : 'btn btn-secondary'
          }`}
        >
          {number}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onPage(page + 1)}
        disabled={page >= totalPages}
        className="btn btn-secondary text-sm disabled:opacity-30"
      >
        Next
      </button>
    </div>
  );
}

function LibraryTile({
  mod,
  expanded = false,
  onOpen,
  onClose,
  onInstall,
  onSettings,
  onDelete,
  getTypeBadge,
  getSourceBadge,
}) {
  const thumb = libraryThumbnailSrc(mod);
  const sizeLabel = Number.isFinite(mod.file_size)
    ? `${(mod.file_size / 1024).toFixed(1)} KB`
    : '';

  return (
    <div
      className={`card hover:border-mc-accent/30 transition-all duration-200 group ${
        expanded
          ? 'relative max-w-2xl w-full max-h-[90vh] overflow-y-auto animate-slide-up'
          : 'cursor-pointer'
      }`}
      onClick={expanded ? (event) => event.stopPropagation() : onOpen}
      role={expanded ? undefined : 'button'}
      tabIndex={expanded ? undefined : 0}
      onKeyDown={expanded ? undefined : (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {expanded && (
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 z-10 p-1.5 rounded-lg bg-black/60 hover:bg-black/80 text-white transition-colors"
          title="Close"
        >
          <X className="w-5 h-5" />
        </button>
      )}

      <div className={`bg-mc-darker rounded-lg mb-3 overflow-hidden relative ${expanded ? 'aspect-[16/9]' : 'aspect-video'}`}>
        {thumb ? (
          <img
            src={thumb}
            alt={mod.name}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Package className={`${expanded ? 'w-12 h-12' : 'w-8 h-8'} text-mc-textMuted`} />
          </div>
        )}
        <div className={`absolute top-2 flex flex-col gap-1 ${expanded ? 'left-2 items-start' : 'right-2 items-end'}`}>
          {getTypeBadge(mod.type)}
          {getSourceBadge(mod.source)}
        </div>
      </div>

      <h3
        className={`font-semibold text-white mb-1 ${expanded ? 'text-xl pr-10' : 'text-sm truncate'}`}
        title={mod.name}
      >
        {mod.name}
      </h3>
      <p className={`text-mc-textMuted mb-3 ${expanded ? 'text-sm whitespace-pre-wrap' : 'text-xs line-clamp-2 min-h-[2.5em]'}`}>
        {mod.description || 'No description available'}
      </p>

      <div className={`flex items-center gap-3 text-mc-textMuted mb-3 ${expanded ? 'text-sm' : 'text-xs'}`}>
        <span>v{mod.version || '1.0.0'}</span>
        {sizeLabel && <span>{sizeLabel}</span>}
        {expanded && mod.downloaded_at && (
          <span>Added {new Date(mod.downloaded_at).toLocaleDateString()}</span>
        )}
      </div>

      <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
        <button
          onClick={onInstall}
          className={`btn btn-primary flex-1 ${expanded ? '' : 'text-xs'}`}
        >
          <Plus className={expanded ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
          Install
        </button>
        {expanded && (
          <>
            <button
              onClick={onSettings}
              className="btn btn-secondary"
              title="Mod settings"
            >
              <Settings className="w-4 h-4" />
            </button>
            <button
              onClick={onDelete}
              className="btn btn-secondary text-mc-danger hover:bg-red-500/20"
              title="Delete from library"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default ModLibrary;
