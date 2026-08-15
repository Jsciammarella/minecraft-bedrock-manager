import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { modApi } from '../services/api';
import {
  ArrowLeft, Search, Download, Package, Filter, ChevronDown,
  AlertCircle, Check, Loader2, ExternalLink, Star, Eye
} from 'lucide-react';

function ModCatalog() {
  const navigate = useNavigate();
  const [mods, setMods] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState('relevancy');
  const [downloadModal, setDownloadModal] = useState(null);
  const [downloading, setDownloading] = useState(false);

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

  const searchMods = async (requestedPage = page) => {
    setSearching(true);
    setError('');
    try {
      const res = await modApi.catalogSearch({
        q: search,
        category,
        page: requestedPage,
        pageSize: 24,
        sortBy,
      });
      setMods(res.data.results || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load the CurseForge catalog. Configure CURSEFORGE_API_KEY on the manager.');
    } finally {
      setSearching(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    searchMods(1);
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
    return <span className={`badge ${colors[type] || 'badge-info'}`}>{type.replace('_', ' ')}</span>;
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">Mod Catalog</h1>
          <p className="text-mc-textMuted mt-1">Browse and download from CurseForge</p>
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

      {/* Search Bar */}
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
          <div className="flex items-center gap-3">
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

      {/* Results */}
      {searching ? (
        <div className="flex items-center justify-center py-16">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
            <p className="text-sm text-mc-textMuted">Searching CurseForge...</p>
          </div>
        </div>
      ) : mods.length === 0 ? (
        <div className="card text-center py-16">
          <Package className="w-16 h-16 text-mc-textMuted mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-white mb-2">No mods found</h3>
          <p className="text-mc-textMuted">Try adjusting your search or filters</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {mods.map((mod, idx) => (
              <div key={mod.id || idx} className="card hover:border-mc-accent/30 transition-all duration-200 group">
                {/* Thumbnail */}
                <div className="aspect-video bg-mc-darker rounded-lg mb-3 overflow-hidden relative">
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
                      <Package className="w-8 h-8 text-mc-textMuted" />
                    </div>
                  )}
                  <div className="absolute top-2 right-2">
                    {getTypeBadge(mod.type)}
                  </div>
                </div>

                {/* Info */}
                <h3 className="font-semibold text-white text-sm mb-1 truncate" title={mod.name}>{mod.name}</h3>
                <p className="text-xs text-mc-textMuted mb-3 line-clamp-2 min-h-[2.5em]">
                  {mod.description || 'No description available'}
                </p>

                {/* Stats */}
                <div className="flex items-center gap-3 text-xs text-mc-textMuted mb-3">
                  <span className="flex items-center gap-1">
                    <Download className="w-3 h-3" />
                    {mod.downloads ? mod.downloads.toLocaleString() : '0'}
                  </span>
                  {mod.author && (
                    <span className="flex items-center gap-1">
                      <Star className="w-3 h-3" />
                      {mod.author}
                    </span>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setDownloadModal(mod)}
                    className="btn btn-primary flex-1 text-xs"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </button>
                  <a
                    href={mod.websiteUrl || `https://www.curseforge.com/minecraft-bedrock/${mod.projectClass || 'addons'}/${mod.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-secondary text-xs p-2"
                    title="View on CurseForge"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-center gap-3 mt-8">
            <button
              onClick={() => {
                const nextPage = Math.max(1, page - 1);
                setPage(nextPage);
                searchMods(nextPage);
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
                searchMods(nextPage);
              }}
              className="btn btn-secondary text-sm"
            >
              Next
            </button>
          </div>
        </>
      )}

      {/* Download Confirmation Modal */}
      {downloadModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card max-w-sm w-full animate-slide-up">
            <h3 className="text-lg font-semibold text-white mb-2">Download Mod</h3>
            <p className="text-sm text-mc-textMuted mb-4">
              Download <strong className="text-white">{downloadModal.name}</strong> to your mod library?
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
