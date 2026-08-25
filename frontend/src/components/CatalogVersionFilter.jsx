import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

function formatEntry(version, edition) {
  const label = edition === 'java' ? 'java' : edition === 'bedrock' ? 'bedrock' : edition;
  return `${version} - ${label}`;
}

export default function CatalogVersionFilter({
  versions = [],
  selectedKeys = [],
  allSelected = true,
  onChange,
  className = '',
  onClose,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = allSelected ? [] : selectedKeys;

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

  const label = allSelected || selected.length === 0
    ? 'All Versions'
    : selected.length === 1
      ? formatEntry(
        (versions.find((item) => item.key === selected[0]) || {}).version || selected[0].split('|')[0],
        (versions.find((item) => item.key === selected[0]) || {}).edition || selected[0].split('|')[1]
      )
      : 'Multiple selected';

  function emit(nextAll, nextKeys) {
    onChange?.({
      allSelected: nextAll || nextKeys.length === 0,
      selectedKeys: nextAll ? [] : nextKeys,
    });
  }

  function toggleOpen() {
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
        onClick={toggleOpen}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className={`w-4 h-4 shrink-0 text-mc-textMuted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[16rem] max-h-72 overflow-auto bg-mc-darker border border-mc-surfaceLight rounded-lg shadow-lg py-1">
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm text-mc-textMuted hover:bg-mc-surfaceLight"
            onClick={() => emit(true, [])}
          >
            Deselect all
          </button>
          <button
            type="button"
            className={`w-full text-left px-3 py-2 text-sm hover:bg-mc-surfaceLight flex items-center gap-2 ${
              allSelected ? 'text-mc-accent' : 'text-white'
            }`}
            onClick={() => emit(true, [])}
          >
            <span className="w-4 shrink-0">{allSelected ? <Check className="w-4 h-4" /> : null}</span>
            All Versions
          </button>
          {versions.map((item) => {
            const checked = !allSelected && selected.includes(item.key);
            return (
              <button
                type="button"
                key={item.key}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-mc-surfaceLight flex items-center gap-2 ${
                  checked ? 'text-white' : 'text-mc-text'
                }`}
                onClick={() => {
                  const next = checked
                    ? selected.filter((key) => key !== item.key)
                    : [...selected, item.key];
                  emit(next.length === 0, next);
                }}
              >
                <span className="w-4 shrink-0">{checked ? <Check className="w-4 h-4 text-mc-accent" /> : null}</span>
                {formatEntry(item.version, item.edition)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
