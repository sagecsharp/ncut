import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { isVisualClip } from '../../types';
import type { Keyframes } from '../../types';
import { pathKeys, pathProps } from './pathMoves';
import type { PathOptions } from './pathMoves';

const POSITION = ['x', 'y', 'z'];

function find(id: string) {
  const p = useEditor.getState().project;
  const clip = p?.clips.find((c) => c.id === id);
  if (!p || !clip || !isVisualClip(clip)) return null;
  if (p.tracks.find((t) => t.id === clip.trackId)?.locked) {
    useUi.getState().toast('this clip is on a locked track: unlock it to change its path');
    return null;
  }
  return { p, clip };
}

/** write a path as keyframes on the clip's position. replaces all keys of the properties it writes, one undo step. */
export function applyPath(id: string, opts: PathOptions): boolean {
  const hit = find(id);
  if (!hit) return false;
  const { p, clip } = hit;
  const next = pathKeys(clip, opts, { width: p.width, height: p.height });
  const props = Object.keys(next);
  if (props.length === 0) {
    useUi.getState().toast('this clip is too short for a path');
    return false;
  }
  const had = pathProps(clip, opts).filter((k) => (clip.keyframes?.[k]?.length ?? 0) > 0);
  // a path owns the whole position: keys an earlier path left on x / y / z that this one does not write go too
  // (a circle after a spiral must not keep climbing). they freeze at the clip's start, where every path begins
  const merged: Keyframes = { ...clip.keyframes, ...next };
  const cleared = POSITION.filter((k) => !(k in next) && (clip.keyframes?.[k]?.length ?? 0) > 0);
  for (const k of cleared) delete merged[k];
  const before = useEditor.getState().project;
  useEditor.getState().setClipKeyframes(clip.id, merged, { time: clip.start });
  if (useEditor.getState().project === before) {
    useUi.getState().toast('already on that path');
    return true;
  }
  let msg = had.length > 0 ? `path replaced the keys on ${had.join(' / ')}` : 'path added';
  if (cleared.length > 0) msg += `, the keys on ${cleared.join(' / ')} were removed`;
  useUi.getState().toast(msg);
  return true;
}

/**
 * take the path off: clears the keys of x / y / z (the angle keys of "face" stay) and the clip stays
 * where it is at its start.
 */
export function removePath(id: string): boolean {
  const hit = find(id);
  if (!hit) return false;
  const { clip } = hit;
  const kf = clip.keyframes;
  if (!kf || !POSITION.some((k) => (kf[k]?.length ?? 0) > 0)) {
    useUi.getState().toast('no position keys to remove');
    return false;
  }
  const rest: Keyframes = {};
  for (const [k, v] of Object.entries(kf)) if (!POSITION.includes(k)) rest[k] = v;
  // the store freezes a property that lost its keys at this time: local 0
  useEditor.getState().setClipKeyframes(clip.id, rest, { time: clip.start });
  useUi.getState().toast('path removed');
  return true;
}
