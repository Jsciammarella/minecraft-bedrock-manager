import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { userManagementApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

function matchesText(perm, q) {
  if (!q) return true;
  return [
    perm.displayName,
    perm.name,
    perm.key,
    perm.description,
    perm.primaryCategory,
    perm.category,
    perm.subcategory,
    perm.pluginId,
  ].some((value) => String(value || '').toLowerCase().includes(q));
}

function PermissionsPage() {
  const { canViewPermissions, can } = useAuth();
  const [catalog, setCatalog] = useState({ categories: [], subcategories: [], permissions: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [subcategory, setSubcategory] = useState('all');
  const [source, setSource] = useState('all');
  const [plugin, setPlugin] = useState('all');
  const [risk, setRisk] = useState('all');
  const [activeFilter, setActiveFilter] = useState('active');
  const [deprecatedFilter, setDeprecatedFilter] = useState('current');
  const [busyKey, setBusyKey] = useState('');

  const load = async () => {
    try {
      const res = await userManagementApi.permissions();
      setCatalog(res.data || { categories: [], subcategories: [], permissions: [] });
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load permissions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const plugins = useMemo(() => (
    [...new Set((catalog.permissions || []).map((item) => item.pluginId).filter(Boolean))].sort()
  ), [catalog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (catalog.permissions || []).filter((perm) => {
      if (category !== 'all' && (perm.primaryCategory || perm.category) !== category) return false;
      if (subcategory !== 'all' && perm.subcategory !== subcategory) return false;
      if (source !== 'all' && (perm.source || 'core') !== source) return false;
      if (plugin !== 'all' && perm.pluginId !== plugin) return false;
      if (risk !== 'all' && (perm.riskLevel || 'normal') !== risk) return false;
      if (activeFilter === 'active' && perm.active === false) return false;
      if (activeFilter === 'inactive' && perm.active !== false) return false;
      if (deprecatedFilter === 'current' && perm.deprecated) return false;
      if (deprecatedFilter === 'deprecated' && !perm.deprecated) return false;
      return matchesText(perm, q);
    });
  }, [catalog, search, category, subcategory, source, plugin, risk, activeFilter, deprecatedFilter]);

  const updateFlag = async (perm, patch) => {
    setBusyKey(perm.key);
    try {
      const res = await userManagementApi.updatePermission(perm.key, patch);
      setCatalog((prev) => ({
        ...prev,
        permissions: (prev.permissions || []).map((item) => (
          item.key === perm.key ? { ...item, ...res.data } : item
        )),
      }));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyKey('');
    }
  };

  if (!canViewPermissions) {
    return <div className="card text-mc-textMuted">You do not have permission to change permission settings.</div>;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
      </div>
    );
  }

  const canManage = can('permissions.manage_assignability');
  const visibleSubs = (catalog.subcategories || []).filter((item) => category === 'all' || item.category === category);

  return (
    <div>
      <div className="card mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <div className="relative md:col-span-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mc-textMuted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-10"
              placeholder="Search permissions..."
            />
          </div>
          <select value={category} onChange={(e) => { setCategory(e.target.value); setSubcategory('all'); }} className="input">
            <option value="all">All categories</option>
            {(catalog.categories || []).map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
          <select value={subcategory} onChange={(e) => setSubcategory(e.target.value)} className="input">
            <option value="all">All subcategories</option>
            {visibleSubs.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)} className="input">
            <option value="all">All sources</option>
            <option value="core">Core</option>
            <option value="first-party-plugin">First-party plugin</option>
            <option value="third-party-plugin">Third-party plugin</option>
          </select>
          <select value={plugin} onChange={(e) => setPlugin(e.target.value)} className="input">
            <option value="all">All plugins</option>
            {plugins.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
          <select value={risk} onChange={(e) => setRisk(e.target.value)} className="input">
            <option value="all">All risk levels</option>
            <option value="read">read</option>
            <option value="normal">normal</option>
            <option value="elevated">elevated</option>
            <option value="destructive">destructive</option>
            <option value="administrator-only">administrator-only</option>
          </select>
          <select value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)} className="input">
            <option value="active">Active</option>
            <option value="inactive">Inactive / disabled plugins</option>
            <option value="all">Active and inactive</option>
          </select>
          <select value={deprecatedFilter} onChange={(e) => setDeprecatedFilter(e.target.value)} className="input">
            <option value="current">Current</option>
            <option value="deprecated">Deprecated</option>
            <option value="all">Current and deprecated</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{error}</div>
      )}

      <div className="card p-0 overflow-hidden">
        <div className="max-h-[70vh] overflow-y-auto divide-y divide-mc-surfaceLight">
          {filtered.length === 0 ? (
            <div className="p-10 text-center text-mc-textMuted">No permissions match this search or filter.</div>
          ) : filtered.map((perm) => (
            <div key={perm.key} className="px-4 py-3 flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-white">{perm.displayName || perm.name}</p>
                <p className="text-xs text-mc-textMuted font-mono mt-1">{perm.key}</p>
                <p className="text-xs text-mc-textMuted mt-1">{perm.description}</p>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 flex-shrink-0">
                <label className="flex items-center gap-2 text-xs text-mc-text">
                  <span>Allow for user</span>
                  <button
                    type="button"
                    disabled={busyKey === perm.key || !canManage}
                    title={!canManage ? 'Requires permissions.manage_assignability' : ''}
                    onClick={() => updateFlag(perm, { allowUser: !perm.allowUser })}
                    className={`toggle ${perm.allowUser ? 'toggle-active' : 'toggle-inactive'}`}
                  >
                    <span className={`toggle-thumb ${perm.allowUser ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </label>
                <label className="flex items-center gap-2 text-xs text-mc-text">
                  <span>Allow for group</span>
                  <button
                    type="button"
                    disabled={busyKey === perm.key || !canManage}
                    title={!canManage ? 'Requires permissions.manage_assignability' : ''}
                    onClick={() => updateFlag(perm, { allowGroup: !perm.allowGroup })}
                    className={`toggle ${perm.allowGroup ? 'toggle-active' : 'toggle-inactive'}`}
                  >
                    <span className={`toggle-thumb ${perm.allowGroup ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default PermissionsPage;
