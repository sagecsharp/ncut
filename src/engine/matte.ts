/**
 * track mattes: a picture clip (the matted clip) names another picture clip (the matte clip) that decides where it shows.
 * the matte clip is not drawn on its own. pure: no dom, gl or store, safe in workers.
 * matteTable is the one engine gate: null when no matte counts, so a project without mattes pays one cached lookup.
 */
import type { Clip, ClipMatte, MatteMode, Project, VisualClip } from '../types';
import { isVisualClip } from '../types';
import { clipEnd } from '../lib/timelineOps';
import type { EffectDef, EffectPass } from './effects/types';
import { faceSourceSet } from './scene3d/faces';

export const MATTE_MODES: readonly MatteMode[] = ['alpha', 'alpha-inv', 'luma', 'luma-inv'];
export const MATTE_MODE_LABELS: Readonly<Record<MatteMode, string>> = {
  alpha: 'alpha: its outline',
  'alpha-inv': 'alpha inverted: outside its outline',
  luma: 'luma: its bright parts',
  'luma-inv': 'luma inverted: its dark parts',
};
export const MATTE_MODE_WORDS: Readonly<Record<MatteMode, string>> = { alpha: 'alpha', 'alpha-inv': 'alpha inverted', luma: 'luma', 'luma-inv': 'luma inverted' };
export function isMatteMode(v: unknown): v is MatteMode {
  return typeof v === 'string' && (MATTE_MODES as readonly string[]).includes(v);
}
export function isInverted(mode: MatteMode): boolean {
  return mode === 'alpha-inv' || mode === 'luma-inv';
}
/** the stored matte when it is well formed, else null */
export function matteField(c: Clip | null | undefined): ClipMatte | null {
  if (!c || !isVisualClip(c)) return null;
  const m = c.matte;
  if (!m || typeof m !== 'object' || typeof m.clip !== 'string' || m.clip === '' || !isMatteMode(m.mode)) return null;
  return m;
}

export interface MatteRef { src: VisualClip; mode: MatteMode }
export interface MatteTable {
  /** matted clip id -> its matte, only mattes that count (decision 3) */
  byClip: ReadonlyMap<string, MatteRef>;
  /** the counting matte clips: never painted on their own */
  sources: ReadonlySet<string>;
  /** the same clips in project order */
  sourceClips: readonly VisualClip[];
}

const tables = new WeakMap<Project, { clips: Project['clips']; tracks: Project['tracks']; n: number; table: MatteTable | null }>();
/** the one engine gate: null when no matte counts. a null is cached too, so a project without mattes pays one lookup */
export function matteTable(project: Project): MatteTable | null {
  const hit = tables.get(project);
  if (hit && hit.clips === project.clips && hit.tracks === project.tracks && hit.n === project.clips.length) return hit.table;
  const table = buildTable(project);
  tables.set(project, { clips: project.clips, tracks: project.tracks, n: project.clips.length, table });
  return table;
}

function buildTable(project: Project): MatteTable | null {
  if (!project.clips.some((c) => matteField(c))) return null;
  const byId = new Map(project.clips.map((c) => [c.id, c]));
  const shown = new Set(project.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id));
  const onSides = faceSourceSet(project);
  const byClip = new Map<string, MatteRef>();
  const sources = new Set<string>();
  const sourceClips: VisualClip[] = [];
  for (const c of project.clips) {
    const m = matteField(c);
    if (!m || m.clip === c.id || onSides.has(c.id)) continue;
    const src = byId.get(m.clip);
    // a matte clip with a matte of its own: neither counts on it (no chains, no cycles)
    if (!src || !isVisualClip(src) || !shown.has(src.trackId) || matteField(src)) continue;
    byClip.set(c.id, { src, mode: m.mode });
    if (!sources.has(src.id)) {
      sources.add(src.id);
      sourceClips.push(src);
    }
  }
  return byClip.size === 0 ? null : { byClip, sources, sourceClips };
}

/** the matte of a clip when it counts, else null */
export function matteOf(project: Project, id: string): MatteRef | null {
  return matteTable(project)?.byClip.get(id) ?? null;
}

const NO_IDS: ReadonlySet<string> = Object.freeze(new Set<string>());
/** the counting matte clips (a frozen empty set when none) */
export function matteSourceSet(project: Project): ReadonlySet<string> {
  return matteTable(project)?.sources ?? NO_IDS;
}

