/** small ui state shared across features: which dialogs are open, toasts. */
import { create } from 'zustand';
import { uid } from '../lib/id';

export type DialogName = 'export' | 'settings' | 'shortcuts';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success';
  message: string;
  /** a button on the toast. a toast with one stays 10 s */
  action?: ToastAction;
}

/** 'output' = what gets exported. 'scene' = the 3d world seen from a free editor camera. 'source' = one media file before it is on the timeline. previewMode is the active view */
export type PreviewMode = 'output' | 'scene' | 'source';
/** the timeline side of the preview: what activateProgram goes back to */
export type ProgramMode = 'output' | 'scene';

/** the tabs of the media panel */
export type MediaTabId = 'media' | 'layers' | 'text' | 'shapes' | 'effects' | 'transitions' | 'mixer';

/** both: the edit between clipId's end and the clip touching it (clipId = left clip, edge 'end'). alone: picked with alt */
export interface TrimEdge { clipId: string; edge: 'start' | 'end'; both: boolean; alone: boolean }

/** one keyframe in the keyframe panel: a clip, a property and the key's time in clip-local seconds */
export interface KeyRef { clipId: string; prop: string; t: number }

/** a crossfade the user picked: the clip it ends at and the selection it was picked with */
export interface CrossfadePick { clipId: string; selection: readonly string[] }

/** a part of the export dialog a search row asks for */
export type ExportFocus = 'codec' | 'bitrate' | 'interval' | 'size' | 'transparent' | 'audio' | 'loudness';
/** what the export dialog shows when it opens next. n counts up so the same ask works twice */
export interface ExportAsk { advanced: boolean; preset: string | null; focus: ExportFocus | null; n: number }
export interface ExportAskInput { advanced?: boolean; preset?: string; focus?: ExportFocus }

export interface UiState {
  dialog: DialogName | null;
  toasts: Toast[];
  previewMode: PreviewMode;
  programMode: ProgramMode;
  /** trim mode (ripple, move the edit, slip, slide, stretch) is on. never saved, off at every start */
  trimMode: boolean;
  /** the picked edge in trim mode. a gone clip counts as none */
  trimEdge: TrimEdge | null;
  /** the picked crossfade. never saved. a picked edge clears it */
  crossfadePick: CrossfadePick | null;
  /** the selected keyframes of the keyframe panel. never saved */
  keySel: KeyRef[];
  /** the focus is in the keyframe panel: delete, copy, paste, select all, esc and alt+arrows work on keyframes */
  keyFocus: boolean;
  /** what the export dialog shows when it opens next */
  exportAsk: ExportAsk | null;
  /** the tab of the media panel */
  mediaTab: MediaTabId;
  /** the mixer strip to show: a track id, or null for the output. n counts up so the same ask works twice */
  mixerFocus: { track: string | null; n: number } | null;
  projectsVersion: number;
  /** the properties panel shows the project (canvas, sky, fog, light) while a clip is selected */
  projectPanel: boolean;
  /** a section the properties panel should open, scroll to and focus. n counts up so the same id can be asked twice */
  reveal: { id: string; n: number } | null;
  showProjectPanel(on: boolean): void;
  revealSection(id: string): void;
  setPreviewMode(mode: PreviewMode): void;
  /** show the source view. programMode keeps the timeline side */
  activateSource(): void;
  /** back to the timeline side (output or scene) */
  activateProgram(): void;
  /** no write when equal. false also clears trimEdge */
  setTrimMode(on: boolean): void;
  /** no write when equal. a non null edge also turns trim mode on and clears the crossfade pick */
  setTrimEdge(e: TrimEdge | null): void;
  /** no write when both are null or the same clip and the same selection array. a pick clears trimEdge */
  setCrossfadePick(p: CrossfadePick | null): void;
  /** no write when sameKeyRefs */
  setKeySel(sel: readonly KeyRef[]): void;
  /** no write when equal */
  setKeyFocus(on: boolean): void;
  /** open the export dialog with the advanced part open, a preset applied or a row focused */
  askExport(ask: ExportAskInput): void;
  setMediaTab(tab: MediaTabId): void;
  /** open the mixer tab, at a track's strip or at the output */
  showMixer(trackId?: string): void;
  /** bumped when stored projects change outside the projects screen (mcp) */
  projectsChanged(): void;
  openDialog(name: DialogName): void;
  closeDialog(): void;
  /** show a short message bottom-center. auto-dismisses. */
  toast(message: string, kind?: Toast['kind'], action?: ToastAction): void;
  dismissToast(id: string): void;
}

/** the key refs' time tolerance (keySelection.ts has the public KEY_REF_EPS, it imports this file) */
const REF_EPS = 1e-4;

/** the same ids, in any order */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id)) && new Set(b).size === set.size;
}

