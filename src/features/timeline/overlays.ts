/**
 * imperative controller for the transient overlays inside the lanes area: snap line, drop ghost,
 * marquee rectangle and the "new track" zone highlight. gestures write to them straight through
 * dom refs (transforms only), never through react state.
 */
export interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type GhostKind = 'asset' | 'text' | 'shape' | 'effect' | 'camera' | 'transition' | 'swap' | 'target';

export class Overlays {
  private snapEl: HTMLElement | null = null;
  private ghostEl: HTMLElement | null = null;
  private marqueeEl: HTMLElement | null = null;
  private readoutEl: HTMLElement | null = null;
  private readoutKey = '';
  private zoneTop: HTMLElement | null = null;
  private zoneBottom: HTMLElement | null = null;
  private hot: 'top' | 'bottom' | null = null;
  private snapX = NaN;

  readonly refSnap = (el: HTMLElement | null): void => {
    this.snapEl = el;
  };
  readonly refGhost = (el: HTMLElement | null): void => {
    this.ghostEl = el;
  };
  readonly refMarquee = (el: HTMLElement | null): void => {
    this.marqueeEl = el;
  };
  readonly refReadout = (el: HTMLElement | null): void => {
    this.readoutEl = el;
  };
  readonly refZoneTop = (el: HTMLElement | null): void => {
    this.zoneTop = el;
  };
  readonly refZoneBottom = (el: HTMLElement | null): void => {
    this.zoneBottom = el;
  };

  /** show the snap line at a time, or hide it */
  setSnap(time: number | null, zoom: number): void {
    const el = this.snapEl;
    if (!el) return;
    if (time === null) {
      if (!el.hidden) el.hidden = true;
      this.snapX = NaN;
      return;
    }
    const x = Math.round(time * zoom);
    if (x !== this.snapX) {
      this.snapX = x;
      el.style.transform = `translate3d(${x}px,0,0)`;
    }
    if (el.hidden) el.hidden = false;
  }

  setGhost(r: OverlayRect | null, kind?: GhostKind, label?: string): void {
    const el = this.ghostEl;
    if (!el) return;
    if (!r) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    el.style.transform = `translate3d(${r.x}px,${r.y}px,0)`;
    el.style.width = `${Math.max(2, r.w)}px`;
    el.style.height = `${r.h}px`;
    el.dataset.kind = kind ?? 'asset';
    const text = label ?? '';
    const span = el.firstElementChild;
    if (span && span.textContent !== text) span.textContent = text;
    if (el.hidden) el.hidden = false;
  }

  /** small text next to a dragged clip (its new start time), or hide it */
  setReadout(x: number, y: number, text: string | null): void {
    const el = this.readoutEl;
    if (!el) return;
    if (text === null) {
      if (!el.hidden) el.hidden = true;
      this.readoutKey = '';
      return;
    }
    const key = `${x}|${y}|${text}`;
    if (key !== this.readoutKey) {
      this.readoutKey = key;
      el.style.transform = `translate3d(${x}px,${y}px,0)`;
      if (el.textContent !== text) el.textContent = text;
    }
    if (el.hidden) el.hidden = false;
  }

  setMarquee(r: OverlayRect | null): void {
    const el = this.marqueeEl;
    if (!el) return;
    if (!r) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    el.style.transform = `translate3d(${r.x}px,${r.y}px,0)`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
    if (el.hidden) el.hidden = false;
  }

  /** highlight a new-track zone while a clip is held over it */
  setHot(where: 'top' | 'bottom' | null): void {
    if (where === this.hot) return;
    this.zoneTop?.classList.toggle('is-hot', where === 'top');
    this.zoneBottom?.classList.toggle('is-hot', where === 'bottom');
    this.hot = where;
  }

  clear(): void {
    this.setSnap(null, 1);
    this.setGhost(null);
    this.setMarquee(null);
    this.setReadout(0, 0, null);
    this.setHot(null);
  }
}
