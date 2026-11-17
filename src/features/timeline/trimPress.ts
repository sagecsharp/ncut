/**
 * what a press on a clip means in trim mode (trim 4.2). pure: the zone under the pointer and the modifier keys go in,
 * the trim to run (or null for today's behaviour) comes out, with its pointer shape and its hint.
 */
import { isTimedClip } from '../../types';
import type { Clip } from '../../types';
import { touchingAfter, touchingBefore } from './trimModes';
import type { Edge, P, TrimMode, TrimStop } from './trimModes';
import { trimStopText } from './trimText';

export type PressZone = 'start' | 'end' | 'body' | 'band';
export interface PressMods { ctrl: boolean; shift: boolean; alt: boolean } // ctrl = ctrl or meta
export type TrimCursor = 'ripple-start' | 'ripple-end' | 'move-edit' | 'slip' | 'slide' | 'stretch-start' | 'stretch-end' | 'blocked';
export interface TrimPress {
  mode: TrimMode | 'move'; clipId: string;
  edge: Edge | null;                  // ripple / stretch: the edge; move-edit: the side pressed
  leftId?: string; rightId?: string;  // move-edit
  alone: boolean; blocked: TrimStop | null; cursor: TrimCursor | null; hint: string;
}

const MODE_LABEL: Record<TrimMode, string> = {
  'ripple': 'ripple trim',
  'move-edit': 'move the edit',
  'slip': 'slip',
  'slide': 'slide',
  'stretch': 'stretch',
};

export function modeLabel(mode: TrimMode): string {
  return MODE_LABEL[mode];
}

function cursorOf(mode: TrimPress['mode'], edge: Edge | null): TrimCursor | null {
  if (mode === 'ripple') return edge === 'start' ? 'ripple-start' : 'ripple-end';
  if (mode === 'stretch') return edge === 'start' ? 'stretch-start' : 'stretch-end';
  if (mode === 'move-edit') return 'move-edit';
  if (mode === 'slip') return 'slip';
  if (mode === 'slide') return 'slide';
  return null;
}

/** null: today's behaviour */
export function trimPress(p: P, clipId: string, zone: PressZone, mods: PressMods, trimMode: boolean): TrimPress | null {
  const clip = p.clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const locked = p.tracks.some((t) => t.id === clip.trackId && t.locked);
  const edgeZone = zone === 'start' || zone === 'end';
  if (!trimMode && !(mods.ctrl && edgeZone)) return null;

  const make = (mode: TrimPress['mode'], edge: Edge | null, alone: boolean, hint: string, ids: { leftId?: string; rightId?: string } = {}, stop: TrimStop | null = null): TrimPress => {
    const blocked: TrimStop | null = mode !== 'move' && locked ? { why: 'locked', clipId } : stop;
    return {
      mode, clipId, edge, ...ids, alone,
      blocked,
      cursor: blocked ? 'blocked' : cursorOf(mode, edge),
      hint: blocked ? trimStopText(blocked, p) : hint,
    };
  };

  // outside trim mode only ctrl on an edge answers
  if (!trimMode) return make('ripple', zone as Edge, mods.alt, 'ripple trim');

  if (zone === 'band') {
    const left = touchingBefore(p, clip);
    if (left) return make('move-edit', 'start', mods.alt, 'move the edit', { leftId: left.id, rightId: clipId });
    return bodyPress(mods, make, clip);
  }

  if (edgeZone) {
    const edge = zone as Edge;
    const other = edge === 'end' ? touchingAfter(p, clip) : touchingBefore(p, clip);
    if (other && !mods.ctrl && !mods.shift) {
      const ids = edge === 'end' ? { leftId: clipId, rightId: other.id } : { leftId: other.id, rightId: clipId };
      return make('move-edit', edge, mods.alt, mods.alt ? 'move the edit, only these two clips' : 'move the edit (ctrl: ripple trim this side, shift: stretch it)', ids);
    }
    if (mods.shift) {
      const stop: TrimStop | null = isTimedClip(clip) ? null : { why: 'needs-media', clipId };
      return make('stretch', edge, mods.alt, mods.alt ? 'stretch, only this clip' : 'stretch: the speed follows the length', {}, stop);
    }
    const hint = other && mods.ctrl ? 'ripple trim this side' : mods.alt ? 'ripple trim, only this clip' : 'ripple trim (shift: stretch, alt: only this clip)';
    return make('ripple', edge, mods.alt, hint);
  }

  return bodyPress(mods, make, clip);
}

function bodyPress(
  mods: PressMods,
  make: (mode: TrimPress['mode'], edge: Edge | null, alone: boolean, hint: string) => TrimPress,
  clip: Clip,
): TrimPress | null {
  if (mods.ctrl || mods.shift) return null;
  if (mods.alt) return make('slide', null, false, 'slide (the neighbours trim to stay touching)');
  if (isTimedClip(clip)) return make('slip', null, false, 'slip (alt: slide)');
  return make('move', null, false, 'move (only video and audio clips slip, alt: slide)');
}
