import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { userManagementApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

function PermissionsPage() {
  const { canViewPermissions } = useAuth();
  const [catalog, setCatalog] = useState({ categories: [], permissions: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [busyKey, setBusyKey] = useState('');

  const load = async () => {
    try {
      const res = await userManagementApi.permissions();
      setCatalog(res.data || { categories: [], permissions: [] });
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (catalog.permissions || []).filter((perm) => {
      const matchesCategory = category === 'all' || perm.category === category;
      const matchesSearch = !q
        || perm.name.toLowerCase().includes(q)
        || perm.description.toLowerCase().includes(q)
        || perm.key.toLowerCase().includes(q);
      return matchesCategory && matchesSearch;
    });
  }, [catalog, search, category]);

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

  return (
    <div>
      <div className="card mb-6">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mc-textMuted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-10"
              placeholder="Search permissions..."
            />
          </div>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="input w-full md:w-56">
            <option value="all">All types</option>
            {(catalog.categories || []).map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
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
                <p className="text-sm font-medium text-white">{perm.name}</p>
                <p className="text-xs text-mc-textMuted mt-1">{perm.description}</p>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 flex-shrink-0">
                <label className="flex items-center gap-2 text-xs text-mc-text">
                  <span>Allow for user</span>
                  <button
                    type="button"
                    disabled={busyKey === perm.key}
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
                    disabled={busyKey === perm.key}
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
