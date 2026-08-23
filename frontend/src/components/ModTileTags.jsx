import { Children } from 'react';

export default function ModTileTags({ children }) {
  const tags = Children.toArray(children).filter(Boolean).slice(0, 8);
  const row1 = tags.slice(0, 4);
  const row2 = tags.slice(4, 8);
  return (
    <div className="mod-tile-tags" aria-label="Mod tags">
      <div className="mod-tile-tags-row">
        {row1}
      </div>
      <div className="mod-tile-tags-row">
        {row2}
      </div>
    </div>
  );
}
