import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

const ROW_CLASS = 'flex items-center justify-between gap-3 h-12 px-3 bg-mc-darker rounded-lg';

export default function ScrollableCheckList({
  items,
  selectedIds,
  onToggle,
  disabled,
  searchPlaceholder = 'Search...',
  filterValue,
  onFilterChange,
  filterOptions,
  emptyText = 'No matches.',
}) {
  const [search, setSearch] = useState('');
  const selected = new Set((selectedIds || []).map(String));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items || []).filter((item) => {
      if (!q) return true;
      return String(item.label || '').toLowerCase().includes(q)
        || String(item.subtitle || '').toLowerCase().includes(q);
    });
  }, [items, search]);

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
        {filterOptions && (
          <select
            value={filterValue}
            onChange={(e) => onFilterChange(e.target.value)}
            className="input w-full md:w-56"
          >
            {filterOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        )}
      </div>
      <div className="overflow-y-auto flex flex-col gap-2 max-h-[35rem]">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-sm text-mc-textMuted">{emptyText}</div>
        ) : filtered.map((item) => (
          <label
            key={item.id}
            className={`${ROW_CLASS} ${item.muted ? 'opacity-60' : ''}`}
          >
            <span className="min-w-0 truncate text-sm text-white">
              {item.label}
              {item.subtitle && (
                <span className="ml-2 text-xs text-mc-textMuted">{item.subtitle}</span>
              )}
            </span>
            <input
              type="checkbox"
              checked={selected.has(String(item.id))}
              disabled={disabled}
              onChange={(e) => onToggle(item.id, e.target.checked)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
