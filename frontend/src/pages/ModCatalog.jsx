import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { modApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import ModTileTags from '../components/ModTileTags';
import CatalogVersionFilter from '../components/CatalogVersionFilter';
import { loaderDisplayName, modLoaderIds, modVersionTags } from '../utils/modCompatibility';
import {
  EMPTY_FILTER_AVAILABILITY,
  parseFilterAvailability,
  reconcileCatalogQuery,
} from '../utils/catalogFilters';
import { useGitCatalogSync } from '../hooks/useGitCatalogSync';
import { useApi } from '../context/ApiContext';
import {
  ArrowLeft, Search, Download, Package, AlertCircle, Check, Loader2,
  ExternalLink, Star, GitBranch, RefreshCw, X, Folder
} from 'lucide-react';

const CATALOG_PAGE_SIZE = 40;
const DOWNLOAD_ALL_CONFIRM_AFTER = 10;
const EDITION_LABELS = {
  bedrock: 'Bedrock',
  java: 'Java',
};

function sourceValue(provider) {
  return provider.id === 'curseforge-bedrock' ? 'curseforge' : provider.id;
}

function reconcileCatalogFilters({
  providers = [],
  availability = EMPTY_FILTER_AVAILABILITY,
  source = 'all',
  edition = 'all',
  category = '',
  loader = '',
  environment = 'all',
} = {}) {
  const ids = new Set((providers || []).map((item) => item.id));
  let nextSource = source || 'all';
  let nextCategory = category || '';
  const sourceId = nextSource === 'curseforge' ? 'curseforge-bedrock' : nextSource;
  if (nextSource !== 'all' && !ids.has(sourceId)) {
    nextSource = 'all';
    nextCategory = '';
  }
  if (nextSource === 'all' && String(nextCategory).includes(':')) {
    nextCategory = '';
  } else if (nextSource !== 'all') {
    const sourcePrefix = `${sourceId}:`;
    if (nextCategory.includes(':') && !String(nextCategory).startsWith(sourcePrefix)) {
      nextCategory = '';
    }
  }
  const next = reconcileCatalogQuery({
    source: nextSource,
    edition,
    category: nextCategory,
    loader,
    environment,
  }, availability);
  const changed = next.source !== (source || 'all')
    || next.edition !== (edition || 'all')
    || next.category !== (category || '')
    || next.loader !== (loader || '')
    || next.environment !== (environment || 'all');
  return { ...next, changed };
}

function isClientOnlyProject(mod) {
  return Boolean(mod && mod.downloadState === 'blocked' && mod.blockedReason === 'client-only');
}

function sameCatalogMod(a, b) {
  if (!a || !b) return false;
  if (a.curseforgeId && a.curseforgeId === b.curseforgeId && (a.providerId || a.source) === (b.providerId || b.source)) {
    return true;
  }
  if (a.providerId && a.providerId === b.providerId && a.slug && a.slug === b.slug) return true;
  return Boolean(a.id && a.id === b.id && a.source === b.source);
}

function selectableCatalogFiles(files = []) {
  return files.filter((file) => file.downloadable !== false);
}

function defaultSelectedCatalogFileIds() {
  return [];
}

function installedCatalogVersions(servers) {
  const seen = new Set();
  const out = [];
  for (const server of servers || []) {
    if (server.kind === 'remote' || server.kind === 'bedrock_connect') continue;
    const edition = server.kind === 'java' ? 'java' : 'bedrock';
    const version = server.minecraftVersion || server.minecraft_version || server.version;
    if (!version || version === 'N/A') continue;
    const key = `${version}|${edition}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ version, edition, key });
  }
  out.sort((a, b) => {
    const ver = String(b.version).localeCompare(String(a.version), undefined, { numeric: true });
    if (ver) return ver;
    return a.edition.localeCompare(b.edition);
  });
  return out;
}

function gameVersionsParam(allSelected, selectedKeys) {
  if (allSelected || !selectedKeys.length) return '';
  return selectedKeys.map((key) => {
    const [version, edition] = String(key).split('|');
    return edition ? `${version}:${edition}` : version;
  }).join(',');
}

function isJavaCatalogMod(mod) {
  return Boolean(mod && (
    mod.edition === 'java'
    || mod.providerId === 'curseforge-java'
    || mod.providerId === 'modrinth-java'
  ));
}

function fileEnvironmentLabel(file) {
  if (file.environmentLabel) return file.environmentLabel;
  if (file.environment === 'client') return 'Client Side Only';
  if (file.environment === 'server') return 'Server';
  if (file.environment === 'both') return 'Client and server';
  if (file.environment === 'unknown') return 'Compatibility Unknown';
  return '';
}

function tileEnvironmentLabel(mod) {
  if (mod.environmentLabel) return mod.environmentLabel;
  if (mod.environment === 'client') return 'Client';
  if (mod.environment === 'server') return 'Server';
  if (mod.environment === 'both') return 'Both';
  if (mod.environment === 'unknown') return 'Unknown';
  return '';
}

function ModCatalog() {
  const navigate = useNavigate();
  const { can } = useAuth();

  const { servers } = useApi();

  const [mods, setMods] = useState([]);
  const [categories, setCategories] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [success, setSuccess] = useState('');
  const [sources, setSources] = useState({ curseforge: { available: false }, git: { available: false }, file: { available: false } });
  const [providers, setProviders] = useState([]);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [source, setSource] = useState('all');
  const [edition, setEdition] = useState('all');
  const [versionAll, setVersionAll] = useState(true);
  const [selectedVersionKeys, setSelectedVersionKeys] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [sortBy, setSortBy] = useState('relevancy');
  const [loader, setLoader] = useState('');
  const [environment, setEnvironment] = useState('all');
  const [filterAvailability, setFilterAvailability] = useState(EMPTY_FILTER_AVAILABILITY);
  const [downloadModal, setDownloadModal] = useState(null);
  const [filePicker, setFilePicker] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [confirmDownloadAll, setConfirmDownloadAll] = useState(null);
  const [multiFileMode, setMultiFileMode] = useState('manual');
  const [downloading, setDownloading] = useState(false);
  const [expandedMod, setExpandedMod] = useState(null);
  const { status, startSync } = useGitCatalogSync();
  const wasSyncing = useRef(false);
  const filtersRef = useRef({ source: 'all', edition: 'all', category: '', gameVersions: '', loader: '', environment: 'all' });
  const queryRef = useRef({ q: '', sortBy: 'relevancy' });
  const installedVersions = installedCatalogVersions(servers);
  const gameVersions = gameVersionsParam(versionAll, selectedVersionKeys);
  filtersRef.current = { source, edition, category, gameVersions, loader, environment };
  queryRef.current = { q: search, sortBy };

  const availableEditions = (filterAvailability.editions || []).map((item) => item.id);
  const availableLoaders = filterAvailability.loaders || [];
  const javaHostingAvailable = Boolean(filterAvailability.javaHostingAvailable);

  useEffect(() => {
    loadMultiFileMode();
    refreshProviders({ search: true });
  }, []);

  useEffect(() => {
    const onPluginsChanged = () => {
      refreshProviders({ search: true });
    };
    window.addEventListener('mbm-plugins-changed', onPluginsChanged);
    return () => window.removeEventListener('mbm-plugins-changed', onPluginsChanged);
  }, []);

  useEffect(() => {
    if (wasSyncing.current && !status.running) {
      loadCategories();
      searchMods(page, source, edition, category);
      if (status.error) {
        setError(status.error);
      } else if (status.lastSync) {
        setSuccess(`Git catalog synced (${status.modCount || 0} mods)`);
        setTimeout(() => setSuccess(''), 3000);
      }
    }
    wasSyncing.current = Boolean(status.running);
  }, [status.running]);

  const loadMultiFileMode = async () => {
    try {
      const res = await modApi.catalogMultiFileMode();
      if (res.data?.multiFileMode === 'auto' || res.data?.multiFileMode === 'manual') {
        setMultiFileMode(res.data.multiFileMode);
      }
    } catch {
      /* keep the default until settings load */
    }
  };

  const handleMultiFileMode = async (nextMode) => {
    const previous = multiFileMode;
    setMultiFileMode(nextMode);
    try {
      const res = await modApi.setCatalogMultiFileMode(nextMode);
      if (res.data?.multiFileMode === 'auto' || res.data?.multiFileMode === 'manual') {
        setMultiFileMode(res.data.multiFileMode);
      }
    } catch (err) {
      setMultiFileMode(previous);
      setError(err.response?.data?.error || err.message || 'Could not save multi-file handling');
    }
  };

  const refreshProviders = async ({ search = false } = {}) => {
    try {
      const res = await modApi.catalogProviders();
      const nextProviders = res.data?.providers || [];
      const nextAvailability = parseFilterAvailability(res.data?.filterAvailability);
      if (res.data?.sources) setSources(res.data.sources);
      setProviders(nextProviders);
      setFilterAvailability(nextAvailability);
      const current = filtersRef.current;
      const reconciled = reconcileCatalogFilters({
        providers: nextProviders,
        availability: nextAvailability,
        source: current.source,
        edition: current.edition,
        category: current.category,
        loader: current.loader,
        environment: current.environment,
      });
      filtersRef.current = { ...current, ...reconciled };
      if (reconciled.changed) {
        setSource(reconciled.source);
        setEdition(reconciled.edition);
        setCategory(reconciled.category);
        setLoader(reconciled.loader);
        setEnvironment(reconciled.environment);
      }
      setPage(1);
      if (search) {
        await loadCategories(reconciled.source, reconciled.edition);
        await searchMods(1, reconciled.source, reconciled.edition, reconciled.category);
      }
    } catch {
      setFilterAvailability(EMPTY_FILTER_AVAILABILITY);
      const nextEdition = filtersRef.current.edition === 'java' ? 'all' : filtersRef.current.edition;
      filtersRef.current = { ...filtersRef.current, edition: nextEdition, loader: '', environment: 'all' };
      setEdition(nextEdition);
      setLoader('');
      setEnvironment('all');
      if (search) {
        await loadCategories();
        await searchMods();
      }
    }
  };

  const loadCategories = async (requestedSource = source, requestedEdition = edition) => {
    try {
      const res = await modApi.catalogCategories({
        source: requestedSource,
        edition: requestedEdition,
        provider: requestedSource === 'all' || requestedSource === 'curseforge'
          ? (requestedSource === 'curseforge' ? 'curseforge-bedrock' : '')
          : requestedSource,
      });
      setCategories(res.data);
    } catch (err) {
      console.error('Failed to load categories:', err);
    }
  };

  const searchMods = async (
    requestedPage = page,
    requestedSource = source,
    requestedEdition = edition,
    requestedCategory = category
  ) => {
    setSearching(true);
    setError('');
    setWarning('');
    try {
      const provider = requestedSource === 'all'
        ? ''
        : requestedSource === 'curseforge'
          ? 'curseforge-bedrock'
          : requestedSource;
      const res = await modApi.catalogSearch({
        q: queryRef.current.q,
        category: requestedCategory,
        page: requestedPage,
        pageSize: CATALOG_PAGE_SIZE,
        sortBy: queryRef.current.sortBy,
        source: requestedSource,
        provider,
        edition: requestedEdition,
        gameVersions: filtersRef.current.gameVersions,
        loader: filtersRef.current.loader,
        environment: filtersRef.current.environment,
      });
      setMods(res.data.results || []);
      setTotal(Number(res.data.total) || 0);
      setSources(res.data.sources || sources);
      if (res.data.warning) setWarning(res.data.warning);
      const sourceErrors = (res.data.errors || []).filter(item => item.source !== 'curseforge' || requestedSource === 'curseforge' || requestedSource === 'curseforge-java');
      if (requestedSource !== 'all' && sourceErrors.length) {
        setError(sourceErrors.map(item => item.error).join(' '));
      } else if (requestedSource === 'all' && (res.data.results || []).length === 0 && (res.data.errors || []).length) {
        setError(res.data.errors.map(item => item.error).join(' '));
      }
    } catch (err) {
      setMods([]);
      setTotal(0);
      setError(err.response?.data?.error || 'Failed to load the catalog. Check catalog plugin settings.');
    } finally {
      setSearching(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    loadCategories(source, edition);
    searchMods(1, source, edition, category);
  };

  const handleRefresh = async () => {
    if (!status.canSync || status.running) return;
    setError('');
    try {
      await startSync();
    } catch (err) {
      const message = err.response?.data?.error || err.message || '';
      if (!/not enabled|missing a repository|access token/i.test(message)) {
        setError(message || 'Git catalog refresh failed');
      }
    }
  };

  const applyAvailability = (mod, availability) => {
    if (!mod || !availability) return mod;
    const next = {
      ...mod,
      downloadState: availability.downloadState || mod.downloadState,
      blockedReason: availability.blockedReason,
      availableFileCount: availability.availableFileCount,
      selectableFileCount: availability.selectableFileCount,
    };
    setMods((list) => list.map((item) => (sameCatalogMod(item, mod) ? next : item)));
    setExpandedMod((current) => (current && sameCatalogMod(current, mod) ? next : current));
    return next;
  };

  const openDownload = (mod) => {
    if (!mod || isClientOnlyProject(mod)) return;
    if (isJavaCatalogMod(mod)) {
      handleDownload(undefined, mod);
      return;
    }
    setDownloadModal(mod);
  };

  const handleDownload = async (files, explicitMod) => {
    const mod = explicitMod || filePicker?.mod || downloadModal;
    if (!mod || isClientOnlyProject(mod)) return;
    if (filePicker && (!files || files.length < 1)) {
      setError('Select at least one file to download');
      return;
    }
    setDownloading(true);
    setError('');
    try {
      const extra = isJavaCatalogMod(mod) ? {
        loader: filtersRef.current.loader,
        gameVersions: filtersRef.current.gameVersions,
        modrinthId: mod.modrinthId || mod.id,
      } : {};
      const res = await modApi.catalogDownload(mod, undefined, files, extra);
      if (res.data?.downloadState === 'blocked' && res.data?.blockedReason === 'client-only') {
        applyAvailability(mod, res.data);
        setDownloadModal(null);
        setFilePicker(null);
        setSelectedFiles([]);
        setWarning('All available Java files are marked client-only and cannot run on a dedicated server.');
        return;
      }
      if (res.data?.needsSelection) {
        const choices = res.data.files || [];
        const selectable = selectableCatalogFiles(choices);
        if (choices.length && selectable.length === 0) {
          applyAvailability(mod, {
            downloadState: 'blocked',
            blockedReason: 'client-only',
            availableFileCount: choices.length,
            selectableFileCount: 0,
          });
          setDownloadModal(null);
          setFilePicker(null);
          setSelectedFiles([]);
          setWarning('All available Java files are marked client-only and cannot run on a dedicated server.');
          return;
        }
        applyAvailability(mod, res.data);
        setFilePicker({ mod, files: choices, warning: res.data.warning });
        setSelectedFiles(defaultSelectedCatalogFileIds(choices));
        setDownloadModal(null);
        return;
      }
      const depCount = (res.data?.dependencies || []).length;
      setSuccess(res.data?.merged
        ? `"${mod.name}" files were added to the existing library mod.`
        : depCount
          ? `"${mod.name}" downloaded to mod library with ${depCount} required ${depCount === 1 ? 'dependency' : 'dependencies'}.`
          : `"${mod.name}" downloaded to mod library!`);
      setDownloadModal(null);
      setFilePicker(null);
      setSelectedFiles([]);
      setConfirmDownloadAll(null);
      setExpandedMod(null);
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setFilePicker(null);
      setDownloadModal(null);
      setSelectedFiles([]);
      setConfirmDownloadAll(null);
      setExpandedMod(null);
      setError(err.response?.data?.error || err.message || 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const requestDownloadAll = () => {
    if (!filePicker) return;
    const ids = selectableCatalogFiles(filePicker.files).map((file) => file.id);
    if (ids.length > DOWNLOAD_ALL_CONFIRM_AFTER) {
      setConfirmDownloadAll({ count: ids.length, fileIds: ids });
      return;
    }
    handleDownload(ids);
  };

  const togglePickedFile = (file) => {
    if (!file || file.downloadable === false) return;
    const id = file.id;
    setSelectedFiles((current) => (
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    ));
  };

  const getTypeBadge = (type) => {
    const colors = {
      addon: 'badge-info',
      texture_pack: 'badge-warning',
      world: 'badge-success',
      skin: 'badge-danger',
      mod: 'badge-info',
    };
    return <span className={`badge ${colors[type] || 'badge-info'}`}>{(type || 'addon').replace('_', ' ')}</span>;
  };

  const getSourceBadge = (modSource, fileKind, mod = {}) => {
    if (mod.providerId === 'modrinth-java' || modSource === 'modrinth') {
      return <span className="badge badge-success">Modrinth</span>;
    }
    if (mod.providerId === 'curseforge-java' || (mod.edition === 'java' && modSource === 'curseforge')) {
      return <span className="badge badge-info">CurseForge Java</span>;
    }
    if (modSource === 'git') {
      return <span className="badge badge-success">Git</span>;
    }
    if (modSource === 'file') {
      const label = fileKind === 'smb' ? 'SMB' : fileKind === 'nfs' ? 'NFS' : 'Local';
      return <span className="badge badge-warning">{label}</span>;
    }
    return <span className="badge badge-info">CurseForge Bedrock</span>;
  };

  const goToPage = (nextPage) => {
    const safePage = Math.max(1, nextPage);
    setPage(safePage);
    searchMods(safePage, source, edition, category);
  };

  const totalPages = Math.max(1, Math.ceil((total || 0) / CATALOG_PAGE_SIZE));
  const pageNumbers = visiblePageNumbers(page, totalPages);
  const showPager = totalPages > 1 || page > 1;

  const searchingLabel = source === 'git'
    ? 'Searching Git catalog...'
    : source === 'file'
      ? 'Searching file catalog...'
      : source === 'curseforge-java'
        ? 'Searching CurseForge Java...'
        : source === 'modrinth-java'
          ? 'Searching Modrinth...'
        : source === 'curseforge'
          ? 'Searching CurseForge Bedrock...'
          : 'Searching catalog...';

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="page-header flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-white">Mod Catalog</h1>
            <p className="text-mc-textMuted mt-1">Browse and download from CurseForge, Modrinth, Git, and file catalogs</p>
          </div>
        </div>
        <div className="page-header-actions flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={!status.canSync || status.running}
            className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors disabled:opacity-50 max-md:min-h-11 max-md:min-w-11 max-md:flex max-md:items-center max-md:justify-center"
            title={
              status.running
                ? 'Git catalog is syncing'
                : !status.canSync
                  ? 'Save Git catalog plugin settings with an access token to sync'
                  : 'Refresh Git catalog'
            }
          >
            <RefreshCw className={`w-5 h-5 ${status.running ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {warning && !error && (
        <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <p className="text-sm text-amber-300">{warning}</p>
          </div>
          <button onClick={() => navigate('/plugins')} className="btn btn-secondary text-xs">
            Open Plugins
          </button>
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-2">
          <Check className="w-4 h-4 text-green-400 flex-shrink-0" />
          <p className="text-sm text-green-400">{success}</p>
        </div>
      )}

      <form onSubmit={handleSearch} className="card mb-6">
        <div className="flex flex-col md:flex-row md:items-start gap-4">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mc-textMuted" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input pl-10"
                placeholder="Search for addons, mods, texture packs, maps..."
              />
            </div>
            {can('catalog.change_file_handling') && (
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 items-center mt-3">
              <span className="text-sm font-medium text-white whitespace-nowrap">Multi-file handling:</span>
              <button
                type="button"
                onClick={() => handleMultiFileMode(multiFileMode === 'auto' ? 'manual' : 'auto')}
                className="btn btn-secondary text-sm border-2 border-mc-accent w-[6.5rem] justify-center shrink-0 justify-self-start"
                title="Automatic mode downloads the latest file of each type"
              >
                {multiFileMode === 'auto' ? 'Auto' : 'Manual'}
              </button>
              <p className="col-span-2 text-xs text-mc-textMuted">
                Automatic mode may not download all required mod files
              </p>
            </div>
            )}
          </div>
          <div className="catalog-filter-grid">
            <select
              value={source}
              onChange={(e) => {
                const next = e.target.value;
                setSource(next);
                setPage(1);
                setCategory('');
                loadCategories(next, edition);
                searchMods(1, next, edition, '');
              }}
              className="input"
              aria-label="Source"
            >
              <option value="all">All Sources</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id === 'curseforge-bedrock' ? 'curseforge' : provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="input"
              aria-label="Category"
            >
              <option value="">All Categories</option>
              {categories.map(cat => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
            </select>
            <select
              id="catalog-edition"
              aria-label="Edition"
              value={availableEditions.includes(edition) || edition === 'all' ? edition : 'all'}
              onChange={(e) => {
                const next = e.target.value;
                const nextLoader = next === 'java' ? loader : '';
                const nextEnvironment = next === 'java' ? environment : 'all';
                setEdition(next);
                setLoader(nextLoader);
                setEnvironment(nextEnvironment);
                filtersRef.current = {
                  ...filtersRef.current,
                  edition: next,
                  loader: nextLoader,
                  environment: nextEnvironment,
                };
                setPage(1);
                setCategory('');
                loadCategories(source, next);
                searchMods(1, source, next, '');
              }}
              className="input"
            >
              <option value="all">All editions</option>
              {(filterAvailability.editions || []).map((item) => (
                <option key={item.id} value={item.id}>{item.name || EDITION_LABELS[item.id] || item.id}</option>
              ))}
            </select>
            <CatalogVersionFilter
              className="w-full min-w-0"
              versions={installedVersions}
              selectedKeys={selectedVersionKeys}
              allSelected={versionAll}
              onChange={({ allSelected, selectedKeys }) => {
                setVersionAll(allSelected);
                setSelectedVersionKeys(selectedKeys);
              }}
              onClose={() => {
                setPage(1);
                searchMods(1, source, edition, category);
              }}
            />
            {javaHostingAvailable && (
            <select
              aria-label="Loader"
              value={availableLoaders.some((item) => item.id === loader) ? loader : ''}
              onChange={(e) => {
                const next = e.target.value;
                const nextEdition = next ? 'java' : edition;
                setLoader(next);
                if (next) setEdition('java');
                filtersRef.current = { ...filtersRef.current, loader: next, edition: nextEdition };
                setPage(1);
                searchMods(1, source, nextEdition, category);
              }}
              className="input"
            >
              <option value="">All loaders</option>
              {availableLoaders.map((item) => (
                <option key={item.id} value={item.id}>{item.name || loaderDisplayName(item.id)}</option>
              ))}
            </select>
            )}
            {javaHostingAvailable && (
            <select
              aria-label="Environment"
              value={environment}
              onChange={(e) => {
                const next = e.target.value;
                setEnvironment(next);
                filtersRef.current = { ...filtersRef.current, environment: next };
                setPage(1);
                searchMods(1, source, edition, category);
              }}
              className="input"
            >
              <option value="all">All Environments</option>
              <option value="server-compatible">Server Compatible</option>
              <option value="server-only">Server Only</option>
              <option value="client-and-server">Client and Server</option>
              <option value="client-only">Client Only</option>
              <option value="unknown">Unknown</option>
            </select>
            )}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="input"
              aria-label="Sort"
            >
              <option value="relevancy">Relevancy</option>
              <option value="popularity">Popularity</option>
              <option value="lastUpdated">Recently Updated</option>
              <option value="totalDownloads">Most Downloaded</option>
            </select>
            <button type="submit" className="btn btn-primary catalog-filter-search justify-center" disabled={searching}>
              {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Search
            </button>
          </div>
        </div>
      </form>

      {searching ? (
        <div className="flex items-center justify-center py-16">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
            <p className="text-sm text-mc-textMuted">{searchingLabel}</p>
          </div>
        </div>
      ) : mods.length === 0 ? (
        <div className="card text-center py-16">
          <Package className="w-16 h-16 text-mc-textMuted mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-white mb-2">No mods found</h3>
          <p className="text-mc-textMuted mb-6">
            {sources.git?.available || sources.curseforge?.available || sources.file?.available || sources['curseforge-java'] || sources['modrinth-java']
              ? 'Try adjusting your search or filters'
              : 'Configure a Git repository, CurseForge API key, or enable a catalog plugin'}
          </p>
          <button onClick={() => navigate('/plugins')} className="btn btn-secondary">
            Open Plugins
          </button>
          {showPager && (
            <CatalogPager
              page={page}
              totalPages={totalPages}
              pageNumbers={pageNumbers}
              onPage={goToPage}
            />
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {mods.map((mod, idx) => (
              <ModTile
                key={mod.id || `${mod.source}-${mod.slug}-${idx}`}
                mod={mod}
                onOpen={() => setExpandedMod(mod)}
                onDownload={can('catalog.download_to_library') ? () => openDownload(mod) : null}

                getTypeBadge={getTypeBadge}
                getSourceBadge={(modSource, fileKind) => getSourceBadge(modSource, fileKind, mod)}
              />
            ))}
          </div>

          {showPager && (
            <CatalogPager
              page={page}
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
          <ModTile
            mod={expandedMod}
            expanded
            onClose={() => setExpandedMod(null)}
            onDownload={can('catalog.download_to_library') ? () => openDownload(expandedMod) : null}

            getTypeBadge={getTypeBadge}
            getSourceBadge={(modSource, fileKind) => getSourceBadge(modSource, fileKind, expandedMod)}
          />
        </div>
      )}

      {downloadModal && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4"
          onClick={() => { if (!downloading) setDownloadModal(null); }}
        >
          <div className="card max-w-sm w-full animate-slide-up" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Download Mod</h3>
            <p className="text-sm text-mc-textMuted mb-4">
              Download <strong className="text-white">{downloadModal.name}</strong> to your mod library
              {downloadModal.source === 'git'
                ? ' from the Git catalog'
                : downloadModal.source === 'file'
                  ? ' from the file catalog'
                  : downloadModal.providerId === 'modrinth-java' || downloadModal.source === 'modrinth'
                    ? ' from Modrinth'
                  : downloadModal.providerId === 'curseforge-java' || downloadModal.edition === 'java'
                    ? ' from CurseForge Java'
                    : ' from CurseForge Bedrock'}?
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => handleDownload()}
                disabled={downloading}
                className="btn btn-primary flex-1"
              >
                {downloading ? (
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
                onClick={() => setDownloadModal(null)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {filePicker && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70] p-4"
          onClick={() => {
            if (!downloading) {
              setFilePicker(null);
              setSelectedFiles([]);
            }
          }}
        >
          <div className="card max-w-3xl w-full animate-slide-up max-h-[90vh] overflow-y-auto" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Choose files to download</h3>
            <p className="text-sm text-mc-textMuted mb-3">
              <strong className="text-white">{filePicker.mod.name}</strong> includes more than one file.
              Select at least one. The newest file is not always compatible.
            </p>
            <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-300">
                {filePicker.warning
                  || 'Multiple files of the same type may cause unexpected behavior, the mod to malfunction, or the world not to start.'}
              </p>
            </div>
            <div className="space-y-2 mb-4">
              {filePicker.files.map((file) => {
                const blocked = file.downloadable === false;
                const envLabel = fileEnvironmentLabel(file);
                return (
                <label
                  key={file.id}
                  className={`flex items-start gap-3 p-3 bg-mc-darker rounded-lg ${blocked ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedFiles.includes(file.id)}
                    onChange={() => togglePickedFile(file)}
                    disabled={blocked}
                    aria-disabled={blocked}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-white break-all">{file.name}</span>
                    <span className="block text-xs text-mc-textMuted">
                      {file.displayName && file.displayName !== file.name ? `${file.displayName} • ` : ''}
                      {(file.type || 'file').replace('_', ' ')}
                      {file.extension ? ` • ${file.extension}` : ''}
                      {(file.minecraftVersions || []).length ? ` • Minecraft ${(file.minecraftVersions || []).join(', ')}` : ''}
                      {file.loader ? ` • ${file.loader === 'unknown' ? 'loader unknown' : file.loader}` : ''}
                      {file.fabric ? ' • Fabric' : ''}
                      {file.neoforge ? ' • NeoForge' : ''}
                      {envLabel ? ` • ${envLabel}` : ''}
                      {file.releaseType ? ` • ${file.releaseType}` : ''}
                      {file.date ? ` • ${new Date(file.date).toLocaleDateString()}` : ''}
                      {file.size ? ` • ${formatFileSize(file.size)}` : ''}
                    </span>
                    {blocked && file.environment === 'client' && (
                      <span className="block text-xs text-amber-300 mt-1">Cannot run on a dedicated server</span>
                    )}
                    {!blocked && file.warning && (
                      <span className="block text-xs text-amber-300 mt-1">{file.warning}</span>
                    )}
                  </span>
                </label>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => handleDownload(selectableCatalogFiles(filePicker.files).filter((file) => selectedFiles.includes(file.id)).map((file) => file.id))}
                disabled={
                  downloading
                  || selectableCatalogFiles(filePicker.files).filter((file) => selectedFiles.includes(file.id)).length < 1
                }
                className="btn btn-primary whitespace-nowrap shrink-0 min-w-[11rem]"
              >
                {downloading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Downloading...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    Download selected
                  </>
                )}
              </button>
              <button
                onClick={requestDownloadAll}
                disabled={downloading || selectableCatalogFiles(filePicker.files).length < 1}
                className="btn btn-secondary whitespace-nowrap shrink-0 min-w-[10rem]"
              >
                <Download className="w-4 h-4" />
                Download all
              </button>
              <button
                onClick={() => {
                  setFilePicker(null);
                  setSelectedFiles([]);
                  setConfirmDownloadAll(null);
                }}
                className="btn btn-secondary whitespace-nowrap shrink-0 min-w-[6rem]"
                disabled={downloading}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDownloadAll && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[80] p-4">
          <div className="card max-w-md w-full animate-slide-up" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Download many files?</h3>
            <p className="text-sm text-mc-textMuted mb-4">
              You are about to download {confirmDownloadAll.count} files. Are you sure you want to continue?
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                className="btn btn-primary whitespace-nowrap min-w-[7rem]"
                onClick={() => {
                  const ids = confirmDownloadAll.fileIds;
                  setConfirmDownloadAll(null);
                  handleDownload(ids);
                }}
                disabled={downloading}
              >
                Continue
              </button>
              <button
                type="button"
                className="btn btn-secondary whitespace-nowrap min-w-[7rem]"
                onClick={() => setConfirmDownloadAll(null)}
                disabled={downloading}
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

export default ModCatalog;

function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
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

function CatalogPager({ page, totalPages, pageNumbers, onPage }) {
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

function ModTile({ mod, expanded = false, onOpen, onClose, onDownload, getTypeBadge, getSourceBadge }) {
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
        {mod.thumbnail ? (
          <img
            src={mod.thumbnail}
            alt={mod.name}
            className="mod-thumbnail-img"
            loading="lazy"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {mod.source === 'git'
              ? <GitBranch className={`${expanded ? 'w-12 h-12' : 'w-8 h-8'} text-mc-textMuted`} />
              : mod.source === 'file'
                ? <Folder className={`${expanded ? 'w-12 h-12' : 'w-8 h-8'} text-mc-textMuted`} />
                : <Package className={`${expanded ? 'w-12 h-12' : 'w-8 h-8'} text-mc-textMuted`} />}
          </div>
        )}
      </div>
      <ModTileTags expanded={expanded}>
        {getTypeBadge(mod.type)}
        {getSourceBadge(mod.source, mod.fileKind, mod)}
        {mod.edition === 'java' && <span className="badge badge-warning">Java</span>}
        {isJavaCatalogMod(mod) && tileEnvironmentLabel(mod) && (
          <span className={`badge ${
            mod.environment === 'client' ? 'badge-warning'
              : mod.environment === 'server' ? 'badge-success'
                : mod.environment === 'unknown' ? 'badge-muted'
                  : 'badge-info'
          }`}
          >
            {tileEnvironmentLabel(mod)}
          </span>
        )}
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
        <span className="flex items-center gap-1">
          <Download className={expanded ? 'w-4 h-4' : 'w-3 h-3'} />
          {mod.downloads ? mod.downloads.toLocaleString() : '0'}
        </span>
        {mod.author && (
          <span className="flex items-center gap-1">
            <Star className={expanded ? 'w-4 h-4' : 'w-3 h-3'} />
            {mod.author}
          </span>
        )}
        {mod.license && (
          <span className="truncate" title={mod.license}>{mod.license}</span>
        )}
        {Number(mod.follows) > 0 && (
          <span>{Number(mod.follows).toLocaleString()} follows</span>
        )}
      </div>

      {expanded && isClientOnlyProject(mod) && (
        <div className="mb-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-300">
            All available Java files are marked client-only and cannot run on a dedicated server.
          </p>
        </div>
      )}

      <div className={`flex items-center gap-2 ${expanded ? '' : 'mt-auto'}`} onClick={(event) => event.stopPropagation()}>
        {onDownload && (isClientOnlyProject(mod) ? (
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="All available Java files are marked client-only and cannot run on a dedicated server."
            className={`btn btn-client-only flex-1 ${expanded ? '' : 'text-xs'}`}
          >
            Client Side Only
          </button>
        ) : (
          <button
            type="button"
            onClick={onDownload}
            className={`btn btn-primary flex-1 ${expanded ? '' : 'text-xs'}`}
          >
            <Download className={expanded ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
            Download
          </button>
        ))}
        {mod.websiteUrl && (
          <a
            href={mod.websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`btn btn-secondary ${expanded ? '' : 'text-xs p-2'}`}
            title={
              mod.source === 'git' ? 'View source'
                : mod.source === 'file' ? 'Open catalog folder'
                  : mod.source === 'modrinth' || mod.providerId === 'modrinth-java' ? 'View on Modrinth'
                    : 'View on CurseForge'
            }
          >
            <ExternalLink className={expanded ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
          </a>
        )}
      </div>
    </div>
  );
}
