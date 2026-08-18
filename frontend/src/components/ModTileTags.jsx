import { Children } from 'react';

export default function ModTileTags({ children }) {
  const tags = Children.toArray(children).filter(Boolean).slice(0, 3);
  return (
    <div className="mod-tile-tags" aria-label="Mod tags">
      {tags}
    </div>
  );
}
