/** how many decimals beyond `precision` a field may show when the value really has them */
export const EXTRA_DECIMALS = 2;

/**
 * the text a number field shows: at least `precision` decimals, up to EXTRA_DECIMALS more when the value
 * has them. float noise is rounded away first (0.1 + 0.2 -> 0.3) and zero never carries a sign.
 */
export function formatNumber(v: number, precision = 0): string {
  if (!Number.isFinite(v)) return '0';
  const p = Math.max(0, Math.min(10, Math.round(precision)));
  let s = v.toFixed(p + EXTRA_DECIMALS);
  // cut zeros back, but never below `precision` decimals
  let end = s.length;
  const dot = s.indexOf('.');
  const keep = dot + 1 + p;
  while (end > keep && s[end - 1] === '0') end--;
  s = s.slice(0, end);
  if (p === 0 && s.endsWith('.')) s = s.slice(0, -1);
  // "-0.00" and friends
  if (s.startsWith('-') && !/[1-9]/.test(s)) s = s.slice(1);
  return s;
}

/**
 * a value rounded the way the field shows it (precision + 2 decimals). use it where a value is rounded
 * before it goes into a field, so the field is not handed a number that is already cut short.
 */
export function roundShown(v: number, precision = 0): number {
  if (!Number.isFinite(v)) return 0;
  const n = Number(v.toFixed(Math.max(0, Math.min(10, Math.round(precision))) + EXTRA_DECIMALS));
  return n === 0 ? 0 : n;
}