const plays = (c: Clip, time: number): boolean => time >= c.start - 1e-6 && time < clipEnd(c) - 1e-6;

/** the selected matte clips playing at time on a track neither hidden nor locked, in project order. [] at once when there are none */
export function selectedMattesAt(project: Project, selection: readonly string[], time: number): VisualClip[] {
  const set = matteSourceSet(project);
  if (set.size === 0 || selection.length === 0) return [];
  const sel = new Set(selection);
  const open = new Set(project.tracks.filter((t) => !t.hidden && !t.locked).map((t) => t.id));
  const out: VisualClip[] = [];
  for (const c of project.clips) {
    if (sel.has(c.id) && set.has(c.id) && isVisualClip(c) && open.has(c.trackId) && plays(c, time)) out.push(c);
  }
  return out;
}

const EMPTY_USERS: readonly string[] = Object.freeze([]) as readonly string[];
const usersCache = new WeakMap<object, { n: number; map: Map<string, string[]> }>();
/** matte clip id -> ids of the clips whose stored matte names it, counting or not. cached per clips array */
export function matteUsersMap(clips: readonly Clip[]): ReadonlyMap<string, readonly string[]> {
  let hit = usersCache.get(clips);
  if (!hit || hit.n !== clips.length) {
    const map = new Map<string, string[]>();
    for (const c of clips) {
      const m = matteField(c);
      if (!m) continue;
      const list = map.get(m.clip);
      if (list) list.push(c.id);
      else map.set(m.clip, [c.id]);
    }
    hit = { n: clips.length, map };
    usersCache.set(clips, hit);
  }
  return hit.map;
}
export function matteUserIds(clips: readonly Clip[], id: string): readonly string[] {
  return matteUsersMap(clips).get(id) ?? EMPTY_USERS;
}

export const MATTE_TEXT = {
  notPicture: 'only a video, image, text or shape clip can have a matte',
  self: 'a clip cannot be its own matte',
  gone: 'that clip is gone',
  srcNotPicture: 'the matte must be a video, image, text or shape clip',
  srcHasMatte: 'that clip has a matte of its own: a matte clip cannot have one',
  isMatte: 'this clip is the matte of another clip: a matte clip cannot have one',
  noneAbove: 'no picture clip on a track above plays at the same time',
  sameTrack: 'the two clips are on the same track: put the matte clip on a track above',
  pickOneOrTwo: 'select one or two video, image, text or shape clips first',
  noMatte: 'the selected clips have no matte',
  noPair: 'the selected clips have no matte and are not the matte of a clip',
  trackLocked: 'the track is locked',
  splitMatte: 'this text is the matte of another clip: take the matte off first',
} as const;

/** why clipId cannot get srcId as its matte, or null. hidden tracks and solids are states, not problems */
export function matteProblem(clips: readonly Clip[], clipId: string, srcId: string): string | null {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip || !isVisualClip(clip)) return MATTE_TEXT.notPicture;
  if (srcId === clipId) return MATTE_TEXT.self;
  const src = clips.find((c) => c.id === srcId);
  if (!src) return MATTE_TEXT.gone;
  if (!isVisualClip(src)) return MATTE_TEXT.srcNotPicture;
  if (matteField(src)) return MATTE_TEXT.srcHasMatte;
  if (matteUserIds(clips, clipId).length > 0) return MATTE_TEXT.isMatte;
  return null;
}

export type MatteState = 'none' | 'on' | 'apart' | 'gone' | 'not-picture' | 'chain' | 'hidden-track' | 'on-sides';
/** what a clip's matte does now. on = counts and the two play together at some time, apart = counts but never together */
export function matteState(project: Project, clipId: string): MatteState {
  const clip = project.clips.find((c) => c.id === clipId);
  const m = matteField(clip);
  if (!clip || !m) return 'none';
  const ref = matteTable(project)?.byClip.get(clipId);
  if (ref) return clip.start < clipEnd(ref.src) - 1e-6 && ref.src.start < clipEnd(clip) - 1e-6 ? 'on' : 'apart';
  if (faceSourceSet(project).has(clipId)) return 'on-sides';
  const src = m.clip === clipId ? undefined : project.clips.find((c) => c.id === m.clip);
  if (!src) return 'gone';
  if (!isVisualClip(src)) return 'not-picture';
  if (matteField(src)) return 'chain';
  return 'hidden-track';
}

