export default function PermissionTriState({ value, onChange, disabled, allowAssignment = true }) {
  const current = value === 'allow' || value === 'deny' ? value : '';
  const options = [
    { id: 'allow', label: 'Allow' },
    { id: 'deny', label: 'Deny' },
  ];
  return (
    <div className="inline-flex rounded-lg overflow-hidden border border-mc-surfaceLight">
      {options.map((option) => {
        const active = current === option.id;
        return (
          <button
            key={option.id}
            type="button"
            disabled={disabled || !allowAssignment}
            onClick={() => onChange(active ? '' : option.id)}
            className={`px-2.5 py-1 text-xs font-medium transition-colors ${
              active
                ? option.id === 'allow'
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-red-500/20 text-red-400'
                : 'text-mc-textMuted hover:text-mc-text hover:bg-mc-surfaceLight/60'
            } ${disabled || !allowAssignment ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
