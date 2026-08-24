import { Children } from 'react';

export default function ModTileTags({ children, expanded = false }) {
  const tags = Children.toArray(children).filter(Boolean);
  return (
    <div
      className={`mod-tile-tags${expanded ? ' mod-tile-tags-expanded' : ''}`}
      aria-label="Mod tags"
    >
      {tags}
    </div>
  );
}
