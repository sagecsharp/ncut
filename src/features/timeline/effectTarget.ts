/**
 * effects that are put on one clip (EffectClip.target): pure helpers for the labels, the quiet link
 * marks, the alt drop of an effect on a clip and the menu entries. no store access, so it can be tested.
 */
import type { Clip, EffectClip, Track, VisualClip } from '../../types';
import { isVisualClip } from '../../types';
import { clipEnd, isRangeFree } from '../../lib/timelineOps';

type Scope = { clips: Clip[]; tracks: readonly Track[] };

/** the name a clip shows in the timeline */
export function clipDisplayName(clip: Clip): string {
  if (clip.type === 'text') return clip.text.replace(/\s+/g, ' ');
  if (clip.type === 'shape') return clip.name || clip.kind;
  return clip.name;
}

/** the id an effect clip is put on, or null for a normal adjustment layer (and for every other clip) */
export function targetIdOf(clip: Clip): string | null {
  return clip.type === 'effect' && clip.target ? clip.target : null;
}

/** the name of the clip with this id, or null when there is no such clip */
export function targetNameById(clips: readonly Clip[] | undefined, id: string): string | null {
  const c = clips?.find((x) => x.id === id);
  return c ? clipDisplayName(c) : null;
}

/** "<effect name> on <clip name>", or "on a missing clip" when the id is unknown */
export function effectOnLabel(effectName: string, targetName: string | null): string {
  return `${effectName} on ${targetName ?? 'a missing clip'}`;
}

/** the effect clips that point at a clip */
export function effectsOn(clips: readonly Clip[], id: string): EffectClip[] {
  const out: EffectClip[] = [];
  for (const c of clips) if (c.type === 'effect' && c.target === id) out.push(c);
  return out;
}

/**
 * ids to mark quietly for a selection: the target of every selected effect that has one, and the
 * effects that point at a selected visual clip. empty (and cheap) when no effect has a target.
 */
export function linkedIds(clips: readonly Clip[], selection: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (selection.length === 0) return out;
  const targeted: EffectClip[] = [];
  for (const c of clips) if (c.type === 'effect' && c.target) targeted.push(c);
  if (targeted.length === 0) return out;
  const sel = new Set(selection);
  const byId = new Map(clips.map((c) => [c.id, c]));
  for (const e of targeted) {
    const t = e.target ? byId.get(e.target) : undefined;
    if (!t) continue;
    if (sel.has(e.id) && isVisualClip(t)) out.add(t.id);
    if (sel.has(t.id) && isVisualClip(t)) out.add(e.id);
  }
  return out;
}

/** hovering an effect clip with a target marks that target (when it exists) */
export function hoverLinkedIds(clips: readonly Clip[], hoveredId: string | null): Set<string> {
  const out = new Set<string>();
  if (!hoveredId) return out;
  const c = clips.find((x) => x.id === hoveredId);
  const t = c ? targetIdOf(c) : null;
  if (t && clips.some((x) => x.id === t)) out.add(t);
  return out;
}

/**
 * the visual clip under `time` on `trackId` that an effect dropped with alt would go on, or null
 * (locked or unknown track, no visual clip there).
 */
export function effectDropTarget(project: Scope, trackId: string | undefined, time: number): VisualClip | null {
  if (!trackId) return null;
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || track.locked || track.kind !== 'video') return null;
  for (const c of project.clips) {
    if (c.trackId !== trackId || !isVisualClip(c)) continue;
    if (time >= c.start && time < clipEnd(c)) return c;
  }
  return null;
}

/**
 * an existing video track above the target's track that can hold the effect: unlocked, shown, free for the
 * range, and made of effects only (an empty one counts when it is named "effects"). null = make a new track.
 */
export function pickEffectTrack(project: Scope, targetTrackId: string, start: number, duration: number): string | null {
  const at = project.tracks.findIndex((t) => t.id === targetTrackId);
  for (let i = at - 1; i >= 0; i--) {
    const t = project.tracks[i]!;
    // an effect on a hidden track never runs
    if (t.kind !== 'video' || t.locked || t.hidden) continue;
    const mine = project.clips.filter((c) => c.trackId === t.id);
    const ok = mine.length === 0 ? t.name === 'effects' : mine.every((c) => c.type === 'effect');
    if (ok && isRangeFree(project, t.id, start, duration)) return t.id;
  }
  return null;
}
