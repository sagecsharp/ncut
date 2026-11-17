/** pure helpers of the preview's sound routing: what changed, and the element volume without web audio. */
import type { Project } from '../../types';

/** counters for the proof (devtools __ncut.mix.debug) */
export const mixDebug = { panChains: 0, taps: 0, reads: 0, twins: 0 };

const SOUND_KEYS = new Set(['volume', 'pan', 'muted']);

/** every key of a and b but the skipped ones is === */
function sameBut(a: object, b: object, skip: ReadonlySet<string>): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (skip.has(k)) continue;
    if (x[k] !== y[k]) return false;
  }
  return true;
}

/** a sound field really differs */
function soundDiffers(a: object, b: object): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of SOUND_KEYS) if (x[k] !== y[k]) return true;
  return false;
}

/** true when next differs from prev only in what the picture never shows: track volume, pan or muted, the output, or a video / audio clip's volume, pan or muted (keyframes untouched) */
export function soundOnlyChange(prev: Project, next: Project): boolean {
  if (prev === next) return false;
  if (!sameBut(prev, next, new Set(['tracks', 'clips', 'output']))) return false;
  if (prev.tracks.length !== next.tracks.length || prev.clips.length !== next.clips.length) return false;
  let changed = prev.output !== next.output;
  for (let i = 0; i < prev.tracks.length; i++) {
    const a = prev.tracks[i]!;
    const b = next.tracks[i]!;
    if (a === b) continue;
    if (a.id !== b.id || !sameBut(a, b, SOUND_KEYS)) return false;
    if (soundDiffers(a, b)) changed = true;
  }
  for (let i = 0; i < prev.clips.length; i++) {
    const a = prev.clips[i]!;
    const b = next.clips[i]!;
    if (a === b) continue;
    if (!((a.type === 'video' && b.type === 'video') || (a.type === 'audio' && b.type === 'audio'))) return false;
    if (!sameBut(a, b, SOUND_KEYS)) return false;
    if (soundDiffers(a, b)) changed = true;
  }
  return changed;
}

/** the element volume without web audio */
export function fallbackVolume(g: number, output: number, previewVolume: number, previewMuted: boolean): number {
  return previewMuted ? 0 : Math.min(1, Math.max(0, g * output * previewVolume));
}
