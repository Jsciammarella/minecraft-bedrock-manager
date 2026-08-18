import { Children } from 'react';

export default function ModTileTags({ children }) {
  const tags = Children.toArray(children).filter(Boolean).slice(0, 3);
  return (
    <div className="mod-tile-tags" aria-label="Mod tags">
      <div className="mod-tile-tags-row">
        {tags}
      </div>
    </div>
  );
}
