import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { modApi } from '../services/api';
import {
  ArrowLeft, Search, Download, Package, AlertCircle, Check, Loader2,
  ExternalLink, Star, Settings, GitBranch, RefreshCw, X
} from 'lucide-react';

const CATALOG_PAGE_SIZE = 40;

function ModCatalog() {
  const navigate = useNavigate();
  const [mods, setMods] = useState([]);
  const [categories, setCategories] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [success, setSuccess] = useState('');
  const [sources, setSources] = useState({ curseforge: { available: false }, git: { available: false } });

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [source, setSource] = useState('all');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState('relevancy');
  const [downloadModal, setDownloadModal] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedMod, setExpandedMod] = useState(null);

  useEffect(() => {
    loadCategories();
    searchMods();
  }, []);

  const loadCategories = async () => {
    try {
      const res = await modApi.catalogCategories();
      setCategories(res.data);
    } catch (err) {
      console.error('Failed to load categories:', err);
    }
  };

  const searchMods = async (requestedPage = page, requestedSource = source) => {
    setSearching(true);
    setError('');
    setWarning('');
    try {
      const res = await modApi.catalogSearch({
        q: search,
        category,
        page: requestedPage,
        pageSize: CATALOG_PAGE_SIZE,
        sortBy,
        source: requestedSource,
      });
      setMods(res.data.results || []);
      setSources(res.data.sources || sources);
      if (res.data.warning) setWarning(res.data.warning);
      const sourceErrors = (res.data.errors || []).filter(item => item.source !== 'curseforge' || requestedSource === 'curseforge');
      if (requestedSource !== 'all' && sourceErrors.length) {
        setError(sourceErrors.map(item => item.error).join(' '));
      } else if (requestedSource === 'all' && (res.data.results || []).length === 0 && (res.data.errors || []).length) {
        setError(res.data.errors.map(item => item.error).join(' '));
      }
    } catch (err) {
      setMods([]);
      setError(err.response?.data?.error || 'Failed to load the catalog. Check Catalog Settings.');
    } finally {
      setSearching(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    searchMods(1, source);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      await modApi.syncGitCatalog();
      setSuccess('Git catalog synced');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      const message = err.response?.data?.error || err.message || '';
      if (!/not enabled|missing a repository/i.test(message)) {
        setError(message || 'Git catalog refresh failed');
      }
    }
    try {
      await loadCategories();
      await searchMods(page, source);
    } finally {
      setRefreshing(false);
    }
  };

  const handleDownload = async () => {
    const mod = downloadModal;
    if (!mod) return;
    setDownloading(true);
    try {
      await modApi.catalogDownload(mod);
      setSuccess(`"${mod.name}" downloaded to mod library!`);
      setDownloadModal(null);
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const getTypeBadge = (type) => {
    const colors = {
      addon: 'badge-info',
      texture_pack: 'badge-warning',
      world: 'badge-success',
      skin: 'badge-danger',
    };
    return <span className={`badge ${colors[type] || 'badge-info'}`}>{(type || 'addon').replace('_', ' ')}</span>;
  };

  const getSourceBadge = (modSource) => {
    if (modSource === 'git') {
      return <span className="badge badge-success">Git</span>;
    }
    return <span className="badge badge-info">CurseForge</span>;
  };

  const searchingLabel = source === 'git'
    ? 'Searching Git catalog...'
    : source === 'curseforge'
      ? 'Searching CurseForge...'
      : 'Searching catalog...';

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-white">Mod Catalog</h1>
            <p className="text-mc-textMuted mt-1">Browse and download from CurseForge and a Git catalog</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing || searching}
            className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors disabled:opacity-50"
            title="Refresh Git catalog"
          >
            <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => navigate('/mods/catalog/settings')}
            className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors"
            title="Catalog settings"
          >
            <Settings className="w-5 h-5" />
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
          <button onClick={() => navigate('/mods/catalog/settings')} className="btn btn-secondary text-xs">
            Open Settings
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
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mc-textMuted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-10"
              placeholder="Search for addons, texture packs, maps..."
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="input w-40"
            >
              <option value="all">All Sources</option>
              <option value="curseforge">CurseForge</option>
              <option value="git">Git Repository</option>
            </select>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="input w-40"
            >
              <option value="">All Categories</option>
              {categories.map(cat => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="input w-36"
            >
              <option value="relevancy">Relevancy</option>
              <option value="popularity">Popularity</option>
              <option value="lastUpdated">Recently Updated</option>
              <option value="totalDownloads">Most Downloaded</option>
            </select>
            <button type="submit" className="btn btn-primary" disabled={searching}>
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
            {sources.git?.available || sources.curseforge?.available
              ? 'Try adjusting your search or filters'
              : 'Configure a Git repository or CurseForge API key to populate the catalog'}
          </p>
          <button onClick={() => navigate('/mods/catalog/settings')} className="btn btn-secondary">
            <Settings className="w-4 h-4" /> Catalog Settings
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {mods.map((mod, idx) => (
              <ModTile
                key={mod.id || `${mod.source}-${mod.slug}-${idx}`}
                mod={mod}
                onOpen={() => setExpandedMod(mod)}
                onDownload={() => setDownloadModal(mod)}
                getTypeBadge={getTypeBadge}
                getSourceBadge={getSourceBadge}
              />
            ))}
          </div>

          <div className="flex items-center justify-center gap-3 mt-8">
            <button
              onClick={() => {
                const nextPage = Math.max(1, page - 1);
                setPage(nextPage);
                searchMods(nextPage, source);
              }}
              disabled={page <= 1}
              className="btn btn-secondary text-sm disabled:opacity-30"
            >
              Previous
            </button>
            <span className="text-sm text-mc-textMuted">Page {page}</span>
            <button
              onClick={() => {
                const nextPage = page + 1;
                setPage(nextPage);
                searchMods(nextPage, source);
              }}
              disabled={mods.length < CATALOG_PAGE_SIZE}
              className="btn btn-secondary text-sm disabled:opacity-30"
            >
              Next
            </button>
          </div>
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
            onDownload={() => setDownloadModal(expandedMod)}
            getTypeBadge={getTypeBadge}
            getSourceBadge={getSourceBadge}
          />
        </div>
      )}

      {downloadModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4">
          <div className="card max-w-sm w-full animate-slide-up">
            <h3 className="text-lg font-semibold text-white mb-2">Download Mod</h3>
            <p className="text-sm text-mc-textMuted mb-4">
              Download <strong className="text-white">{downloadModal.name}</strong> to your mod library
              {downloadModal.source === 'git' ? ' from the Git catalog' : ' from CurseForge'}?
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={handleDownload}
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
    </div>
  );
}

export default ModCatalog;

function ModTile({ mod, expanded = false, onOpen, onClose, onDownload, getTypeBadge, getSourceBadge }) {
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
        {mod.thumbnail ? (
          <img
            src={mod.thumbnail}
            alt={mod.name}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {mod.source === 'git'
              ? <GitBranch className={`${expanded ? 'w-12 h-12' : 'w-8 h-8'} text-mc-textMuted`} />
              : <Package className={`${expanded ? 'w-12 h-12' : 'w-8 h-8'} text-mc-textMuted`} />}
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
      </div>

      <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
        <button
          onClick={onDownload}
          className={`btn btn-primary flex-1 ${expanded ? '' : 'text-xs'}`}
        >
          <Download className={expanded ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
          Download
        </button>
        {mod.websiteUrl && (
          <a
            href={mod.websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`btn btn-secondary ${expanded ? '' : 'text-xs p-2'}`}
            title={mod.source === 'git' ? 'View source' : 'View on CurseForge'}
          >
            <ExternalLink className={expanded ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
          </a>
        )}
      </div>
    </div>
  );
}
