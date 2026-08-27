import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { modApi, serverApi } from '../services/api';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import ModTileTags from '../components/ModTileTags';
import { isJavaLibraryMod, isModCompatibleWithServer, isEligibleJavaInstallTarget, isClientOnlyOnly, candidateInstallFiles, incompatibilityReasonCodes, incompatibilityReasonLabel, canOverrideCompatibility, needsJarSelection, loaderDisplayName, modLoaderIds, modVersionTags } from '../utils/modCompatibility';
import { serverCapability } from '../utils/serverCapabilities';
import {
  EMPTY_FILTER_AVAILABILITY,
  libraryFilterAllowedIds,
  libraryFilterOptions,
  modMatchesLibraryFilter,
  parseFilterAvailability,
} from '../utils/catalogFilters';
import {
  ArrowLeft, Package, Upload, Search, Trash2, Plus, X,
  AlertCircle, AlertTriangle, Check, Loader2, Server, Download, Settings, ImagePlus
} from 'lucide-react';

const LIBRARY_PAGE_SIZE = 40;
const CURSEFORGE_URL_PREFIX = 'https://www.curseforge.com/minecraft-bedrock';
const MCPEDL_URL_PREFIX = 'https://mcpedl.com';
const MCPEDL_WWW_PREFIX = 'https://www.mcpedl.com';

