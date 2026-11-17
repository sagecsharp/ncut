import { capsOf, capsText } from './tip';

/** the key of a menu item, at its right: the first alternative of its shortcut row */
export function MenuKeys({ id }: { id: string }) {
  const caps = capsOf(id).slice(0, 1);
  if (caps.length === 0) return null;
  return (
    <span className="menu-hint" aria-hidden="true">
      {capsText(caps)}
    </span>
  );
}
