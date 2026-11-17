/**
 * the one tooltip. a single div on body, filled with text, driven by delegated listeners on the window.
 * no react: showing or hiding a tip commits nothing. a control opts in with tip() (features/shell/tip.ts),
 * which writes the data attributes read here. this file knows nothing about shortcuts or the store.
 */
import { focusedByKeyboard } from '../../lib/pressKey';

export type TipSide = 'bottom' | 'top' | 'left' | 'right';
export type TipKind = 'tool' | 'field';
/** key caps, the same shape as Shortcut.keys: alternatives, each a list of caps */
export type Caps = readonly (readonly string[])[];

export const TIP_DELAY = { tool: 450, field: 900, warm: 60, warmWindow: 400 } as const;
const TIP_GAP = 6;
const TIP_EDGE = 8;
const TIP_ID = 'ncut-tip';
/** a "tool" tip comes fast and warms up. everything else (section heads, handles, sliders) is a "field" */
export const TOOL_SELECTOR = 'button:not(.props-section-head), select, [role="tab"], [role^="menuitem"]';

export interface TipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface TipSize {
  width: number;
  height: number;
}
export interface TipView {
  width: number;
  height: number;
}
export interface TipPlace {
  left: number;
  top: number;
  side: TipSide;
}

export interface TipData {
  name: string;
  does?: string;
  keys?: Caps;
  /** the control is off now: what to do first */
  off?: string;
  /** a toggle: the head reads "name: on" / "name: off" */
  on?: boolean;
}
export interface TipLines {
  head: string;
  keys: Caps;
  does: string | null;
  warn: string | null;
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/** where the tip goes: next to the anchor, flipped when it does not fit, kept 8 px inside the window */
export function placeTip(anchor: TipRect, size: TipSize, view: TipView, side: TipSide = 'bottom'): TipPlace {
  if (side === 'left' || side === 'right') {
    const top = clamp(anchor.top + anchor.height / 2 - size.height / 2, TIP_EDGE, view.height - TIP_EDGE - size.height);
    const leftPos = anchor.left - TIP_GAP - size.width;
    const rightPos = anchor.left + anchor.width + TIP_GAP;
    let useLeft: boolean;
    if (side === 'left') useLeft = leftPos >= TIP_EDGE || rightPos + size.width > view.width - TIP_EDGE;
    else useLeft = !(rightPos + size.width <= view.width - TIP_EDGE || leftPos < TIP_EDGE);
    const left = clamp(useLeft ? leftPos : rightPos, TIP_EDGE, view.width - TIP_EDGE - size.width);
    return { left, top, side: useLeft ? 'left' : 'right' };
  }
  const left = clamp(anchor.left + anchor.width / 2 - size.width / 2, TIP_EDGE, view.width - TIP_EDGE - size.width);
  const below = anchor.top + anchor.height + TIP_GAP;
  const above = anchor.top - TIP_GAP - size.height;
  const fitsBelow = below + size.height <= view.height - TIP_EDGE;
  const fitsAbove = above >= TIP_EDGE;
  let useBelow: boolean;
  if (side === 'bottom') useBelow = fitsBelow || !fitsAbove;
  else useBelow = !(fitsAbove || !fitsBelow);
  const top = clamp(useBelow ? below : above, TIP_EDGE, view.height - TIP_EDGE - size.height);
  return { left, top, side: useBelow ? 'bottom' : 'top' };
}

/** the text lines of a tip. a reason (why) shows only when the control has no off line of its own */
export function tipLines(d: TipData, why?: string | null): TipLines {
  const head = d.name + (d.on === undefined ? '' : d.on ? ': on' : ': off');
  const does = d.does !== undefined && d.does.trim() !== d.name.trim() ? d.does : null;
  return { head, keys: d.keys ?? [], does: does === '' ? null : does, warn: d.off || why || null };
}

export function tipKind(el: Pick<Element, 'matches'>): TipKind {
  return el.matches(TOOL_SELECTOR) ? 'tool' : 'field';
}

export function tipDelay(kind: TipKind, warmUntil: number, now: number, byKeyboard: boolean): number {
  if (byKeyboard) return 0;
  if (kind === 'tool' && now < warmUntil) return TIP_DELAY.warm;
  return kind === 'tool' ? TIP_DELAY.tool : TIP_DELAY.field;
}

const SIDES: readonly string[] = ['bottom', 'top', 'left', 'right'];

function parseKeys(text: string | null): Caps | undefined {
  if (!text) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v) && v.every((alt) => Array.isArray(alt) && alt.every((c) => typeof c === 'string'))) return v as string[][];
  } catch {
    // bad json: no keys
  }
  return undefined;
}