/** the same refs in any order, t within 1e-4 s (equal lengths, both sorted by clipId, prop, t, then pairwise) */
export function sameKeyRefs(a: readonly KeyRef[], b: readonly KeyRef[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  // cheap checks first: the same order within eps, then a rejection by the sum of t (a drag or nudge of the whole selection always trips it)
  let inPlace = true;
  let ta = 0;
  let tb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (inPlace && (x.clipId !== y.clipId || x.prop !== y.prop || Math.abs(x.t - y.t) > REF_EPS)) inPlace = false;
    ta += x.t;
    tb += y.t;
  }
  if (inPlace) return true;
  if (Math.abs(ta - tb) > a.length * REF_EPS) return false;
  const order = (x: KeyRef, y: KeyRef) => (x.clipId < y.clipId ? -1 : x.clipId > y.clipId ? 1 : x.prop < y.prop ? -1 : x.prop > y.prop ? 1 : x.t - y.t);
  const sa = [...a].sort(order);
  const sb = [...b].sort(order);
  for (let i = 0; i < sa.length; i++) {
    const x = sa[i]!;
    const y = sb[i]!;
    if (x.clipId !== y.clipId || x.prop !== y.prop || Math.abs(x.t - y.t) > REF_EPS) return false;
  }
  return true;
}

export const useUi = create<UiState>()((set, get) => ({
  dialog: null,
  toasts: [],
  previewMode: 'output',
  programMode: 'output',
  trimMode: false,
  trimEdge: null,
  crossfadePick: null,
  keySel: [],
  keyFocus: false,
  exportAsk: null,
  mediaTab: 'media',
  mixerFocus: null,
  projectsVersion: 0,
  projectPanel: false,
  reveal: null,
  showProjectPanel(on) {
    if (get().projectPanel !== on) set({ projectPanel: on });
  },
  revealSection(id) {
    set({ reveal: { id, n: (get().reveal?.n ?? 0) + 1 } });
  },
  setPreviewMode(mode) {
    const s = get();
    if (mode === 'source') { if (s.previewMode !== 'source') set({ previewMode: 'source' }); return; }
    if (s.previewMode !== mode || s.programMode !== mode) set({ previewMode: mode, programMode: mode });
  },
  activateSource() { get().setPreviewMode('source'); },
  activateProgram() { get().setPreviewMode(get().programMode); },
  setTrimMode(on) {
    const s = get();
    if (on) { if (!s.trimMode) set({ trimMode: true }); } else if (s.trimMode || s.trimEdge) set({ trimMode: false, trimEdge: null });
  },
  setTrimEdge(e) {
    const s = get();
    const c = s.trimEdge;
    const same = e === null ? c === null : c !== null && c.clipId === e.clipId && c.edge === e.edge && c.both === e.both && c.alone === e.alone;
    if (same && (e === null || (s.trimMode && s.crossfadePick === null))) return;
    set(e ? { trimEdge: e, trimMode: true, crossfadePick: null } : { trimEdge: null });
  },
  setCrossfadePick(pick) {
    const c = get().crossfadePick;
    if (c === null && pick === null) return;
    if (c !== null && pick !== null && c.clipId === pick.clipId && c.selection === pick.selection) return;
    set(pick ? { crossfadePick: pick, trimEdge: null } : { crossfadePick: null });
  },
  setKeySel(sel) {
    if (!sameKeyRefs(get().keySel, sel)) set({ keySel: [...sel] });
  },
  setKeyFocus(on) {
    if (get().keyFocus !== on) set({ keyFocus: on });
  },
  askExport(ask) {
    set({ dialog: 'export', exportAsk: { advanced: ask.advanced === true || (ask.focus !== undefined && ask.focus !== 'loudness'), preset: ask.preset ?? null, focus: ask.focus ?? null, n: (get().exportAsk?.n ?? 0) + 1 } });
  },
  setMediaTab(tab) {
    if (get().mediaTab !== tab) set({ mediaTab: tab });
  },
  showMixer(trackId) {
    set({ mediaTab: 'mixer', mixerFocus: { track: trackId ?? null, n: (get().mixerFocus?.n ?? 0) + 1 } });
  },
  projectsChanged() {
    set({ projectsVersion: get().projectsVersion + 1 });
  },
  openDialog(name) {
    set({ dialog: name });
  },
  closeDialog() {
    set({ dialog: null });
  },
  toast(message, kind = 'info', action) {
    const id = uid('tst');
    const t: Toast = action ? { id, kind, message, action } : { id, kind, message };
    set({ toasts: [...get().toasts, t].slice(-4) });
    setTimeout(() => get().dismissToast(id), action ? 10000 : kind === 'error' ? 6000 : 3000);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
