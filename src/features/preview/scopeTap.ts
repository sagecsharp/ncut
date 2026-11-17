/**
 * the frame tap: painters the scopes can measure (preview engine, camera inset, source view) call tapFrame right after
 * they paint. closed scopes and probe: nobody listens, a tap is one size check. listeners never read inside the tap.
 */
export type TapKind = 'output' | 'scene' | 'source';
export type TapImage = HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | HTMLImageElement;
/** still: the picture stays (paused). image null: the view shows no picture now (a sound file, missing media) */
export type FrameTap = (image: TapImage | null, w: number, h: number, kind: TapKind, still: boolean) => void;

const taps = new Set<FrameTap>();
const wanters = new Set<() => void>();
/** counters for the dev hook (window.__ncut.scopes.debug), never read by the app. ms are running sums */
export const scopeDebug = { taps: 0, reads: 0, exactReads: 0, readMs: 0, binMs: 0, plotMs: 0 };

export const frameTapOn = (): boolean => taps.size > 0;

export function tapFrame(image: TapImage | null, w: number, h: number, kind: TapKind, still: boolean): void {
  if (taps.size === 0) return;
  scopeDebug.taps++;
  for (const f of taps) f(image, w, h, kind, still);
}

/** listen to every painted picture. want: ask every painter for a fresh picture now */
export function addFrameTap(f: FrameTap, want = true): () => void {
  taps.add(f);
  if (want) wantFrame();
  return () => void taps.delete(f);
}

/** a painter says how to make it paint again */
export function onTapWanted(f: () => void): () => void {
  wanters.add(f);
  return () => void wanters.delete(f);
}

export function wantFrame(): void {
  for (const f of [...wanters]) f();
}

/** a tap counts only when it comes from the view the preview shows */
export const tapCounts = (kind: TapKind, mode: string): boolean => kind === mode;
