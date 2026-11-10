import { Star } from 'lucide-react';
import { toggleFavorite, useFavorites } from './favorites';
import type { FavoriteKind } from './favorites';

/** the star in the corner of an effect / transition card: keeps it in the "favorites" group at the top */
export function FavoriteStar({ kind, id, name }: { kind: FavoriteKind; id: string; name: string }) {
  const on = useFavorites((s) => s[kind].includes(id));
  return (
    <button
      type="button"
      className={`media-fav${on ? ' is-on' : ''}`}
      aria-pressed={on}
      aria-label={on ? `remove ${name} from favorites` : `add ${name} to favorites`}
      title={on ? 'remove from favorites' : 'add to favorites'}
      draggable={false}
      onClick={(e) => {
        // the card itself adds the effect on click
        e.stopPropagation();
        toggleFavorite(kind, id);
      }}
    >
      <Star size={12} fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}
