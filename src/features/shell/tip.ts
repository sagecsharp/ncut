/**
 * tip(): the only way a control gets a tooltip (the layer is components/ui/tips.ts).
 * it returns data attributes, an empty title (so an ancestor title never shows) and aria-keyshortcuts.
 * keys are always shortcut ids from the table, never typed key text.
 */
import type { Caps, TipSide } from '../../components/ui/tips';
import { SHORTCUTS } from './shortcuts';

export interface TipOpts {
  does?: string;
  /** shortcut ids from SHORTCUTS, never key text */
  keys?: string | readonly string[];
  /** keep one alternative of the joined list (scene tools w / e / r, numpad views) */
  pick?: number;
  off?: string | false | null;
  /** a reasons.ts id, answered when the tip shows */
  why?: string;
  on?: boolean;
  side?: TipSide;
}

export interface TipAttrs {
  title: '';
  'data-tip': string;
  'data-tip-does'?: string;
  'data-tip-keys'?: string;
  'data-tip-off'?: string;
  'data-tip-why'?: string;
  'data-tip-on'?: 'true' | 'false';
  'data-tip-side'?: TipSide;
  'aria-keyshortcuts'?: string;
}

const ARIA_NAMED: Readonly<Record<string, string>> = {
  ctrl: 'Control',
  shift: 'Shift',
  alt: 'Alt',
  space: 'Space',
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  delete: 'Delete',
  backspace: 'Backspace',
  home: 'Home',
  end: 'End',
  tab: 'Tab',
  menu: 'ContextMenu',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '+': 'Plus',
};

function ariaCap(cap: string): string | null {
  const named = ARIA_NAMED[cap];
  if (named) return named;
  if (/^f([1-9]|1[0-2])$/.test(cap)) return cap.toUpperCase();
  if (cap.length === 1) return /[a-z]/i.test(cap) ? cap.toUpperCase() : cap;
  return null;
}

/** the aria-keyshortcuts text of caps. an alternative with a cap that is not a key (drag, click, num 1) is dropped */
export function ariaKeys(caps: Caps): string {
  const out: string[] = [];
  for (const alt of caps) {
    const parts = alt.map(ariaCap);
    if (parts.some((p) => p === null)) continue;
    out.push(parts.join('+'));
  }
  return out.join(' ');
}

/** "s, ctrl+b" */
export function capsText(caps: Caps): string {
  return caps.map((alt) => alt.join('+')).join(', ');
}

interface Resolved {
  caps: Caps;
  json: string;
  aria: string;
}

const cache = new Map<string, Resolved>();

function resolve(ids: string | readonly string[], pick?: number): Resolved {
  const list = typeof ids === 'string' ? [ids] : ids;
  const key = `${list.join(',')}|${pick ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let caps: (readonly string[])[] = [];
  for (const id of list) {
    const row = SHORTCUTS.find((s) => s.id === id);
    if (!row) {
      if (import.meta.env.DEV) throw new Error(`tip: no shortcut "${id}"`);
      continue;
    }
    caps = caps.concat(row.keys);
  }
  if (pick !== undefined) caps = caps.slice(pick, pick + 1);
  const r: Resolved = { caps, json: JSON.stringify(caps), aria: ariaKeys(caps) };
  cache.set(key, r);
  return r;
}

/** the key caps of shortcut ids, the alternatives of every id in order */
export function capsOf(ids: string | readonly string[], pick?: number): Caps {
  return resolve(ids, pick).caps;
}

export function tip(name: string, opts: TipOpts = {}): TipAttrs {
  const a: TipAttrs = { title: '', 'data-tip': name };
  if (opts.does) a['data-tip-does'] = opts.does;
  if (opts.keys !== undefined) {
    const r = resolve(opts.keys, opts.pick);
    if (r.caps.length > 0) {
      a['data-tip-keys'] = r.json;
      if (r.aria) a['aria-keyshortcuts'] = r.aria;
    }
  }
  if (typeof opts.off === 'string' && opts.off !== '') a['data-tip-off'] = opts.off;
  if (opts.why) a['data-tip-why'] = opts.why;
  if (typeof opts.on === 'boolean') a['data-tip-on'] = opts.on ? 'true' : 'false';
  if (opts.side && opts.side !== 'bottom') a['data-tip-side'] = opts.side;
  return a;
}