export function readTip(el: Pick<Element, 'getAttribute'>): { data: TipData; why: string | null; side: TipSide } | null {
  const name = el.getAttribute('data-tip');
  if (!name) return null;
  const data: TipData = { name };
  const does = el.getAttribute('data-tip-does');
  if (does) data.does = does;
  const keys = parseKeys(el.getAttribute('data-tip-keys'));
  if (keys) data.keys = keys;
  const off = el.getAttribute('data-tip-off');
  if (off) data.off = off;
  const on = el.getAttribute('data-tip-on');
  if (on === 'true') data.on = true;
  else if (on === 'false') data.on = false;
  const side = el.getAttribute('data-tip-side');
  return {
    data,
    why: el.getAttribute('data-tip-why') || null,
    side: side !== null && SIDES.includes(side) ? (side as TipSide) : 'bottom',
  };
}

export type TipReason = (id: string) => string | null;

let reason: TipReason | null = null;
/** the editor says why an action would do nothing now. asked only when a tip shows */
export function setTipReason(fn: TipReason | null): void {
  reason = fn;
}

function safeReason(id: string): string | null {
  if (!reason) return null;
  try {
    return reason(id);
  } catch {
    return null;
  }
}

/** the element a tip belongs to, unless a closer native title is in the way */
function anchorOf(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest('[data-tip]');
  if (!el) return null;
  for (let n: Element | null = target; n && n !== el; n = n.parentElement) {
    if (n.getAttribute('title')) return null;
  }
  return el;
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

/** start the tip layer on a window. call once at startup. returns the undo */
export function watchTips(win: Window): () => void {
  const doc = win.document;
  const node = div('tip');
  node.id = TIP_ID;
  node.setAttribute('role', 'tooltip');
  node.hidden = true;
  const head = div('tip-head');
  const nameEl = document.createElement('span');
  nameEl.className = 'tip-name';
  const keysEl = document.createElement('span');
  keysEl.className = 'tip-keys';
  head.append(nameEl, keysEl);
  const doesEl = div('tip-does');
  const offEl = div('tip-off');
  node.append(head, doesEl, offEl);
  doc.body.appendChild(node);

  let anchor: Element | null = null;
  let byKey = false;
  let pending: { el: Element; timer: ReturnType<typeof setTimeout> } | null = null;
  let suppressed: Element | null = null;
  let warmUntil = 0;
  let conn: ReturnType<typeof setInterval> | 0 = 0;

  function cancelPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  function hide(warm: boolean) {
    cancelPending();
    if (anchor) {
      if (anchor.getAttribute('aria-describedby') === TIP_ID) anchor.removeAttribute('aria-describedby');
      node.hidden = true;
      if (warm && tipKind(anchor) === 'tool') warmUntil = performance.now() + TIP_DELAY.warmWindow;
    }
    anchor = null;
    if (conn) clearInterval(conn);
    conn = 0;
  }

  function show(el: Element, keyboard: boolean) {
    const r = readTip(el);
    if (!r) return;
    const why = r.data.off ? null : r.why ? safeReason(r.why) : null;
    const lines = tipLines(r.data, why);
    nameEl.textContent = lines.head;
    keysEl.textContent = '';
    lines.keys.forEach((alt, i) => {
      if (i > 0) {
        const or = document.createElement('span');
        or.className = 'tip-or';
        or.textContent = 'or';
        keysEl.appendChild(or);
      }
      for (const cap of alt) {
        const k = document.createElement('kbd');
        k.className = 'kbd';
        k.textContent = cap;
        keysEl.appendChild(k);
      }
    });
    keysEl.hidden = lines.keys.length === 0;
    doesEl.textContent = lines.does ?? '';
    doesEl.hidden = lines.does === null;
    offEl.textContent = lines.warn ?? '';
    offEl.hidden = lines.warn === null;
    node.hidden = false;
    node.style.left = '0px';
    node.style.top = '0px';
    const size = { width: node.offsetWidth, height: node.offsetHeight };
    const b = el.getBoundingClientRect();
    const place = placeTip({ left: b.left, top: b.top, width: b.width, height: b.height }, size, { width: win.innerWidth, height: win.innerHeight }, r.side);
    node.style.left = `${place.left}px`;
    node.style.top = `${place.top}px`;
    if (anchor && anchor !== el && anchor.getAttribute('aria-describedby') === TIP_ID) anchor.removeAttribute('aria-describedby');
    el.setAttribute('aria-describedby', TIP_ID);
    anchor = el;
    byKey = keyboard;
    if (conn) clearInterval(conn);
    conn = setInterval(() => {
      if (!el.isConnected) hide(false);
    }, 500);
  }

  const onOver = (e: Event) => {
    const pe = e as PointerEvent;
    if (pe.pointerType === 'touch') return;
    const el = anchorOf(e.target);
    if (el && (el === anchor || el === pending?.el)) return;
    if (!el) {
      cancelPending();
      if (anchor && !byKey) hide(true);
      return;
    }
    if (pe.buttons !== 0) return;
    if (el === suppressed) return;
    if (anchor && !byKey) hide(true);
    cancelPending();
    const delay = tipDelay(tipKind(el), warmUntil, performance.now(), false);
    pending = { el, timer: setTimeout(() => show(el, false), delay) };
  };
  const onOut = (e: Event) => {
    const el = anchorOf(e.target);
    if (!el) return;
    const rel = (e as PointerEvent).relatedTarget;
    if (rel instanceof Node && el.contains(rel)) return;
    if (el === suppressed) suppressed = null;
    if (pending && pending.el === el) cancelPending();
    if (anchor === el && !byKey) hide(true);
  };
  const onDown = (e: Event) => {
    suppressed = anchorOf(e.target);
    hide(false);
  };
  const onKey = (e: Event) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return;
    hide(false);
  };
  const onFocusIn = (e: Event) => {
    if (!focusedByKeyboard()) return;
    const el = anchorOf(e.target);
    if (!el) return;
    hide(false);
    show(el, true);
  };
  const onFocusOut = (e: Event) => {
    if (byKey && anchor && e.target instanceof Node && anchor.contains(e.target)) hide(false);
  };
  const onWheel = () => hide(false);
  const onScroll = (e: Event) => {
    if (!anchor && !pending) return;
    const mine = anchor ?? pending!.el;
    if (e.target === doc || (e.target instanceof Node && e.target.contains(mine))) hide(false);
  };
  const onBlur = (e: Event) => {
    if (e.target === win) hide(false);
  };
  const onVisible = () => {
    if (doc.hidden) hide(false);
  };

  const opts = { capture: true, passive: true } as const;
  const events: [string, (e: Event) => void][] = [
    ['pointerover', onOver],
    ['pointerout', onOut],
    ['pointerdown', onDown],
    ['keydown', onKey],
    ['focusin', onFocusIn],
    ['focusout', onFocusOut],
    ['wheel', onWheel],
    ['scroll', onScroll],
    ['blur', onBlur],
  ];
  for (const [name, fn] of events) win.addEventListener(name, fn, opts);
  doc.addEventListener('visibilitychange', onVisible);

  return () => {
    hide(false);
    for (const [name, fn] of events) win.removeEventListener(name, fn, opts);
    doc.removeEventListener('visibilitychange', onVisible);
    node.remove();
  };
}
