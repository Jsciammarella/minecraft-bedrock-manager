import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import PermissionTriState from './PermissionTriState.jsx';

export default function PermissionEditor({
  catalog,
  values,
  onChange,
  disabled,
  assignmentKey = 'allowUser',
  emptyText = 'No permissions match this search or filter.',
  searchPlaceholder = 'Search permissions...',
  hideCategoryFilter = false,
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (catalog.permissions || []).filter((perm) => {
      const matchesCategory = hideCategoryFilter || category === 'all' || perm.category === category;
      const matchesSearch = !q
        || String(perm.name || '').toLowerCase().includes(q)
        || String(perm.description || '').toLowerCase().includes(q)
        || String(perm.key || '').toLowerCase().includes(q);
      return matchesCategory && matchesSearch;
    });
  }, [catalog, search, category, hideCategoryFilter]);

  return (
    <div>
      <div className="flex flex-col md:flex-row gap-4 mb-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mc-textMuted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-10"
            placeholder={searchPlaceholder}
          />
        </div>
        {!hideCategoryFilter && (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="input w-full md:w-56"
          >
            <option value="all">All types</option>
            {(catalog.categories || []).map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        )}
      </div>
      <div className="max-h-[70vh] overflow-y-auto space-y-2">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-sm text-mc-textMuted">{emptyText}</div>
        ) : filtered.map((perm) => (
          <div key={perm.key} className="flex items-start justify-between gap-3 p-3 bg-mc-darker rounded-lg">
            <div>
              <p className="text-sm text-white">{perm.name}</p>
              <p className="text-xs text-mc-textMuted">{perm.description}</p>
            </div>
            <PermissionTriState
              value={values[perm.key] || ''}
              allowAssignment={perm[assignmentKey] !== false}
              disabled={disabled}
              onChange={(next) => onChange(perm.key, next)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