/** the line the matte section shows for a state. name is the matte clip's name, threeD the matted clip is a 3d clip */
export function matteHint(state: MatteState, mode: MatteMode, name: string, threeD: boolean): string {
  switch (state) {
    case 'none':
      return 'pick a clip: this one then shows only through it. the matte clip is not drawn on its own';
    case 'on': {
      const base =
        mode === 'alpha'
          ? `shows only inside ${name}. where ${name} does not play, this clip is hidden`
          : mode === 'alpha-inv'
            ? `shows only outside ${name}. where ${name} does not play, all of this clip shows`
            : mode === 'luma'
              ? `shows where ${name} is bright and fades where it is dark. where ${name} does not play, this clip is hidden`
              : `shows where ${name} is dark and fades where it is bright. where ${name} does not play, all of this clip shows`;
      return threeD ? `${base}. a 3d clip with a matte is drawn on its own: it does not hide behind other 3d clips` : base;
    }
    case 'apart':
      return `${name} never plays while this clip does: ${isInverted(mode) ? 'the matte does nothing' : 'this clip is hidden'}`;
    case 'gone':
      return 'the matte clip is gone: pick another one or remove the matte';
    case 'not-picture':
      return 'the matte must be a video, image, text or shape clip: pick another one';
    case 'chain':
      return `${name} has a matte of its own: a matte clip cannot have one, so this matte is off`;
    case 'hidden-track':
      return `the track of ${name} is hidden: the matte is off`;
    default:
      return 'this clip shows on a side of a solid: a matte does nothing there';
  }
}

export interface MatteEdit { id: string; matte: ClipMatte | null }

const lockedTracks = (project: Project): ReadonlySet<string> => new Set(project.tracks.filter((t) => t.locked).map((t) => t.id));

/** the picture clips of ids get srcId as their matte. skips locked tracks, clips with a problem and clips that already have it */
export function planMatteSet(project: Project, ids: readonly string[], srcId: string, mode: MatteMode = 'alpha'): MatteEdit[] {
  const want = new Set(ids);
  const locked = lockedTracks(project);
  const edits: MatteEdit[] = [];
  for (const c of project.clips) {
    if (!want.has(c.id) || !isVisualClip(c) || locked.has(c.trackId) || matteProblem(project.clips, c.id, srcId) !== null) continue;
    const m = matteField(c);
    if (m && m.clip === srcId && m.mode === mode) continue;
    edits.push({ id: c.id, matte: { clip: srcId, mode } });
  }
  return edits;
}

/** the clips of ids that have a matte get this mode. skips locked tracks and clips that already have it */
export function planMatteMode(project: Project, ids: readonly string[], mode: MatteMode): MatteEdit[] {
  const want = new Set(ids);
  const locked = lockedTracks(project);
  const edits: MatteEdit[] = [];
  for (const c of project.clips) {
    const m = matteField(c);
    if (!want.has(c.id) || !m || locked.has(c.trackId) || m.mode === mode) continue;
    edits.push({ id: c.id, matte: { clip: m.clip, mode } });
  }
  return edits;
}

/** the clips of ids that have a stored matte lose it. skips locked tracks */
export function planMatteRemove(project: Project, ids: readonly string[]): MatteEdit[] {
  const want = new Set(ids);
  const locked = lockedTracks(project);
  const edits: MatteEdit[] = [];
  for (const c of project.clips) {
    if (want.has(c.id) && isVisualClip(c) && c.matte && !locked.has(c.trackId)) edits.push({ id: c.id, matte: null });
  }
  return edits;
}

/** every clip whose stored matte names srcId loses it (the matte clip is drawn again). skips locked tracks */
export function planMatteRelease(project: Project, srcId: string): MatteEdit[] {
  const users = new Set(matteUserIds(project.clips, srcId));
  if (users.size === 0) return [];
  const locked = lockedTracks(project);
  const edits: MatteEdit[] = [];
  for (const c of project.clips) if (users.has(c.id) && !locked.has(c.trackId)) edits.push({ id: c.id, matte: null });
  return edits;
}

const overlap = (a: Clip, b: Clip): number => Math.min(clipEnd(a), clipEnd(b)) - Math.max(a.start, b.start);

