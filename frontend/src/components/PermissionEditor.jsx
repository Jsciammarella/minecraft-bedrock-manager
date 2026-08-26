import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import PermissionTriState from './PermissionTriState.jsx';

const RISK_OPTIONS = ['read', 'normal', 'elevated', 'destructive', 'administrator-only'];

function matchesText(perm, q) {
  if (!q) return true;
  const plugin = String(perm.pluginId || perm.pluginName || '').toLowerCase();
  return [
    perm.displayName,
    perm.name,
    perm.key,
    perm.description,
    perm.primaryCategory,
    perm.category,
    perm.subcategory,
    plugin,
  ].some((value) => String(value || '').toLowerCase().includes(q));
}

function assignmentState(perm, values, inherited) {
  const direct = values[perm.key] || '';
  const inheritedEffect = inherited?.[perm.key]?.effect || '';
  if (direct === 'allow') return 'allowed';
  if (direct === 'deny') return 'denied';
  if (inheritedEffect === 'allow') return 'allowed';
  if (inheritedEffect === 'deny') return 'denied';
  return 'unset';
}

function effectiveLabel(perm, values, inherited, effectiveKeys) {
  const direct = values[perm.key] || '';
  const inheritedEffect = inherited?.[perm.key]?.effect || '';
  if (direct === 'deny' || inheritedEffect === 'deny') return 'Denied';
  if (Array.isArray(effectiveKeys)) return effectiveKeys.includes(perm.key) ? 'Allowed' : 'Denied';
  if (direct === 'allow' || inheritedEffect === 'allow') return 'Allowed';
  return 'Denied';
}

export default function PermissionEditor({
  catalog,
  values,
  onChange,
  disabled,
  assignmentKey = 'allowUser',
  emptyText = 'No permissions match this search or filter.',
  searchPlaceholder = 'Search permissions...',
  hideCategoryFilter = false,
  inherited = null,
  effectiveKeys = null,
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [subcategory, setSubcategory] = useState('all');
  const [source, setSource] = useState('all');
  const [plugin, setPlugin] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [risk, setRisk] = useState('all');
  const [activeFilter, setActiveFilter] = useState('active');
  const [deprecatedFilter, setDeprecatedFilter] = useState('current');

  const subcategories = catalog.subcategories || [];
  const plugins = useMemo(() => {
    const ids = new Set();
    for (const perm of catalog.permissions || []) {
      if (perm.pluginId) ids.add(perm.pluginId);
    }
    return [...ids].sort();
  }, [catalog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (catalog.permissions || []).filter((perm) => {
      if (!hideCategoryFilter && category !== 'all' && (perm.primaryCategory || perm.category) !== category) return false;
      if (subcategory !== 'all' && perm.subcategory !== subcategory) return false;
      if (source !== 'all' && (perm.source || 'core') !== source) return false;
      if (plugin !== 'all' && perm.pluginId !== plugin) return false;
      if (risk !== 'all' && (perm.riskLevel || 'normal') !== risk) return false;
      if (activeFilter === 'active' && perm.active === false) return false;
      if (activeFilter === 'inactive' && perm.active !== false) return false;
      if (deprecatedFilter === 'current' && perm.deprecated) return false;
      if (deprecatedFilter === 'deprecated' && !perm.deprecated) return false;
      if (stateFilter !== 'all' && assignmentState(perm, values, inherited) !== stateFilter) return false;
      return matchesText(perm, q);
    });
  }, [
    catalog, search, category, subcategory, source, plugin, risk,
    activeFilter, deprecatedFilter, stateFilter, hideCategoryFilter, values, inherited,
  ]);

  const visibleSubs = subcategories.filter((item) => category === 'all' || item.category === category);

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
        <div className="relative md:col-span-2">
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
          <select value={category} onChange={(e) => { setCategory(e.target.value); setSubcategory('all'); }} className="input">
            <option value="all">All categories</option>
            {(catalog.categories || []).map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        )}
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
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className="input">
          <option value="all">All states</option>
          <option value="allowed">Allowed</option>
          <option value="denied">Denied</option>
          <option value="unset">Unset</option>
        </select>
        <select value={risk} onChange={(e) => setRisk(e.target.value)} className="input">
          <option value="all">All risk levels</option>
          {RISK_OPTIONS.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <select value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)} className="input">
          <option value="all">Active and inactive</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive / disabled plugins</option>
        </select>
        <select value={deprecatedFilter} onChange={(e) => setDeprecatedFilter(e.target.value)} className="input">
          <option value="current">Current</option>
          <option value="deprecated">Deprecated</option>
          <option value="all">Current and deprecated</option>
        </select>
      </div>
      <div className="max-h-[70vh] overflow-y-auto space-y-2">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-sm text-mc-textMuted">{emptyText}</div>
        ) : filtered.map((perm) => {
          const direct = values[perm.key] || '';
          const inheritedRow = inherited?.[perm.key];
          const inheritedEffect = inheritedRow?.effect || '';
          const inheritSource = (inheritedRow?.sources || []).map((item) => item.group).join(', ');
          return (
            <div key={perm.key} className="flex items-start justify-between gap-3 p-3 bg-mc-darker rounded-lg">
              <div>
                <p className="text-sm text-white">{perm.displayName || perm.name}</p>
                <p className="text-xs text-mc-textMuted font-mono">{perm.key}</p>
                <p className="text-xs text-mc-textMuted">{perm.description}</p>
                <div className="flex flex-wrap gap-2 mt-2 text-[11px] text-mc-textMuted">
                  {direct === 'allow' && <span className="text-green-400">Direct allow</span>}
                  {direct === 'deny' && <span className="text-red-400">Direct deny</span>}
                  {!direct && inheritedEffect === 'allow' && <span className="text-green-300">Inherited allow{inheritSource ? ` (${inheritSource})` : ''}</span>}
                  {!direct && inheritedEffect === 'deny' && <span className="text-red-300">Inherited deny{inheritSource ? ` (${inheritSource})` : ''}</span>}
                  <span>Effective: {effectiveLabel(perm, values, inherited, effectiveKeys)}</span>
                  {perm.active === false && <span>Inactive plugin</span>}
                  {perm.deprecated && <span>Deprecated</span>}
                  {perm.riskLevel && <span>{perm.riskLevel}</span>}
                </div>
              </div>
              <PermissionTriState
                value={direct}
                allowAssignment={perm[assignmentKey] !== false && perm.assignableToUsers !== false && perm.assignableToGroups !== false}
                disabled={disabled}
                onChange={(next) => onChange(perm.key, next)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