function ModLibrary() {
  const navigate = useNavigate();
  const { servers, refresh } = useApi();
  const { can, canAny } = useAuth();
  const canUpload = can('library.upload');
  const canDelete = can('library.delete_entry');
  const canChangeSettings = canAny('library.edit_metadata', 'library.add_file', 'library.remove_file');
  const canImportCurseforge = can('library.import_curseforge');
  const canImportMcpedl = can('library.import_mcpedl');
  const canInstall = can('servers.mods.install');
  const canOverrideCompatibilityPerm = can('servers.java.mods.override_compatibility');
  const fileInputRef = useRef(null);
  const settingsImageRef = useRef(null);

  const [mods, setMods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [filterEdition, setFilterEdition] = useState('all');
  const [page, setPage] = useState(1);
  const [expandedMod, setExpandedMod] = useState(null);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [uploadFiles, setUploadFiles] = useState([]);
  const [uploadName, setUploadName] = useState('');
  const [uploadDesc, setUploadDesc] = useState('');
  const [uploadType, setUploadType] = useState('addon');
  const [uploadEdition, setUploadEdition] = useState('bedrock');
  const [uploadJavaMeta, setUploadJavaMeta] = useState([]);
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
  const [showIncompatibleServers, setShowIncompatibleServers] = useState(false);
  const [overrideConfirm, setOverrideConfirm] = useState(null);
  const [installFileSha, setInstallFileSha] = useState('');
  const [deleteModal, setDeleteModal] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const [settingsModal, setSettingsModal] = useState(null);
  const [settingsDesc, setSettingsDesc] = useState('');
  const [fileDeleteModal, setFileDeleteModal] = useState(null);
  const [addingJarFiles, setAddingJarFiles] = useState([]);
  const [addingJarMeta, setAddingJarMeta] = useState([]);
  const [addingJars, setAddingJars] = useState(false);
  const addJarInputRef = useRef(null);
  const [settingsImage, setSettingsImage] = useState(null);
  const [settingsPreview, setSettingsPreview] = useState('');
  const [clearThumbnail, setClearThumbnail] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [javaProviders, setJavaProviders] = useState([]);
  const [filterAvailability, setFilterAvailability] = useState(EMPTY_FILTER_AVAILABILITY);

  useEffect(() => {
    loadMods();
    const loadFilterState = () => {
      serverApi.javaProviders()
        .then((res) => setJavaProviders(res.data?.providers || []))
        .catch(() => setJavaProviders([]));
      modApi.catalogFilterAvailability()
        .then((res) => setFilterAvailability(parseFilterAvailability(res.data)))
        .catch(() => setFilterAvailability(EMPTY_FILTER_AVAILABILITY));
    };
    loadFilterState();
    window.addEventListener('mbm-plugins-changed', loadFilterState);
    return () => window.removeEventListener('mbm-plugins-changed', loadFilterState);
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
    if (!files.length) {
      setUploadName('');
      return;
    }
    const primary = [...files].sort((a, b) => {
      const rank = { '.mcaddon': 0, '.zip': 1, '.mcpack': 2, '.mcworld': 3, '.mctemplate': 4, '.mcstructure': 5 };
      const aRank = rank[`.${a.name.split('.').pop()?.toLowerCase()}`] ?? 9;
      const bRank = rank[`.${b.name.split('.').pop()?.toLowerCase()}`] ?? 9;
      return aRank - bRank || a.name.localeCompare(b.name);
    })[0];
    setUploadName(primary.name.replace(/\.[^/.]+$/, ''));
    setUploadType(typeFromFileName(primary.name));
    setUploadJavaMeta(files.map((file) => ({
      name: file.name,
      loader: '',
      minecraftVersions: '',
      environment: 'unknown',
    })));
  };

  const handleUpload = async () => {
    if (!canUpload) return;
    if (!uploadFiles.length) {
      setError('Please select a file');
      return;
    }

    if (uploadEdition === 'java' && !uploadFiles.every((file) => /\.(jar|zip)$/i.test(file.name))) {
      setError('Java mods must be JAR or ZIP files');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setError('');
    try {
      await modApi.upload(uploadFiles, {
        name: uploadName || uploadFiles[0].name.replace(/\.[^/.]+$/, ''),
        description: uploadDesc,
        type: uploadEdition === 'java' ? 'mod' : uploadType,
        edition: uploadEdition,
        javaFiles: uploadEdition === 'java' ? uploadJavaMeta.map((item, index) => ({
          name: uploadFiles[index]?.name || item.name,
          loader: item.loader,
          minecraftVersions: String(item.minecraftVersions || '').split(/[,;]/).map((part) => part.trim()).filter(Boolean),
          environment: item.environment || 'unknown',
        })) : undefined,
      }, (percent) => setUploadProgress(percent));
      loadMods();
      setSuccess('Mod uploaded successfully!');
      setShowUploadModal(false);
      setUploadFiles([]);
      setUploadName('');
      setUploadDesc('');
      setUploadEdition('bedrock');
      setUploadJavaMeta([]);
      setUploadProgress(null);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Upload failed');
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
    if (!canImportCurseforge) return;
    setError('');
    setCurseforgeUrl('');
    setShowCurseforgeModal(true);
  };

  const handleCurseforgeImport = async () => {
    if (!canImportCurseforge || !curseforgeUrlValid) return;
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
    if (!canImportMcpedl) return;
    setError('');
    setMcpedlUrl('');
    setShowMcpedlModal(true);
  };

  const handleMcpedlImport = async () => {
    if (!canImportMcpedl || !mcpedlUrlValid) return;
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

  const installedServersForMod = (modId) => (
    (servers || []).filter((server) => {
      if (server.kind === 'bedrock_connect' || server.kind === 'remote') return false;
      return (server.installedModIds || []).map(Number).includes(Number(modId));
    })
  );

  const scrollLibraryTop = () => {
    requestAnimationFrame(() => {
      const main = document.querySelector('main');
      if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  const handleDelete = (mod) => {
    if (!canDelete || !mod?.id) return;
    setDeleteModal({ mod, servers: installedServersForMod(mod.id) });
  };

  const performDelete = async (modId, uninstallFromAll) => {
    if (!canDelete) return;
    setDeleting(true);
    setError('');
    try {
      await modApi.delete(modId, { uninstallFromAll });
      setSuccess(uninstallFromAll
        ? 'Mod removed from all servers and deleted from the library'
        : 'Mod deleted');
      setDeleteModal(null);
      setExpandedMod(null);
      await loadMods();
      await refresh();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setDeleteModal(null);
      setExpandedMod(null);
      setError(err.response?.data?.error || err.message);
      scrollLibraryTop();
    } finally {
      setDeleting(false);
    }
  };

  const openInstallModal = (mod) => {
    if (!canInstall) return;

    if (isJavaLibraryMod(mod) && javaProviders.length === 0) return;

    setInstallError('');
    setInstallingServerId(null);
    setShowIncompatibleServers(false);
    setOverrideConfirm(null);
    setInstallFileSha('');
    setInstallModal(mod);
  };

  const handleInstall = async (modId, serverId, { override = false, fileSha256 } = {}) => {
    if (!canInstall || installing) return;
    setInstalling(true);
    setInstallingServerId(serverId);
    setInstallError('');
    try {
      const body = {};
      if (override) body.override = true;
      if (fileSha256) body.fileSha256 = fileSha256;
      await modApi.install(modId, serverId, Object.keys(body).length ? body : null);
      await refresh();
      setSuccess('Mod installed!');
      setInstallModal(null);
      setOverrideConfirm(null);
      setExpandedMod(null);
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
    if (!canChangeSettings) return;
    setSettingsModal(mod);
    setSettingsDesc(mod.description || '');
    setFileDeleteModal(null);
    setAddingJarFiles([]);
    setAddingJarMeta([]);
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

  const handleAddJarSelect = (e) => {
    const files = Array.from(e.target.files || []);
    setAddingJarFiles(files);
    setAddingJarMeta(files.map((file) => ({
      name: file.name,
      loader: '',
      minecraftVersions: '',
      environment: 'unknown',
    })));
  };

  const handleAddJars = async () => {
    if (!settingsModal || !addingJarFiles.length) return;
    setAddingJars(true);
    setError('');
    try {
      const updated = await modApi.addFiles(settingsModal.id, addingJarFiles, {
        javaFiles: addingJarMeta.map((item, index) => ({
          name: addingJarFiles[index]?.name || item.name,
          loader: item.loader,
          minecraftVersions: String(item.minecraftVersions || '').split(/[,;]/).map((part) => part.trim()).filter(Boolean),
          environment: item.environment || 'unknown',
        })),
      });
      setSettingsModal(updated.data);
      setAddingJarFiles([]);
      setAddingJarMeta([]);
      if (addJarInputRef.current) addJarInputRef.current.value = '';
      await loadMods();
      setSuccess('Jar files added');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to add jar files');
    } finally {
      setAddingJars(false);
    }
  };

  const requestDeleteJar = (file) => {
    setFileDeleteModal({
      file,
      servers: file.usedBy || [],
      inUse: Boolean(file.inUse || (file.usedBy || []).length),
    });
  };

  const performDeleteJar = async (uninstallFromAll) => {
    if (!settingsModal || !fileDeleteModal) return;
    setDeleting(true);
    setError('');
    try {
      const result = await modApi.deleteFile(settingsModal.id, {
        sha256: fileDeleteModal.file.sha256,
        name: fileDeleteModal.file.name,
        uninstallFromAll,
      });
      setFileDeleteModal(null);
      if (!result.data?.id) {
        setSettingsModal(null);
        setSuccess('Mod deleted from the library');
      } else {
        setSettingsModal(result.data);
        setSuccess('Jar removed from this mod');
      }
      await loadMods();
      await refresh();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      if (err.response?.status === 409) {
        setFileDeleteModal((current) => current ? {
          ...current,
          inUse: true,
          servers: err.response.data?.servers || current.servers,
        } : current);
        setError(err.response?.data?.error || 'This file is in use on a server');
      } else {
        setError(err.response?.data?.error || err.message);
      }
    } finally {
      setDeleting(false);
    }
  };

  const filteredMods = mods.filter(mod => {
    const matchesSearch = !search || mod.name.toLowerCase().includes(search.toLowerCase());
    const matchesType = filterType === 'all' || mod.type === filterType;
    const matchesEdition = modMatchesLibraryFilter(mod, filterEdition, filterAvailability);
    return matchesSearch && matchesType && matchesEdition;
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

  const libraryEditionOptions = libraryFilterOptions(filterAvailability);
  const allowedLibraryFilters = libraryFilterAllowedIds(filterAvailability);
  const libraryEditionValue = allowedLibraryFilters.has(filterEdition) ? filterEdition : 'all';

  useEffect(() => {
    if (!allowedLibraryFilters.has(filterEdition)) {
      setFilterEdition('all');
      setPage(1);
    }
  }, [filterEdition, filterAvailability]);

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

  const compatibleInstallTargets = installModal
    ? servers.filter((server) => {
      if (server.kind === 'bedrock_connect' || server.kind === 'remote') return false;
      const installed = (server.installedModIds || []).map(Number);
      if (installed.includes(Number(installModal.id))) return false;
      return isModCompatibleWithServer(installModal, server, { loaders: javaProviders });
    })
    : [];

  const incompatibleInstallTargets = installModal && isJavaLibraryMod(installModal) && !isClientOnlyOnly(installModal)
    ? servers.filter((server) => {
      if (!isEligibleJavaInstallTarget(server, { loaders: javaProviders })) return false;
      const installed = (server.installedModIds || []).map(Number);
      if (installed.includes(Number(installModal.id))) return false;
      if (isModCompatibleWithServer(installModal, server, { loaders: javaProviders })) return false;
      const reasons = incompatibilityReasonCodes(installModal, server);
      return canOverrideCompatibility(reasons);
    })
    : [];

  const installTargets = showIncompatibleServers
    ? [...compatibleInstallTargets, ...incompatibleInstallTargets]
    : compatibleInstallTargets;

  const canShowIncompatible = Boolean(
    installModal
    && isJavaLibraryMod(installModal)
    && (canOverrideCompatibilityPerm || servers.some((server) => serverCapability(server, 'modsOverrideCompatibility', false)))
    && incompatibleInstallTargets.length
  );

  const requestInstall = (server, incompatible) => {
    if (!incompatible) {
      handleInstall(installModal.id, server.id);
      return;
    }
    const canOverride = serverCapability(server, 'modsOverrideCompatibility', canOverrideCompatibilityPerm);
    if (!canOverride) {
      setInstallError('You do not have permission to override Java mod compatibility on this server.');
      return;
    }
    const needsFile = needsJarSelection(installModal, server, { loaders: javaProviders });
    setOverrideConfirm({
      server,
      needsFile,
      files: candidateInstallFiles(installModal),
      reasons: incompatibilityReasonCodes(installModal, server),
    });
    setInstallFileSha(needsFile ? '' : (candidateInstallFiles(installModal)[0]?.sha256 || ''));
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
          {canUpload && (
            <button
              onClick={() => {
                setUploadProgress(null);
                setUploadEdition('bedrock');
                setUploadJavaMeta([]);
                setShowUploadModal(true);
              }}
              className="btn btn-primary"
            >
              <Upload className="w-4 h-4" />
              Upload Mod
            </button>
          )}
          {canImportCurseforge && (
            <button
              onClick={openCurseforgeModal}
              className="btn btn-primary"
            >
              <Download className="w-4 h-4" />
              Download CurseForge URL
            </button>
          )}
          {canImportMcpedl && (
            <button
              onClick={openMcpedlModal}
              className="btn btn-primary"
            >
              <Download className="w-4 h-4" />
              Download MCPEDL URL
            </button>
          )}

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
            <option value="mod">Java mods</option>
          </select>
          <select
            aria-label="Edition"
            value={libraryEditionValue}
            onChange={(e) => {
              setFilterEdition(e.target.value);
              setPage(1);
            }}
            className="input w-40"
          >
            {libraryEditionOptions.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
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
            {canUpload && (
              <button
                onClick={() => {
                  setUploadProgress(null);
                  setShowUploadModal(true);
                }}
                className="btn btn-primary"
              >
                <Upload className="w-4 h-4" /> Upload Mod
              </button>
            )}
            {canImportCurseforge && (
              <button onClick={openCurseforgeModal} className="btn btn-primary">
                <Download className="w-4 h-4" /> Download CurseForge URL
              </button>
            )}
            {canImportMcpedl && (
              <button onClick={openMcpedlModal} className="btn btn-primary">
                <Download className="w-4 h-4" /> Download MCPEDL URL
              </button>
            )}
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
                onInstall={canInstall ? () => openInstallModal(mod) : undefined}
                installDisabled={!canInstall || (isJavaLibraryMod(mod) && javaProviders.length === 0)}
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
            onInstall={canInstall ? () => openInstallModal(expandedMod) : undefined}
            installDisabled={!canInstall || (isJavaLibraryMod(expandedMod) && javaProviders.length === 0)}
            onSettings={canChangeSettings ? () => openSettings(expandedMod) : undefined}
            onDelete={canDelete ? () => handleDelete(expandedMod) : undefined}
            getTypeBadge={getTypeBadge}
            getSourceBadge={getSourceBadge}
          />
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4">
          <div className="card max-w-lg w-full animate-slide-up max-h-[90vh] overflow-y-auto">
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
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Edition</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setUploadEdition('bedrock');
                      setUploadFiles([]);
                      setUploadJavaMeta([]);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    disabled={uploading}
                    className={`btn w-full ${uploadEdition === 'bedrock' ? 'btn-primary' : 'btn-secondary'}`}
                  >
                    Bedrock
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setUploadEdition('java');
                      setUploadFiles([]);
                      setUploadJavaMeta([]);
                      setUploadType('mod');
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    disabled={uploading}
                    className={`btn w-full ${uploadEdition === 'java' ? 'btn-primary' : 'btn-secondary'}`}
                  >
                    Java
                  </button>
                </div>
              </div>

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
                <p className="text-xs text-mc-textMuted mt-1">
                  {uploadEdition === 'java'
                    ? '.jar, .zip — launcher and Minecraft version come from each file or the fields below.'
                    : '.mcpack, .mcaddon, .mcworld, .mctemplate, .mcstructure, .zip'}
                </p>
                <p className="text-xs text-mc-textMuted mt-1">Multiple archives are stored as one library mod.</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={uploadEdition === 'java' ? '.jar,.zip' : '.mcpack,.mcaddon,.mcworld,.zip,.mctemplate,.mcstructure'}
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </div>

              {uploadEdition === 'java' && uploadFiles.length > 0 && (
                <JavaFileMetaFields
                  files={uploadFiles}
                  meta={uploadJavaMeta}
                  onChange={setUploadJavaMeta}
                  javaProviders={javaProviders}
                  disabled={uploading}
                />
              )}

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

              {uploadEdition !== 'java' && (
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
                    {uploadProgress == null
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
                  If the project has more than one file type, the latest of each is saved as one library mod.
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

      {/* Delete from library */}
      {deleteModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[80] p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">
                {deleteModal.servers.length ? 'Remove installed mod' : 'Delete mod'}
              </h3>
              <button
                onClick={() => setDeleteModal(null)}
                disabled={deleting}
                className="p-1 hover:bg-mc-surfaceLight rounded disabled:opacity-30"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {deleteModal.servers.length ? (
              <>
                <p className="text-sm text-mc-textMuted mb-3">
                  This mod is in use on {deleteModal.servers.length}{' '}
                  {deleteModal.servers.length === 1 ? 'server' : 'servers'} and may be a required dependency:
                </p>
                <ul className="mb-4 space-y-1 max-h-40 overflow-y-auto">
                  {deleteModal.servers.map((server) => (
                    <li key={server.id} className="text-sm text-white flex items-center gap-2">
                      <Server className="w-4 h-4 text-mc-textMuted flex-shrink-0" />
                      {server.name}
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-mc-textMuted mb-4">
                  Deleting it removes the mod from those servers and from the library.
                </p>
              </>
            ) : (
              <p className="text-sm text-mc-textMuted mb-4">
                Delete <strong className="text-white">{deleteModal.mod.name}</strong> from the mod library?
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={() => performDelete(deleteModal.mod.id, deleteModal.servers.length > 0)}
                disabled={deleting}
                className="btn btn-primary flex-1"
              >
                {deleting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Removing...
                  </>
                ) : (
                  'Delete'
                )}
              </button>
              <button
                onClick={() => setDeleteModal(null)}
                disabled={deleting}
                className="btn btn-secondary"
              >
                Cancel
              </button>
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

            {canShowIncompatible && (
              <label className="flex items-center gap-2 text-sm text-mc-text mb-3">
                <input
                  type="checkbox"
                  checked={showIncompatibleServers}
                  onChange={(e) => setShowIncompatibleServers(e.target.checked)}
                  disabled={installing}
                />
                Show incompatible servers
              </label>
            )}

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
              {installTargets.length === 0 ? (
                <p className="text-sm text-mc-textMuted text-center py-4">
                  {servers.some((server) => server.kind !== 'bedrock_connect' && server.kind !== 'remote')
                    ? (isJavaLibraryMod(installModal)
                      ? 'No servers with a compatible Minecraft version and launcher.'
                      : 'This pack is already installed on every compatible server.')
                    : 'No gameplay servers available'}
                </p>
              ) : (
                installTargets.map(server => {
                  const isTarget = installing && installingServerId === server.id;
                  const incompatible = !isModCompatibleWithServer(installModal, server, { loaders: javaProviders });
                  const reasons = incompatible ? incompatibilityReasonCodes(installModal, server) : [];
                  return (
                    <button
                      key={server.id}
                      onClick={() => requestInstall(server, incompatible)}
                      disabled={installing}
                      className={`w-full flex items-center gap-3 p-3 bg-mc-darker rounded-lg text-left transition-colors ${
                        installing && !isTarget
                          ? 'opacity-40 cursor-not-allowed'
                          : installing
                            ? 'border border-yellow-500/40 cursor-not-allowed'
                            : 'hover:bg-mc-surfaceLight'
                      } ${incompatible ? 'border border-yellow-500/40' : ''}`}
                    >
                      <Server className="w-4 h-4 text-mc-textMuted" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-white">{server.name}</p>
                        <p className="text-xs text-mc-textMuted">
                          {isTarget ? 'Installing…' : `Port ${server.port} • ${server.status}`}
                        </p>
                        {incompatible && (
                          <p className="text-xs text-yellow-300 mt-1 flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            {incompatibilityReasonLabel(reasons)}
                          </p>
                        )}
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
              onClick={() => { setInstallModal(null); setOverrideConfirm(null); }}
              disabled={installing}
              className="btn btn-secondary w-full disabled:opacity-30"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {overrideConfirm && installModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[80] p-4">
          <div className="card max-w-lg w-full animate-slide-up">
            <h3 className="text-lg font-semibold text-white mb-2">Compatibility could not be confirmed.</h3>
            <p className="text-sm text-mc-textMuted mb-3">
              This mod may prevent the server from starting. Verify the Minecraft version, loader, dependencies, and selected JAR before continuing.
            </p>
            <p className="text-sm text-mc-text mb-3">
              Server: <strong className="text-white">{overrideConfirm.server.name}</strong>. Mod:{' '}
              <strong className="text-white">{installModal.name}</strong>.
            </p>
            {overrideConfirm.needsFile && (
              <div className="space-y-2 mb-4 max-h-56 overflow-y-auto">
                {overrideConfirm.files.map((file) => (
                  <label key={file.sha256 || file.name} className="flex items-start gap-2 p-2 bg-mc-darker rounded-lg text-sm">
                    <input
                      type="radio"
                      name="override-jar"
                      checked={installFileSha === file.sha256}
                      onChange={() => setInstallFileSha(file.sha256)}
                    />
                    <span>
                      <span className="text-white block">{file.name}</span>
                      <span className="text-xs text-mc-textMuted">
                        {[file.version, loaderDisplayName(file.loader) || file.loader, (file.minecraftVersions || []).join(', '), file.environment]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button
                className="btn btn-secondary flex-1"
                disabled={installing}
                onClick={() => setOverrideConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary flex-1"
                disabled={installing || (overrideConfirm.needsFile && !installFileSha)}
                onClick={() => handleInstall(installModal.id, overrideConfirm.server.id, {
                  override: true,
                  fileSha256: installFileSha || undefined,
                })}
              >
                Install anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4">
          <div className="card max-w-lg w-full animate-slide-up max-h-[90vh] overflow-y-auto">
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
                      className="w-full h-36 object-contain object-center rounded-lg mb-2"
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

              {isJavaLibraryMod(settingsModal) && (
                <div>
                  <label className="block text-sm font-medium text-mc-text mb-2">Downloaded jars</label>
                  <ul className="space-y-2">
                    {(settingsModal.files || []).map((file) => {
                      const inUse = Boolean(file.inUse || (file.usedBy || []).length);
                      return (
                        <li key={file.sha256 || file.path || file.name} className="flex items-center gap-2 p-2 bg-mc-darker rounded-lg">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white truncate">{file.name}</p>
                            <p className="text-xs text-mc-textMuted">
                              {loaderDisplayName(file.loader) || file.loader || 'unknown'}
                              {(file.minecraftVersions || []).length ? ` • ${(file.minecraftVersions || []).join(', ')}` : ''}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => requestDeleteJar(file)}
                            className="p-2 rounded transition-colors"
                            title={inUse ? 'This jar is installed on a server' : 'Delete this jar'}
                            aria-label={`Delete ${file.name}`}
                          >
                            <Trash2 className={`w-4 h-4 ${inUse ? 'text-orange-400' : 'text-red-400'}`} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="mt-3 space-y-2">
                    <button
                      type="button"
                      onClick={() => addJarInputRef.current?.click()}
                      className="btn btn-secondary w-full text-sm"
                      disabled={addingJars}
                    >
                      <Plus className="w-4 h-4" />
                      Add jar files
                    </button>
                    <input
                      ref={addJarInputRef}
                      type="file"
                      multiple
                      accept=".jar,.zip"
                      className="hidden"
                      onChange={handleAddJarSelect}
                    />
                    {addingJarFiles.length > 0 && (
                      <>
                        <JavaFileMetaFields
                          files={addingJarFiles}
                          meta={addingJarMeta}
                          onChange={setAddingJarMeta}
                          javaProviders={javaProviders}
                          disabled={addingJars}
                        />
                        <button
                          type="button"
                          onClick={handleAddJars}
                          disabled={addingJars}
                          className="btn btn-primary w-full text-sm"
                        >
                          {addingJars ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                          {addingJars ? 'Adding...' : `Add ${addingJarFiles.length} file${addingJarFiles.length === 1 ? '' : 's'}`}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}

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

      {fileDeleteModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[90] p-4">
          <div className="card max-w-md w-full animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">
                {fileDeleteModal.inUse ? 'Jar is in use' : 'Delete jar'}
              </h3>
              <button
                onClick={() => setFileDeleteModal(null)}
                disabled={deleting}
                className="p-1 hover:bg-mc-surfaceLight rounded disabled:opacity-30"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {fileDeleteModal.inUse ? (
              <>
                <p className="text-sm text-mc-textMuted mb-3">
                  <strong className="text-white">{fileDeleteModal.file.name}</strong> is installed on{' '}
                  {fileDeleteModal.servers.length} {fileDeleteModal.servers.length === 1 ? 'server' : 'servers'}:
                </p>
                <ul className="mb-4 space-y-1 max-h-40 overflow-y-auto">
                  {fileDeleteModal.servers.map((server) => (
                    <li key={server.id} className="text-sm text-white flex items-center gap-2">
                      <Server className="w-4 h-4 text-mc-textMuted flex-shrink-0" />
                      {server.name}
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-mc-textMuted mb-4">
                  Deleting it removes the file from those Java servers. If a server required this dependency, the next start will show the missing-dependency prompt.
                </p>
              </>
            ) : (
              <p className="text-sm text-mc-textMuted mb-4">
                Remove <strong className="text-white">{fileDeleteModal.file.name}</strong> from this library mod?
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={() => performDeleteJar(Boolean(fileDeleteModal.inUse || fileDeleteModal.servers.length))}
                disabled={deleting}
                className="btn btn-primary flex-1"
              >
                {deleting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Removing...
                  </>
                ) : (
                  'Delete'
                )}
              </button>
              <button
                onClick={() => setFileDeleteModal(null)}
                disabled={deleting}
                className="btn btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function JavaFileMetaFields({ files, meta, onChange, javaProviders = [], disabled = false }) {
  return (
    <div className="space-y-3 max-h-64 overflow-y-auto">
      {files.map((file, index) => {
        const row = meta[index] || { loader: '', minecraftVersions: '', environment: 'unknown' };
        const update = (patch) => {
          const next = meta.slice();
          next[index] = { ...row, name: file.name, ...patch };
          onChange(next);
        };
        return (
          <div key={`${file.name}-${index}`} className="p-3 bg-mc-darker rounded-lg space-y-2">
            <p className="text-xs text-white break-all">{file.name}</p>
            <label className="block text-xs text-mc-textMuted">Launcher</label>
            <select
              value={row.loader}
              onChange={(e) => update({ loader: e.target.value })}
              disabled={disabled}
              className="input text-sm"
            >
              <option value="">Detect from file</option>
              {javaProviders.filter((item) => item.id !== 'vanilla' && item.supportsMods !== false).map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
            <label className="block text-xs text-mc-textMuted">Minecraft versions</label>
            <input
              type="text"
              value={row.minecraftVersions}
              onChange={(e) => update({ minecraftVersions: e.target.value })}
              disabled={disabled}
              className="input text-sm"
              placeholder="1.21.1, 1.21.4"
            />
            <label className="block text-xs text-mc-textMuted">Environment</label>
            <select
              value={row.environment || 'unknown'}
              onChange={(e) => update({ environment: e.target.value })}
              disabled={disabled}
              className="input text-sm"
            >
              <option value="unknown">Unknown / detect</option>
              <option value="both">Client and server</option>
              <option value="server">Server</option>
              <option value="client">Client</option>
            </select>
          </div>
        );
      })}
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

function environmentBadge(mod) {
  if (!isJavaLibraryMod(mod)) return null;
  const env = String(mod.environment || 'unknown').toLowerCase();
  const label = env === 'client'
    ? 'Client'
    : env === 'server'
      ? 'Server'
      : env === 'both'
        ? 'Both'
        : 'Unknown';
  const color = env === 'client'
    ? 'badge-warning'
    : env === 'server'
      ? 'badge-success'
      : env === 'both'
        ? 'badge-info'
        : 'badge-muted';
  return <span className={`badge ${color}`}>{label}</span>;
}

function extraArchiveNames(mod) {
  if (Array.isArray(mod?.files) && mod.files.length) {
    return mod.files.slice(1).map((item) => item.name).filter(Boolean);
  }
  if (!mod?.extra_files) return [];
  try {
    const parsed = typeof mod.extra_files === 'string' ? JSON.parse(mod.extra_files) : mod.extra_files;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => item?.name || (item?.path ? String(item.path).split(/[\\/]/).pop() : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
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
  installDisabled = false,
  onSettings,
  onDelete,
  getTypeBadge,
  getSourceBadge,
}) {
  const thumb = libraryThumbnailSrc(mod);
  const sizeLabel = Number.isFinite(mod.file_size)
    ? `${(mod.file_size / 1024).toFixed(1)} KB`
    : '';
  const extraNames = extraArchiveNames(mod);
  const primaryName = mod.file_path ? String(mod.file_path).split(/[\\/]/).pop() : '';
  const archiveNames = [primaryName, ...extraNames].filter(Boolean);

  return (
    <div
      className={`card hover:border-mc-accent/30 transition-all duration-200 group ${
        expanded
          ? 'relative max-w-2xl w-full max-h-[90vh] overflow-y-auto animate-slide-up'
          : 'cursor-pointer h-full flex flex-col'
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

      <div className={`bg-mc-darker rounded-lg mb-2 overflow-hidden ${expanded ? 'aspect-[16/9]' : 'aspect-video'}`}>
        {thumb ? (
          <img
            src={thumb}
            alt={mod.name}
            className="mod-thumbnail-img"
            loading="lazy"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Package className={`${expanded ? 'w-12 h-12' : 'w-8 h-8'} text-mc-textMuted`} />
          </div>
        )}
      </div>
      <ModTileTags expanded={expanded}>
        {getTypeBadge(mod.type)}
        {getSourceBadge(mod.source)}
        {isJavaLibraryMod(mod) && <span className="badge badge-warning">Java</span>}
        {environmentBadge(mod)}
        {modLoaderIds(mod).map((id) => (
          loaderDisplayName(id) ? <span key={id} className="badge badge-info">{loaderDisplayName(id)}</span> : null
        ))}
        {modVersionTags(mod).map((version) => (
          <span key={version} className="badge badge-success">{version}</span>
        ))}
      </ModTileTags>

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
        {expanded && <span>v{mod.version || '1.0.0'}</span>}
        {sizeLabel && <span>{sizeLabel}</span>}
        {expanded
          ? archiveNames.length > 1 && <span>{archiveNames.length} files</span>
          : archiveNames.length > 0 && (
            <span>{archiveNames.length} {archiveNames.length === 1 ? 'file' : 'files'}</span>
          )}
        {expanded && mod.downloaded_at && (
          <span>Added {new Date(mod.downloaded_at).toLocaleDateString()}</span>
        )}
      </div>
      {expanded && archiveNames.length > 1 && (
        <ul className="text-xs text-mc-textMuted mb-3 space-y-1">
          {archiveNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}

      <div className={`flex items-center gap-2 ${expanded ? '' : 'mt-auto'}`} onClick={(event) => event.stopPropagation()}>
        {onInstall && (
          <button
            onClick={installDisabled ? undefined : onInstall}
            disabled={installDisabled}
            className={`btn flex-1 ${expanded ? '' : 'text-xs'} ${
              installDisabled ? 'btn-client-only' : 'btn-primary'
            }`}
          >
            {installDisabled ? (
              'No launcher available'
            ) : (
              <>
                <Plus className={expanded ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
                Install
              </>
            )}
          </button>
        )}
        {expanded && onSettings && (
          <button onClick={onSettings} className="btn btn-secondary" title="Mod settings">
            <Settings className="w-4 h-4" />
          </button>
        )}
        {expanded && onDelete && (
          <button onClick={onDelete} className="btn btn-secondary text-mc-danger hover:bg-red-500/20" title="Delete from library">
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

export default ModLibrary;