/** the picture clip on the nearest video track above that plays with the clip: most overlap wins, ties the earlier start */
function nearestAbove(project: Project, clip: VisualClip): VisualClip | null {
  const at = project.tracks.findIndex((t) => t.id === clip.trackId);
  for (let i = at - 1; i >= 0; i--) {
    const track = project.tracks[i]!;
    if (track.kind !== 'video' || track.hidden) continue;
    let best: VisualClip | null = null;
    let bestOver = 0;
    for (const c of project.clips) {
      if (c.trackId !== track.id || !isVisualClip(c)) continue;
      const o = overlap(c, clip);
      if (o <= 1e-6 || matteProblem(project.clips, clip.id, c.id) !== null) continue;
      if (!best || o > bestOver + 1e-9 || (Math.abs(o - bestOver) <= 1e-9 && c.start < best.start)) {
        best = c;
        bestOver = o;
      }
    }
    if (best) return best;
  }
  return null;
}

/** "use the clip above": one or two selected picture clips. two: the one on the higher track is the matte of the other. a stop says why not */
export function planMatteAbove(project: Project, ids: readonly string[]): { edits: MatteEdit[] } | { stop: string } {
  const want = new Set(ids);
  const picks = project.clips.filter((c): c is VisualClip => want.has(c.id) && isVisualClip(c));
  if (picks.length === 0 || picks.length > 2) return { stop: MATTE_TEXT.pickOneOrTwo };
  let matted: VisualClip;
  let src: VisualClip | null;
  if (picks.length === 2) {
    const [x, y] = picks as [VisualClip, VisualClip];
    if (x.trackId === y.trackId) return { stop: MATTE_TEXT.sameTrack };
    const xi = project.tracks.findIndex((t) => t.id === x.trackId);
    const yi = project.tracks.findIndex((t) => t.id === y.trackId);
    // the lower index is drawn on top: that clip is the matte
    [src, matted] = xi < yi ? [x, y] : [y, x];
  } else {
    matted = picks[0]!;
    src = nearestAbove(project, matted);
    if (!src) return { stop: MATTE_TEXT.noneAbove };
  }
  if (lockedTracks(project).has(matted.trackId)) return { stop: MATTE_TEXT.trackLocked };
  const problem = matteProblem(project.clips, matted.id, src.id);
  if (problem) return { stop: problem };
  return { edits: [{ id: matted.id, matte: { clip: src.id, mode: matteField(matted)?.mode ?? 'alpha' } }] };
}

/** the matte clips of the selected clips and the clips the selected matte clips cut, in project order, none of the selected */
export function matteSelectIds(project: Project, ids: readonly string[]): string[] {
  const sel = new Set(ids);
  const out = new Set<string>();
  for (const c of project.clips) {
    if (!sel.has(c.id)) continue;
    const m = matteField(c);
    if (m) out.add(m.clip);
    for (const u of matteUserIds(project.clips, c.id)) out.add(u);
  }
  return project.clips.filter((c) => out.has(c.id) && !sel.has(c.id)).map((c) => c.id);
}

/** the other side of each stored pair that touches the selection */
export function matteLinkedIds(clips: readonly Clip[], selection: readonly string[]): Set<string> {
  const sel = new Set(selection);
  const out = new Set<string>();
  if (sel.size === 0) return out;
  for (const c of clips) {
    const m = matteField(c);
    if (!m) continue;
    if (sel.has(c.id)) out.add(m.clip);
    if (sel.has(m.clip)) out.add(c.id);
  }
  return out;
}

/** the other side of each stored pair that touches the hovered clip */
export function matteHoverIds(clips: readonly Clip[], hoveredId: string | null | undefined): Set<string> {
  return hoveredId ? matteLinkedIds(clips, [hoveredId]) : new Set<string>();
}

/** the luma pass: brightness to see-through. private, not in the registry, never saved */
export const MATTE_LUMA_DEF: EffectDef = {
  id: 'matte-luma',
  name: 'matte luma',
  category: 'color',
  alpha: 'own',
  description: 'brightness to see-through, for a luma matte',
  params: [],
  // the alpha build: tex() is premultiplied, so this is brightness times coverage. only the alpha is used
  glsl: 'vec4 effect(vec2 uv) { vec4 c = tex(uv); return vec4(0.0, 0.0, 0.0, luma(c.rgb)); }',
};
export const MATTE_LUMA_PASS: EffectPass = { def: MATTE_LUMA_DEF, time: 0, duration: 1, amount: 1, seed: 0, params: {} };
