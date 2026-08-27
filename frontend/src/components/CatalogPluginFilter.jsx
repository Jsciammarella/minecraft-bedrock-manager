import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export default function CatalogPluginFilter({
  filter,
  selectedIds = [],
  onChange,
  className = '',
  onClose,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const options = Array.isArray(filter?.options) ? filter.options : [];
  const selectable = options.filter((item) => !item.disabled);
  const selected = selectedIds.map(String);
  const emptyLabel = filter?.emptyLabel || 'All';

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(event) {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
        onClose?.();
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, onClose]);

  if (!filter?.available) return null;

  const label = selected.length === 0
    ? (selectable.length ? emptyLabel : 'No eligible Java servers')
    : selected.length === 1
      ? (options.find((item) => String(item.id) === selected[0])?.label || selected[0])
      : 'Multiple selected';

  function emit(nextIds) {
    onChange?.({
      filterId: filter.id,
      selectedIds: nextIds,
      editions: filter.editions || [],
    });
  }

  function toggleOpen() {
    if (!selectable.length) return;
    if (open) {
      setOpen(false);
      onClose?.();
      return;
    }
    setOpen(true);
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        className="input w-full text-left flex items-center justify-between gap-2"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={filter.label || 'Catalog filter'}
        disabled={!selectable.length}
        onClick={toggleOpen}
      >
        <span className="truncate">{label}</span>
        {selectable.length ? (
          <ChevronDown className={`w-4 h-4 shrink-0 text-mc-textMuted transition-transform ${open ? 'rotate-180' : ''}`} />
        ) : null}
      </button>
      {open && selectable.length > 0 && (
        <div className="absolute z-30 mt-1 w-full min-w-[16rem] max-h-72 overflow-auto bg-mc-darker border border-mc-surfaceLight rounded-lg shadow-lg py-1">
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm text-mc-textMuted hover:bg-mc-surfaceLight"
            onClick={() => emit([])}
          >
            Deselect all
          </button>
          <button
            type="button"
            className={`w-full text-left px-3 py-2 text-sm hover:bg-mc-surfaceLight flex items-center gap-2 ${
              selected.length === 0 ? 'text-mc-accent' : 'text-white'
            }`}
            onClick={() => emit([])}
          >
            <span className="w-4 shrink-0">{selected.length === 0 ? <Check className="w-4 h-4" /> : null}</span>
            {emptyLabel}
          </button>
          {options.map((item) => {
            const id = String(item.id);
            const checked = selected.includes(id);
            return (
              <button
                type="button"
                key={id}
                disabled={Boolean(item.disabled)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                  item.disabled
                    ? 'text-mc-textMuted cursor-not-allowed'
                    : `hover:bg-mc-surfaceLight ${checked ? 'text-white' : 'text-mc-text'}`
                }`}
                onClick={() => {
                  if (item.disabled) return;
                  const next = checked
                    ? selected.filter((value) => value !== id)
                    : [...selected, id];
                  emit(next);
                }}
              >
                <span className="w-4 shrink-0">{checked && !item.disabled ? <Check className="w-4 h-4 text-mc-accent" /> : null}</span>
                <span className="min-w-0">
                  <span className="block truncate">{item.label || id}</span>
                  {item.disabled && item.disabledReason ? (
                    <span className="block text-xs text-mc-textMuted">{item.disabledReason}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
