/**
 * a short text that tells two sounds apart: the same signature means the same mix, so a measure can be kept.
 * pure. a sound field this does not know about costs one more measure, never a stale one.
 */
import type { Project } from '../../types';
import { hasAsset } from '../../media/registry';
import type { TimeRange } from './range';

/** what a track has that does not touch the sound (height and sync lock are view and edit settings) */
const TRACK_DROP = new Set(['name', 'hidden', 'locked', 'height', 'syncLock', 'color']);
/** what a video or audio clip has that does not touch the sound */
const CLIP_DROP = new Set([
  'name', 'transform', 'threeD', 'lookAt', 'lookTarget', 'shape', 'shapeDepth', 'lit', 'faces', 'blend', 'crop', 'radius', 'bend',
  'motionIn', 'motionOut', 'motionLoop', 'parent', 'pivot', 'motionBlur', 'adjust', 'chromaKey', 'mask', 'grade', 'group',
]);

/** the usual 53 bit string hash, seed 0 */
function cyrb53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** a copy with the keys in order at every depth, so the same data gives the same text */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sorted((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function without(o: object, drop: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!drop.has(k)) out[k] = v;
  return out;
}

/** the heavy part of a signature (tracks and clips), kept per project: a project object is never changed, a new one is made */
const bodies = new WeakMap<Project, { hash: number; body: string; ids: string[] }>();

function bodyOf(project: Project): { hash: number; body: string; ids: string[] } {
  const kept = bodies.get(project);
  if (kept) return kept;
  const tracks = project.tracks.map((t) => sorted(without(t, TRACK_DROP)));
  const ids: string[] = [];
  const clips: unknown[] = [];
  for (const c of project.clips) {
    if (c.type !== 'video' && c.type !== 'audio') continue;
    clips.push(sorted(without(c, CLIP_DROP)));
    if (!ids.includes(c.assetId)) ids.push(c.assetId);
  }
  const body = JSON.stringify([tracks, clips]);
  const made = { hash: cyrb53(body), body, ids };
  bodies.set(project, made);
  return made;
}

export function soundSignature(project: Project, range: TimeRange, rate: number, present: (assetId: string) => boolean = hasAsset): string {
  const { hash, body, ids } = bodyOf(project);
  const media = ids.map((id) => {
    const a = project.assets.find((x) => x.id === id);
    return [id, a?.size ?? null, a?.duration ?? null, a?.hasAudio ?? null, a?.mime ?? null, present(id)];
  });
  const tail = JSON.stringify([rate, Math.round(range.start * 1e6), Math.round(range.end * 1e6), sorted(project.output ?? null), media]);
  return `${hash}.${body.length}.${cyrb53(tail)}.${tail.length}`;
}
